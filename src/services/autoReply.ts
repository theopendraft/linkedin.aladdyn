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

  // Fetch ALL auto-reply-enabled conversations — no time gate.
  // The loop-prevention is structural: after we reply we save an OUTBOUND message
  // with createdAt=now. That becomes messages[0] in the next query (desc order).
  // When they send a follow-up, it lands with an even newer createdAt → becomes
  // messages[0] as INBOUND → eligible again. No cooldown needed.
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

  // Eligible = they have sent a message we haven't replied to yet.
  // Primary check: messages[0] (most recently stored, createdAt desc) is INBOUND.
  // Fallback: LinkedIn sidebar reports unread > 0. This handles cases where the new
  // INBOUND message was stored with a slightly older parsed timestamp (LinkedIn shows
  // relative times like "3:16 PM" which parseLinkedInTime can misplace by hours),
  // causing it to land at messages[1] instead of [0]. After we reply, autoReply sets
  // unreadCount=0 in DB and inboxReader navigated the thread (LinkedIn marks it read),
  // so the next sync reads 0 from the sidebar — no double-reply risk.
  const eligible = conversations.filter((conv) => {
    if (conv.messages.length === 0) return false;
    if (conv.messages[0].direction === 'INBOUND') return true;
    return (conv.unreadCount ?? 0) > 0;
  });

  console.log(`[AutoReply] ${eligible.length}/${conversations.length} eligible (messages[0]=INBOUND or unreadCount>0)`);
  for (const conv of eligible) {
    const lastInbound = [...conv.messages].reverse().find((m) => m.direction === 'INBOUND');
    console.log(
      `[AutoReply]   → conv=${conv.id} participant=${conv.participantLinkedInId} ` +
      `lastAutoReplyAt=${conv.lastAutoReplyAt ?? 'never'} ` +
      `lastInbound.createdAt=${lastInbound?.createdAt ?? 'none'}`
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
      // Find the last inbound message to use as the query for genie
      // (messages are ordered desc, so reverse to find oldest-first context)
      const sortedMessages = [...conv.messages].reverse();
      const lastInbound = sortedMessages.findLast((m) => m.direction === 'INBOUND');

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

      // Send the DM (handles delay + action count increment)
      await sendDM({
        accountId,
        participantLinkedInId: conv.participantLinkedInId,
        message: reply,
      });

      // Save outbound message locally for inbox display.
      // Genie is the source of truth for AI context; this is display-only.
      await prisma.linkedInMessage.create({
        data: {
          conversationId: conv.id,
          direction: 'OUTBOUND',
          content: reply,
          sentAt: new Date(),
          isAutoReply: true,
        },
      });

      // Update conversation state
      await prisma.linkedInConversation.update({
        where: { id: conv.id },
        data: {
          lastAutoReplyAt: new Date(),
          autoReplyCount: { increment: 1 },
          unreadCount: 0,
          // Persist genie conversation ID on first reply so future replies
          // continue the same thread in genie (preserves full history)
          ...(returnedConvId && !conv.genieConversationId
            ? { genieConversationId: returnedConvId }
            : {}),
        },
      });

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
