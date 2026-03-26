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
      dailyActionCount: true,
      dailyActionLimit: true,
      dailyActionReset: true,
      sessionValid: true,
    },
  });

  if (!account) {
    console.warn(`[AutoReply] Account ${accountId} not found`);
    return { processed: 0, replied: 0, skipped: 0 };
  }

  console.log(
    `[AutoReply] Account state: autoReplyEnabled=${account.autoReplyEnabled} ` +
    `sessionValid=${account.sessionValid} dailyCount=${account.dailyActionCount}/${account.dailyActionLimit}`
  );

  if (!account.autoReplyEnabled) {
    console.log(`[AutoReply] Auto-reply disabled for account ${accountId}`);
    return { processed: 0, replied: 0, skipped: 0 };
  }

  if (!account.sessionValid) {
    console.warn(`[AutoReply] No valid session for account ${accountId}`);
    return { processed: 0, replied: 0, skipped: 0 };
  }

  if (!account.funnelId) {
    console.warn(`[AutoReply] No funnelId configured for account ${accountId} — genie cannot reply`);
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
    console.log(
      `[AutoReply] Daily limit reached for account ${accountId} (${account.dailyActionCount}/${account.dailyActionLimit})`
    );
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

  console.log(`[AutoReply] ${conversations.length} conversation(s) with autoReplyEnabled=true`);
  for (const conv of conversations) {
    const dirs = conv.messages.map((m) => m.direction).join(',');
    console.log(
      `[AutoReply]   conv=${conv.id} participant=${conv.participantLinkedInId} ` +
      `msgs=${conv.messages.length} directions=[${dirs}] unreadCount=${conv.unreadCount}`
    );
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
  const REPLY_COOLDOWN_MS = 90_000; // 90 seconds
  const eligible = conversations.filter((conv) => {
    if (conv.messages.length === 0) return false;
    if (conv.messages[0].direction !== 'INBOUND') return false;
    // Cooldown guard: if we replied very recently, the next sync hasn't run
    // yet to confirm the OUTBOUND landed in DOM — hold off briefly.
    if (conv.lastAutoReplyAt) {
      const msSinceReply = Date.now() - new Date(conv.lastAutoReplyAt).getTime();
      if (msSinceReply < REPLY_COOLDOWN_MS) {
        console.log(
          `[AutoReply]   conv=${conv.id} skipped — replied ${Math.round(msSinceReply / 1000)}s ago (cooldown ${REPLY_COOLDOWN_MS / 1000}s)`
        );
        return false;
      }
    }
    return true;
  });

  console.log(`[AutoReply] ${eligible.length}/${conversations.length} eligible (messages[0]=INBOUND)`);
  for (const conv of eligible) {
    const newestInbound = conv.messages.find((m) => m.direction === 'INBOUND');
    console.log(
      `[AutoReply]   → conv=${conv.id} participant=${conv.participantLinkedInId} ` +
      `lastAutoReplyAt=${conv.lastAutoReplyAt ?? 'never'} ` +
      `newestInbound.createdAt=${newestInbound?.createdAt ?? 'none'}`
    );
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
      console.log(`[AutoReply] Daily limit reached mid-loop for account ${accountId}`);
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

      // Route through genie Agent V2 — same path as WhatsApp / Instagram.
      // Genie manages conversation history via conversationId; we don't need
      // to pass the full message history manually.
      const { reply, conversationId: returnedConvId } = await generateReplyViaGenie({
        query: lastInbound.content,
        funnelId: account.funnelId,
        senderId: conv.participantLinkedInId,
        genieConversationId: conv.genieConversationId ?? undefined,
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
      console.log(
        `[AutoReply] Replied to conversation ${conv.id} (participant=${conv.participantLinkedInId})` +
        (returnedConvId ? ` genieConvId=${returnedConvId}` : '')
      );
    } catch (err) {
      console.error(
        `[AutoReply] Failed to reply to conversation ${conv.id}:`,
        err instanceof Error ? err.message : String(err)
      );
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
}): Promise<{ reply: string; conversationId?: string }> {
  const { query, funnelId, senderId, genieConversationId } = params;

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
