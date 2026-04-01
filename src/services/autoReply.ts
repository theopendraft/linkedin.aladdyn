/**
 * Auto-Reply Service
 *
 * Reads conversations with new inbound messages, routes them through
 * genie Agent V2 (same as WhatsApp/Instagram) to generate a reply,
 * then sends via the browser session.
 *
 * Genie is the single source of truth for AI replies and conversation history.
 * linkedin.aladdyn only records the outbound message locally for inbox display.
 *
 * Hard constraints enforced:
 * - Daily action limit checked before each reply
 * - Min 30-minute cooldown between auto-replies per conversation
 * - Random 1.5–4s delay before each send (inside sendDM)
 * - Never log conversation content in production
 */

import prisma from '../lib/prisma';
import { sendDM } from './inboxReader';
import { createLogger } from '../utils/logger';

const logger = createLogger({ service: 'auto-reply' });

const MAX_HISTORY_MESSAGES = 10;

export interface AutoReplyResult {
  processed: number;
  replied: number;
  skipped: number;
}

/**
 * Processes pending auto-replies for an account.
 * Finds conversations with new INBOUND messages since the last auto-reply
 * and routes each through genie Agent V2 to generate and send a reply.
 */
export async function processAutoReplies(accountId: string): Promise<AutoReplyResult> {
  const account = await prisma.linkedInAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      funnelId: true,
      autoReplyEnabled: true,
      replySystemPrompt: true,
      dailyActionCount: true,
      dailyActionLimit: true,
      dailyActionReset: true,
      sessionValid: true,
    },
  });

  if (!account) {
    logger.warn('Account not found', { accountId });
    return { processed: 0, replied: 0, skipped: 0 };
  }

  logger.info('Account state', {
    accountId,
    autoReplyEnabled: String(account.autoReplyEnabled),
    sessionValid: String(account.sessionValid),
    dailyCount: String(account.dailyActionCount),
    dailyLimit: String(account.dailyActionLimit),
  });

  if (!account.autoReplyEnabled) {
    logger.info('Auto-reply disabled', { accountId });
    return { processed: 0, replied: 0, skipped: 0 };
  }

  if (!account.sessionValid) {
    logger.warn('No valid session', { accountId });
    return { processed: 0, replied: 0, skipped: 0 };
  }

  if (!account.funnelId) {
    logger.warn('No funnelId configured — genie cannot reply', { accountId });
    return { processed: 0, replied: 0, skipped: 0 };
  }

  // Reset daily counter if stale
  const now = new Date();
  if (!account.dailyActionReset || account.dailyActionReset < now) {
    await prisma.linkedInAccount.update({
      where: { id: accountId },
      data: {
        dailyActionCount: 0,
        dailyActionReset: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      },
    });
    account.dailyActionCount = 0;
  }

  if (account.dailyActionCount >= account.dailyActionLimit) {
    logger.info('Daily limit reached', { accountId, count: String(account.dailyActionCount), limit: String(account.dailyActionLimit) });
    return { processed: 0, replied: 0, skipped: 0 };
  }

  // Fetch ALL auto-reply-enabled conversations.
  // The loop-prevention is structural: after we reply we save an OUTBOUND message
  // with createdAt=now BEFORE calling sendDM. That becomes messages[0] in the next
  // query (desc order). When they send a follow-up, it lands with an even newer
  // createdAt → becomes messages[0] as INBOUND → eligible again.
  // A secondary 90-second cooldown on lastAutoReplyAt guards against rapid
  // double-sends between sync cycles.
  const conversations = await prisma.linkedInConversation.findMany({
    where: { accountId, autoReplyEnabled: true },
    select: {
      id: true,
      participantLinkedInId: true,
      genieConversationId: true,
      lastAutoReplyAt: true,
      autoReplyCount: true,
      unreadCount: true,
      messages: {
        orderBy: { createdAt: 'desc' },
        take: MAX_HISTORY_MESSAGES,
      },
    },
    orderBy: { lastMessageAt: 'desc' },
  });

  logger.info('Conversations with autoReplyEnabled', { accountId, count: String(conversations.length) });
  for (const conv of conversations) {
    const dirs = conv.messages.map((m) => m.direction).join(',');
    logger.debug('Conversation state', { convId: conv.id, participant: conv.participantLinkedInId, msgCount: String(conv.messages.length), directions: dirs, unreadCount: String(conv.unreadCount) });
  }

  // Eligible = most recently stored message is INBOUND.
  //
  // count-based dedup (inboxReader) inserts every new INBOUND with createdAt=now(),
  // so the newest message in DB is always the most recently received one.
  // After we reply, the OUTBOUND is stored with createdAt=now() > any prior INBOUND,
  // so messages[0] flips back to OUTBOUND and the conversation becomes ineligible.
  // When they send a new message it's inserted with a fresh createdAt > our OUTBOUND
  // → messages[0] is INBOUND again → eligible.
  //
  // Secondary guard: if lastAutoReplyAt is within the last 90 seconds, skip.
  // This prevents a double-send if processAutoReplies is somehow called twice
  // in rapid succession before the next syncInbox has a chance to flip
  // messages[0] back to OUTBOUND via the next DOM scrape.
  // 5 minutes — well above the ~60s scheduler interval so a queued-but-not-yet-processed
  // job can never slip through after the previous reply was sent.
  const REPLY_COOLDOWN_MS = 300_000; // 5 minutes
  const eligible = conversations.filter((conv) => {
    if (conv.messages.length === 0) return false;
    if (conv.messages[0].direction !== 'INBOUND') return false;
    // Cooldown guard: if we replied very recently, the next sync hasn't run
    // yet to confirm the OUTBOUND landed in DOM — hold off briefly.
    if (conv.lastAutoReplyAt) {
      const msSinceReply = Date.now() - new Date(conv.lastAutoReplyAt).getTime();
      if (msSinceReply < REPLY_COOLDOWN_MS) {
        logger.debug('Skipped — cooldown active', { convId: conv.id, msSinceReply: String(Math.round(msSinceReply / 1000)), cooldownSec: String(REPLY_COOLDOWN_MS / 1000) });
        return false;
      }
    }
    return true;
  });

  logger.info('Eligible conversations', { accountId, eligible: String(eligible.length), total: String(conversations.length) });
  for (const conv of eligible) {
    const newestInbound = conv.messages.find((m) => m.direction === 'INBOUND');
    logger.debug('Eligible conversation', { convId: conv.id, participant: conv.participantLinkedInId, lastAutoReplyAt: conv.lastAutoReplyAt?.toISOString() ?? 'never', newestInboundAt: newestInbound?.createdAt?.toISOString() ?? 'none' });
  }

  let replied = 0;
  let skipped = 0;

  for (const conv of eligible) {
    // Re-check limit inside loop (updated by each sendDM call)
    const freshAccount = await prisma.linkedInAccount.findUnique({
      where: { id: accountId },
      select: { dailyActionCount: true, dailyActionLimit: true },
    });

    if (!freshAccount || freshAccount.dailyActionCount >= freshAccount.dailyActionLimit) {
      logger.info('Daily limit reached mid-loop', { accountId });
      skipped += eligible.length - replied - skipped;
      break;
    }

    try {
      // Fetch the actual latest INBOUND from DB — do not rely on conv.messages
      // which is capped at MAX_HISTORY_MESSAGES. If accumulated OUTBOUND replies
      // pushed the real latest INBOUND out of that window, we'd send genie an old
      // stale message as the query, producing repeated identical replies.
      const lastInbound = await prisma.linkedInMessage.findFirst({
        where: { conversationId: conv.id, direction: 'INBOUND' },
        orderBy: { createdAt: 'desc' },
      });

      if (!lastInbound) {
        skipped++;
        continue;
      }

      // Pre-reply classifier: skip system notifications and cold-outreach spam
      // that don't warrant a business response.
      const hasCustomPrompt = Boolean(account.replySystemPrompt?.trim());
      if (shouldSkipMessage(lastInbound.content, hasCustomPrompt)) {
        logger.info('[SKIP] Message classified as non-actionable', {
          convId: conv.id,
          participant: conv.participantLinkedInId,
          preview: lastInbound.content.slice(0, 80),
        });
        skipped++;
        continue;
      }

      // Route through genie Agent V2 — same path as WhatsApp / Instagram.
      // Genie manages conversation history via conversationId; we don't need
      // to pass the full message history manually.
      const { reply, conversationId: returnedConvId } = await generateReplyViaGenie({
        query: lastInbound.content,
        funnelId: account.funnelId,
        senderId: conv.participantLinkedInId,
        genieConversationId: conv.genieConversationId ?? undefined,
        extraInstructions: account.replySystemPrompt ?? undefined,
      });

      // ── Save OUTBOUND to DB BEFORE sending ───────────────────────────────────
      // Race condition prevention: if we send first then the DB write crashes,
      // the OUTBOUND never enters DB → messages[0] stays INBOUND → next cycle
      // re-triggers another send → duplicate messages.
      //
      // By saving first, the OUTBOUND is in DB regardless of what happens to
      // sendDM. If sendDM then fails (network error, LinkedIn rejects it), we
      // delete the optimistic OUTBOUND so the conversation stays eligible for
      // retry on the next cycle. If sendDM succeeds, the OUTBOUND stays and
      // messages[0] flips to OUTBOUND → ineligible until new INBOUND arrives.
      const savedOutbound = await prisma.linkedInMessage.create({
        data: {
          conversationId: conv.id,
          direction: 'OUTBOUND',
          content: reply,
          sentAt: new Date(),
          isAutoReply: true,
        },
      });

      // Mark conversation as replied-to immediately so the next processAutoReplies
      // call (if triggered before the next sync) sees it as ineligible.
      await prisma.linkedInConversation.update({
        where: { id: conv.id },
        data: {
          lastAutoReplyAt: new Date(),
          autoReplyCount: { increment: 1 },
          unreadCount: 0,
          ...(returnedConvId ? { genieConversationId: returnedConvId } : {}),
        },
      });

      // Now send the actual DM. If this fails, roll back the OUTBOUND so the
      // conversation remains eligible for retry on the next sync cycle.
      try {
        await sendDM({
          accountId,
          participantLinkedInId: conv.participantLinkedInId,
          message: reply,
        });
      } catch (sendErr) {
        // sendDM failed — remove the optimistic OUTBOUND so the conversation
        // stays eligible for retry. The next sync will try again.
        await prisma.linkedInMessage.delete({
          where: { id: savedOutbound.id },
        }).catch(() => {});
        // Also roll back the conversation state so it can be re-processed
        await prisma.linkedInConversation.update({
          where: { id: conv.id },
          data: { lastAutoReplyAt: conv.lastAutoReplyAt, unreadCount: conv.unreadCount },
        }).catch(() => {});
        throw sendErr;
      }

      replied++;
      logger.info('Replied to conversation', { convId: conv.id, participant: conv.participantLinkedInId, ...(returnedConvId ? { genieConvId: returnedConvId } : {}) });
    } catch (err) {
      logger.error('Failed to reply to conversation', { convId: conv.id, error: err instanceof Error ? err.message : String(err) });
      skipped++;
    }
  }

  return {
    processed: eligible.length,
    replied,
    skipped: skipped + Math.max(0, eligible.length - replied - skipped),
  };
}

/**
 * Returns true when the message should be silently skipped (no reply sent).
 *
 * Covers LinkedIn system notifications and obvious cold-outreach / spam patterns
 * that don't warrant a business reply. When the account has a custom
 * replySystemPrompt configured, the length check is bypassed so genie can
 * handle short greetings per the user's own instructions.
 */
function shouldSkipMessage(content: string, hasCustomPrompt: boolean): boolean {
  const text = content.trim();

  // LinkedIn system / milestone notifications
  if (/accepted your invitation|connected with you/i.test(text)) return true;
  if (/^congratulations/i.test(text)) return true;

  // Obvious cold-outreach / promotional patterns
  if (
    /i came across your profile|i'd love to connect|let me know if you('re| are) interested|quick question — |quick question:|we help (companies|businesses|startups)/i.test(
      text
    )
  )
    return true;

  // Very short messages (≤3 chars, e.g. "Hi", emoji-only) — skip only when
  // the user hasn't set custom instructions. If they have, trust genie to handle
  // greetings per those instructions.
  if (!hasCustomPrompt && text.length <= 3) return true;

  return false;
}

/**
 * Generates a reply via genie Agent V2.
 *
 * Genie is the single AI source — same endpoint used by WhatsApp and Instagram.
 * Conversation history is maintained by genie via conversationId; no manual
 * history stitching needed here.
 *
 * Throws if genie is unreachable or returns an empty reply — no fallback.
 */
async function generateReplyViaGenie(params: {
  query: string;
  funnelId: string;
  senderId: string;
  genieConversationId?: string;
  extraInstructions?: string;
}): Promise<{ reply: string; conversationId?: string }> {
  const { query, funnelId, senderId, genieConversationId, extraInstructions } = params;

  const serverApiUrl = process.env.SERVER_API_URL;
  if (!serverApiUrl) {
    throw new Error('[AutoReply] SERVER_API_URL is not configured');
  }

  const res = await fetch(`${serverApiUrl}/api/agent/v2/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      funnelId,
      platform: 'linkedin',
      senderId,
      ...(genieConversationId ? { conversationId: genieConversationId } : {}),
      ...(extraInstructions ? { extraInstructions } : {}),
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`[AutoReply] Genie API returned ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as {
    response?: string;
    message?: string;
    reply?: string;
    conversationId?: string;
  };

  const reply = data.response ?? data.message ?? data.reply;

  if (!reply?.trim()) {
    throw new Error('[AutoReply] Genie returned an empty reply');
  }

  return { reply: reply.trim(), conversationId: data.conversationId };
}
