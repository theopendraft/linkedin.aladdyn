/**
 * Inbox Reader Service
 *
 * Reads LinkedIn inbox using Playwright DOM scraping.
 * Navigates to linkedin.com/messaging and reads conversations + messages
 * directly from the rendered DOM — no API interception needed.
 *
 * Also handles sending DMs by typing into the message input.
 *
 * Hard constraints:
 * - Daily action limit checked before every send
 * - randomDelay() before every automated action
 * - Never log message content or cookie values
 */

import prisma from '../lib/prisma';
import { withSession, randomDelay } from './browserPool';

export interface ConversationData {
  linkedinConversationId: string;
  participantLinkedInId: string;
  participantName: string;
  participantHeadline: string;
  participantProfileUrl: string;
  lastMessageAt: Date | null;
  lastMessageSnippet: string;
  unreadCount: number;
  messages: MessageData[];
}

export interface MessageData {
  direction: 'INBOUND' | 'OUTBOUND';
  content: string;
  sentAt: Date;
}

export interface SyncResult {
  conversations: ConversationData[];
  newMessages: number;      // messages newly inserted into DB this cycle
  pendingReplies: number;   // conversations with INBOUND msgs since lastAutoReplyAt
}

/**
 * Syncs the LinkedIn inbox for an account.
 * Navigates to linkedin.com/messaging, reads conversations from the sidebar
 * and messages from the open thread DOM.
 */
export async function syncInbox(accountId: string): Promise<SyncResult> {
  const account = await prisma.linkedInAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      linkedinId: true,
      sessionCookies: true,
      sessionValid: true,
      autoReplyEnabled: true,
    },
  });

  if (!account || !account.sessionCookies || !account.sessionValid) {
    console.warn(`[InboxReader] No valid session for account ${accountId}`);
    return { conversations: [], newMessages: 0 };
  }

  let totalNewMessages = 0;
  let conversations: ConversationData[] = [];

  try {
    conversations = await withSession(
      accountId,
      account.sessionCookies,
      async (session) => {
        const { page } = session;

        await randomDelay(1500, 3000);
        // Use 'load' (not 'domcontentloaded') so LinkedIn's XHR calls that
        // populate the conversation list finish before we read the DOM.
        await page.goto('https://www.linkedin.com/messaging/', {
          waitUntil: 'load',
          timeout: 30000,
        });

        // Wait for the conversation list or the messaging UI to appear
        try {
          await page.waitForSelector(
            '.msg-conversation-listitem, .msg-conversations-container, .msg-s-message-list-container',
            { timeout: 15000 }
          );
        } catch {
          // Might just be slow — continue anyway
        }

        await randomDelay(2000, 4000);

        // Check for session expiry
        const currentUrl = page.url();
        if (
          currentUrl.includes('/login') ||
          currentUrl.includes('/checkpoint') ||
          currentUrl.includes('/authwall')
        ) {
          console.warn(
            `[InboxReader] Session expired for account ${accountId} — redirected to ${currentUrl}`
          );
          await prisma.linkedInAccount.update({
            where: { id: accountId },
            data: { sessionValid: false },
          });
          return [];
        }

        // ─── Read sidebar conversation list ──────────────────────────

        const convItems = await page.$$('.msg-conversation-listitem');
        console.log(
          `[InboxReader] Found ${convItems.length} conversations in sidebar`
        );

        const sidebarData = await page.$$eval(
          '.msg-conversation-listitem',
          (nodes) =>
            nodes.map((node) => {
              const nameEl = node.querySelector(
                '.msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names'
              );
              const snippetEl = node.querySelector(
                '.msg-conversation-card__message-snippet'
              );
              const timeEl = node.querySelector(
                '.msg-conversation-card__time-stamp, .msg-conversation-listitem__time-stamp'
              );
              const linkEl = node.querySelector('a');
              const href = linkEl?.getAttribute('href') ?? '';
              const isActive =
                node.classList.contains('active') ||
                !!node.querySelector(
                  '.msg-conversations-container__convo-item-link--active'
                );
              // Unread = has bold text or unread indicator
              const hasUnread =
                !!node.querySelector('.msg-conversation-listitem__active-text') ||
                node.querySelector('.msg-conversation-card__message-snippet-container')
                  ?.classList.contains('font-weight-600') === true;

              return {
                name: nameEl?.textContent?.trim() ?? '',
                snippet: snippetEl?.textContent?.trim() ?? '',
                time: timeEl?.textContent?.trim() ?? '',
                href,
                isActive,
                hasUnread,
              };
            })
        );

        // ─── Read messages from currently open thread ────────────────

        const results: ConversationData[] = [];

        // Process each conversation — click into it and read messages
        for (let i = 0; i < sidebarData.length; i++) {
          const sidebar = sidebarData[i];
          if (!sidebar.name) continue;

          // Extract thread ID from href
          const threadMatch = sidebar.href.match(
            /messaging\/thread\/([^/?]+)/
          );
          const threadId = threadMatch?.[1] ?? '';

          // Navigate directly to the thread URL to guarantee fresh messages.
          // Clicking from the sidebar or relying on the already-open conversation
          // can serve LinkedIn's cached SPA state — new messages may not appear.
          // Direct navigation forces LinkedIn to fetch the latest thread data from API.
          if (threadId) {
            try {
              await page.goto(
                `https://www.linkedin.com/messaging/thread/${threadId}/`,
                { waitUntil: 'domcontentloaded', timeout: 20000 }
              );
            } catch {
              console.warn(`[InboxReader] Failed to navigate to thread ${threadId}, skipping`);
              continue;
            }
          } else if (i > 0 || !sidebar.isActive) {
            // No threadId — fall back to sidebar click
            const item = convItems[i];
            if (item) {
              try {
                await item.click();
              } catch {
                console.warn(`[InboxReader] Could not click into conversation ${i}`);
                continue;
              }
            }
          }

          // Wait for at least one message to appear, then let the rest load
          await page.waitForSelector('.msg-s-event-listitem', { timeout: 10000 }).catch(() => {});
          await randomDelay(1200, 2500);

          // Read participant info from thread header
          const participantName = await page
            .$eval(
              '.msg-entity-lockup__entity-title',
              (el) => el.textContent?.trim() ?? ''
            )
            .catch(() => sidebar.name);

          // Read participant profile URL from thread header link
          const profileUrl = await page
            .$eval('.msg-thread__link-to-profile', (el) =>
              el.getAttribute('href')?.split('?')[0] ?? ''
            )
            .catch(() => '');

          // Extract public ID from profile URL: /in/john-doe → john-doe
          const publicIdMatch = profileUrl.match(/\/in\/([^/?]+)/);
          const participantPublicId = publicIdMatch?.[1] ?? sidebar.name.toLowerCase().replace(/\s+/g, '-');

          // Read ALL messages from the open thread
          const messages = await page.$$eval(
            '.msg-s-event-listitem',
            (nodes) => {
              return nodes
                .map((node) => {
                  // Direction: "other" class = INBOUND, otherwise OUTBOUND
                  const isOther =
                    node.classList.contains('msg-s-event-listitem--other');

                  // Message text — try multiple selectors
                  const bodyEl =
                    node.querySelector('.msg-s-event-listitem__body') ??
                    node.querySelector(
                      '.msg-s-event-listitem__message-bubble'
                    );
                  const content = bodyEl?.textContent?.trim() ?? '';

                  // Timestamp — look in the message group header
                  const groupMeta = node
                    .closest('.msg-s-message-list__event')
                    ?.querySelector('.msg-s-message-group__timestamp');
                  const timeText = groupMeta?.textContent?.trim() ?? '';

                  return {
                    direction: isOther ? 'INBOUND' : 'OUTBOUND',
                    content,
                    timeText,
                  };
                })
                .filter((m) => m.content.length > 0);
            }
          );

          // Convert time strings to approximate dates
          const now = new Date();
          const parsedMessages: MessageData[] = messages.map((m) => ({
            direction: m.direction as 'INBOUND' | 'OUTBOUND',
            content: m.content,
            sentAt: parseLinkedInTime(m.timeText, now),
          }));

          results.push({
            linkedinConversationId: threadId,
            participantLinkedInId: participantPublicId,
            participantName: participantName || sidebar.name,
            participantHeadline: '',
            participantProfileUrl: profileUrl
              ? `https://www.linkedin.com${profileUrl}`
              : '',
            lastMessageAt:
              parsedMessages.length > 0
                ? parsedMessages[parsedMessages.length - 1].sentAt
                : null,
            lastMessageSnippet: sidebar.snippet,
            unreadCount: sidebar.hasUnread ? 1 : 0,
            messages: parsedMessages,
          });

          console.log(
            `[InboxReader] Read ${parsedMessages.length} messages from conversation with ${participantName || sidebar.name}`
          );
        }

        return results;
      }
    );
  } catch (err) {
    console.error(
      `[InboxReader] Sync failed for account ${accountId}:`,
      err instanceof Error ? err.message : String(err)
    );
    return { conversations: [], newMessages: 0 };
  }

  // ─── Upsert conversations and messages into DB ───────────────────

  for (const conv of conversations) {
    if (!conv.participantLinkedInId) continue;

    // Check for stale conversation with a different participantLinkedInId
    // (e.g., old URN-based ID vs new DOM-extracted public ID).
    const existingByName = await prisma.linkedInConversation.findFirst({
      where: {
        accountId,
        participantName: conv.participantName,
        participantLinkedInId: { not: conv.participantLinkedInId },
      },
    });

    if (existingByName) {
      // Check if a record with the correct ID already exists
      const existingById = await prisma.linkedInConversation.findUnique({
        where: {
          accountId_participantLinkedInId: {
            accountId,
            participantLinkedInId: conv.participantLinkedInId,
          },
        },
      });

      if (existingById) {
        // Both records exist — move messages from stale record to the correct one, then delete stale
        await prisma.linkedInMessage.updateMany({
          where: { conversationId: existingByName.id },
          data: { conversationId: existingById.id },
        });
        await prisma.linkedInConversation.delete({
          where: { id: existingByName.id },
        });
        console.log(
          `[InboxReader] Merged stale conversation ${existingByName.id} into ${existingById.id}`
        );
      } else {
        // No conflict — just update the old record's ID
        await prisma.linkedInConversation.update({
          where: { id: existingByName.id },
          data: { participantLinkedInId: conv.participantLinkedInId },
        });
        console.log(
          `[InboxReader] Migrated conversation ${existingByName.id} participantLinkedInId: ` +
          `${existingByName.participantLinkedInId} → ${conv.participantLinkedInId}`
        );
      }
    }

    const upserted = await prisma.linkedInConversation.upsert({
      where: {
        accountId_participantLinkedInId: {
          accountId,
          participantLinkedInId: conv.participantLinkedInId,
        },
      },
      create: {
        accountId,
        linkedinConversationId: conv.linkedinConversationId || null,
        participantLinkedInId: conv.participantLinkedInId,
        participantName: conv.participantName,
        participantHeadline: conv.participantHeadline,
        participantProfileUrl: conv.participantProfileUrl,
        lastMessageAt: conv.lastMessageAt,
        lastMessageSnippet: conv.lastMessageSnippet,
        unreadCount: conv.unreadCount,
        autoReplyEnabled: account.autoReplyEnabled,
      },
      update: {
        linkedinConversationId: conv.linkedinConversationId || undefined,
        participantName: conv.participantName,
        participantProfileUrl: conv.participantProfileUrl,
        lastMessageAt: conv.lastMessageAt,
        lastMessageSnippet: conv.lastMessageSnippet,
        unreadCount: conv.unreadCount,
        ...(account.autoReplyEnabled ? { autoReplyEnabled: true } : {}),
      },
    });

    // Upsert messages — deduplicate by content + direction only.
    // We do NOT use sentAt for deduplication because LinkedIn's DOM timestamps
    // are relative strings ("3:16 AM", "Yesterday") that parse inconsistently
    // across syncs — empty timestamps produce sentAt=now() which changes each time.
    // Content + direction is sufficient: the same message content from the same
    // participant won't appear twice unless they literally typed the same thing twice.
    for (const msg of conv.messages) {
      const existing = await prisma.linkedInMessage.findFirst({
        where: {
          conversationId: upserted.id,
          direction: msg.direction,
          content: msg.content,
        },
      });

      if (!existing) {
        await prisma.linkedInMessage.create({
          data: {
            conversationId: upserted.id,
            direction: msg.direction,
            content: msg.content,
            sentAt: msg.sentAt,
            isAutoReply: false,
          },
        });
        totalNewMessages++;
      }
    }
  }

  // Update account lastSessionAt
  await prisma.linkedInAccount.update({
    where: { id: accountId },
    data: { lastSessionAt: new Date() },
  });

  // Count conversations that have INBOUND messages since their last auto-reply.
  // This is the metric that actually tells us whether processAutoReplies has work to do.
  const allConvs = await prisma.linkedInConversation.findMany({
    where: { accountId, autoReplyEnabled: true },
    select: {
      lastAutoReplyAt: true,
      messages: { select: { direction: true, createdAt: true } },
    },
  });
  const pendingReplies = allConvs.filter((c) => {
    const cutoff = c.lastAutoReplyAt ?? new Date(0);
    return c.messages.some((m) => m.direction === 'INBOUND' && m.createdAt > cutoff);
  }).length;

  console.log(
    `[InboxReader] Synced account ${accountId}: ` +
    `${conversations.length} conversations, ${totalNewMessages} new to DB, ` +
    `${pendingReplies} pending reply`
  );

  return { conversations, newMessages: totalNewMessages, pendingReplies };
}

/**
 * Sends a DM to a LinkedIn conversation by typing into the open thread.
 *
 * Hard constraints:
 * - Checks daily action limit before sending
 * - Random delay before action
 * - Increments dailyActionCount after success
 */
export async function sendDM(params: {
  accountId: string;
  participantLinkedInId: string;
  message: string;
}): Promise<void> {
  const { accountId, participantLinkedInId, message } = params;

  const account = await prisma.linkedInAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      sessionCookies: true,
      sessionValid: true,
      dailyActionCount: true,
      dailyActionLimit: true,
      dailyActionReset: true,
    },
  });

  if (!account || !account.sessionCookies || !account.sessionValid) {
    throw new Error(`No valid session for account ${accountId}`);
  }

  // Check and reset daily limit
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
    throw new Error(
      `Daily action limit (${account.dailyActionLimit}) reached for account ${accountId}`
    );
  }

  // Find the conversation's thread ID and participant name for fallback matching
  const conversation = await prisma.linkedInConversation.findFirst({
    where: { accountId, participantLinkedInId },
    select: { linkedinConversationId: true, participantName: true },
  });

  const threadId = conversation?.linkedinConversationId;
  const participantName = conversation?.participantName ?? null;

  await withSession(accountId, account.sessionCookies, async (session) => {
    const { page } = session;

    await randomDelay(1500, 4000);

    if (threadId) {
      // Navigate directly to the conversation thread
      await page.goto(
        `https://www.linkedin.com/messaging/thread/${threadId}/`,
        { waitUntil: 'domcontentloaded', timeout: 30000 }
      );
    } else {
      // Navigate to messaging and click into the right conversation by name
      await page.goto('https://www.linkedin.com/messaging/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Wait for the sidebar to load
      await page
        .waitForSelector('.msg-conversation-listitem', { timeout: 15000 })
        .catch(() => {});

      await randomDelay(1000, 2000);

      // Try to find the conversation by participant name in the sidebar
      if (participantName) {
        const clicked = await page.evaluate((name: string) => {
          const items = Array.from(
            document.querySelectorAll('.msg-conversation-listitem')
          );
          for (const item of items) {
            const nameEl = item.querySelector(
              '.msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names'
            );
            if (nameEl?.textContent?.trim().toLowerCase().includes(name.toLowerCase())) {
              (item as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, participantName);

        if (clicked) {
          await randomDelay(1500, 2500);
          await page
            .waitForSelector('.msg-s-event-listitem', { timeout: 8000 })
            .catch(() => {});
        } else {
          console.warn(
            `[InboxReader] Could not find conversation for "${participantName}" in sidebar`
          );
        }
      }
    }

    await randomDelay(1000, 2000);

    // Wait for the message input
    const inputSelector =
      '.msg-form__contenteditable, [role="textbox"][contenteditable="true"]';
    await page.waitForSelector(inputSelector, { timeout: 15000 });

    const input = page.locator(inputSelector).first();
    await input.click();
    await randomDelay(500, 1000);

    // Type the message with human-like speed
    await input.pressSequentially(message, {
      delay: Math.floor(Math.random() * 50) + 30,
    });

    await randomDelay(800, 1500);

    // Click the send button
    await page.click('.msg-form__send-button');

    await randomDelay(1500, 3000);
  });

  // Increment daily action count
  await prisma.linkedInAccount.update({
    where: { id: accountId },
    data: { dailyActionCount: { increment: 1 } },
  });

  console.log(`[InboxReader] DM sent for account ${accountId}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parses LinkedIn's relative time strings (e.g. "3:16 AM", "2:03 AM", "Yesterday")
 * into approximate Date objects.
 */
function parseLinkedInTime(timeStr: string, now: Date): Date {
  if (!timeStr) return now;

  // "3:16 AM" or "3:16 PM" — time today
  const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const period = timeMatch[3].toUpperCase();

    if (period === 'PM' && hours < 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;

    const d = new Date(now);
    d.setHours(hours, minutes, 0, 0);
    // If the time is in the future, it's probably yesterday
    if (d > now) d.setDate(d.getDate() - 1);
    return d;
  }

  // "Yesterday" — 24h ago
  if (/yesterday/i.test(timeStr)) {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }

  // "Mar 24" or "Mar 24, 2026" — specific date
  const dateMatch = timeStr.match(
    /([A-Z][a-z]{2})\s+(\d{1,2})(?:,?\s+(\d{4}))?/
  );
  if (dateMatch) {
    const months: Record<string, number> = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    const month = months[dateMatch[1]] ?? 0;
    const day = parseInt(dateMatch[2], 10);
    const year = dateMatch[3] ? parseInt(dateMatch[3], 10) : now.getFullYear();
    return new Date(year, month, day);
  }

  return now;
}
