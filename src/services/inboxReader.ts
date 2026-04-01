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
    return { conversations: [], newMessages: 0, pendingReplies: 0 };
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
              // Use 'load' (not 'domcontentloaded') — LinkedIn's SPA loads messages
              // via XHR calls that fire AFTER the initial HTML parse. 'domcontentloaded'
              // returns before any message content is in the DOM.
              await page.goto(
                `https://www.linkedin.com/messaging/thread/${threadId}/`,
                { waitUntil: 'load', timeout: 25000 }
              );
              // Wait for XHR-loaded message data to settle. LinkedIn makes API calls
              // after page load to fetch the message list; networkidle catches these.
              await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
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
                // After click, wait for networkidle so XHR messages load
                await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
              } catch {
                console.warn(`[InboxReader] Could not click into conversation ${i}`);
                continue;
              }
            }
          }

          // Wait for at least one message element — if none appear after the
          // extended wait above, skip this thread rather than scraping empty DOM.
          const messagesLoaded = await page
            .waitForSelector('.msg-s-event-listitem', { timeout: 10000 })
            .then(() => true)
            .catch(() => false);

          if (!messagesLoaded) {
            console.warn(
              `[InboxReader] No message elements found in thread ` +
              `${threadId || i} after full wait — skipping`
            );
            continue;
          }

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
                  // Direction detection:
                  // LinkedIn marks messages from the OTHER person with the
                  // --other BEM modifier on the listitem. Messages sent by the
                  // logged-in account owner have no such modifier.
                  //
                  // Primary: BEM modifier on the listitem itself.
                  // LinkedIn marks messages from the OTHER person (received messages)
                  // with --other. Own sent messages have no such modifier.
                  const isOtherPrimary =
                    node.classList.contains('msg-s-event-listitem--other');

                  // Fallback A: check the parent message-group element.
                  // Some LinkedIn UI versions put the direction indicator on the
                  // group wrapper instead of the individual listitem.
                  const groupEl = node.closest(
                    '.msg-s-message-group, [class*="message-group"]'
                  );
                  const isOtherGroupA = groupEl
                    ? groupEl.classList.contains('msg-s-message-group--inbound') ||
                      groupEl.getAttribute('data-urn')?.includes('other') === true
                    : false;

                  // NOTE: Do NOT use avatar/profile-image presence as a fallback.
                  // LinkedIn's new UI renders the account owner's avatar on their
                  // own outbound messages too — causing own sent messages to be
                  // misclassified as INBOUND (bot then replies to itself).

                  const isOther = isOtherPrimary || isOtherGroupA;

                  // Message text — try selectors in order of specificity.
                  // LinkedIn's class names are stable but occasionally renamed.
                  const bodyEl =
                    node.querySelector('.msg-s-event-listitem__body') ??
                    node.querySelector('.msg-s-event-listitem__message-bubble') ??
                    node.querySelector('.msg-s-event-listitem__message') ??
                    node.querySelector('[class*="event-listitem__body"]') ??
                    node.querySelector('[class*="message-bubble"]');

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
                    _debug_isOtherPrimary: isOtherPrimary,
                    _debug_isOtherGroup: isOtherGroupA,
                  };
                })
                .filter((m) => m.content.length > 0);
            }
          );

          // Log direction breakdown to help diagnose mis-classification
          const inboundCount = messages.filter((m) => m.direction === 'INBOUND').length;
          const outboundCount = messages.filter((m) => m.direction === 'OUTBOUND').length;
          console.log(
            `[InboxReader] Thread ${threadId || i}: ${messages.length} messages ` +
            `(INBOUND=${inboundCount}, OUTBOUND=${outboundCount})`
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
    return { conversations: [], newMessages: 0, pendingReplies: 0 };
  }

  // ─── Upsert conversations and messages into DB ───────────────────

  for (const conv of conversations) {
    if (!conv.participantLinkedInId) continue;

    // ── Thread-ID normalization ──────────────────────────────────────────────
    // The participantLinkedInId is extracted from the DOM and can vary between
    // syncs (profile URL extraction fails → falls back to name slug), creating
    // duplicate conversation records. A LinkedIn thread ID (from the URL) is
    // stable and authoritative. If we have one, use it to find any existing
    // conversation for this thread and pin its participantLinkedInId to the
    // current extraction before the upsert runs.
    if (conv.linkedinConversationId) {
      const existingByThread = await prisma.linkedInConversation.findFirst({
        where: {
          accountId,
          linkedinConversationId: conv.linkedinConversationId,
          participantLinkedInId: { not: conv.participantLinkedInId },
        },
      });

      if (existingByThread) {
        // Check whether a conversation already exists with the new (correct) ID
        const alreadyExists = await prisma.linkedInConversation.findUnique({
          where: {
            accountId_participantLinkedInId: {
              accountId,
              participantLinkedInId: conv.participantLinkedInId,
            },
          },
        });

        if (!alreadyExists) {
          // Safe to rename — just update the stale participantLinkedInId
          await prisma.linkedInConversation.update({
            where: { id: existingByThread.id },
            data: { participantLinkedInId: conv.participantLinkedInId },
          });
          console.log(
            `[InboxReader] Normalized conversation ${existingByThread.id} participantLinkedInId via threadId ` +
            `${existingByThread.participantLinkedInId} → ${conv.participantLinkedInId}`
          );
        } else {
          // Both records exist for the same thread — merge and delete the stale one
          await prisma.linkedInMessage.updateMany({
            where: { conversationId: existingByThread.id },
            data: { conversationId: alreadyExists.id },
          });
          await prisma.linkedInConversation.delete({ where: { id: existingByThread.id } });
          console.log(
            `[InboxReader] Merged duplicate conversation ${existingByThread.id} into ${alreadyExists.id} (same threadId)`
          );
        }
      }
    }

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
        // Do NOT sync unreadCount from DOM — LinkedIn's CSS-based hasUnread detection
        // stays true permanently after headless navigation and would overwrite the
        // unreadCount: 0 that autoReply sets after sending, causing infinite reply loops.
        // unreadCount is managed solely by autoReply (sets 0) and conversation create (sets from DOM).
        ...(account.autoReplyEnabled ? { autoReplyEnabled: true } : {}),
      },
    });

    // ── Anchor-based new message detection ──────────────────────────────────
    //
    // WHY NOT COUNT-BASED:
    //   LinkedIn's DOM only shows the last ~20 messages. If a participant sends
    //   "Hello" and the DB already has 2+ older "Hello"s from history, DOM count
    //   (1-2 visible) ≤ DB count (3+) → toInsert = 0 → new message silently missed.
    //   This caused Pankaj's new messages to never reach the DB.
    //
    // HOW THIS WORKS:
    //   1. Find the last message we have in DB (the "anchor").
    //   2. Locate the anchor in the DOM array by searching from the end.
    //      Use the N-th occurrence from end (N = DB count of that content+direction)
    //      to skip over any DOM messages with identical content that came before it.
    //   3. Everything in DOM AFTER the anchor position is new → insert with
    //      createdAt = now() so messages[0] ordering flips to INBOUND correctly.
    //   4. Fallback (anchor not in DOM window — conversation longer than 20 msgs):
    //      windowed count-based dedup against only the most recent DOM-window-size
    //      DB messages, which bounds the over-counting problem to that window.

    const domMessages = conv.messages; // oldest → newest (DOM render order)

    const lastDbMsg = await prisma.linkedInMessage.findFirst({
      where: { conversationId: upserted.id },
      orderBy: { createdAt: 'desc' },
      select: { direction: true, content: true, createdAt: true },
    });

    let newMessages: MessageData[] = [];

    if (!lastDbMsg) {
      // Brand-new conversation — every DOM message is new
      newMessages = domMessages;
      console.log(
        `[InboxReader] New conversation ${upserted.id} — inserting all ${newMessages.length} messages`
      );
    } else {
      // Count how many times the anchor content+direction appears in DB
      // Count only within the last DOM-window-size messages in DB.
      // Counting ALL occurrences in the full history inflates anchorDbCount when
      // the bot sends identical greetings across multiple sessions (e.g. genie
      // re-introduces itself several times). An inflated count makes the anchor
      // search fall back to the wrong position, causing old INBOUNDs to be
      // re-detected as new on every subsequent sync.
      const recentForAnchor = await prisma.linkedInMessage.findMany({
        where: { conversationId: upserted.id },
        orderBy: { createdAt: 'desc' },
        take: domMessages.length,
        select: { direction: true, content: true },
      });
      const anchorDbCount = recentForAnchor.filter(
        (m) => m.direction === lastDbMsg.direction && m.content === lastDbMsg.content
      ).length || 1; // minimum 1 so the anchor search always runs

      // Find the anchorDbCount-th occurrence from the END of the DOM.
      // Searching from the end means we hit the MOST RECENT occurrences first;
      // once we've skipped anchorDbCount matches we've landed on the anchor.
      //
      // Content matching uses a prefix check (first 60 chars) in addition to
      // exact equality. LinkedIn truncates long messages in the DOM with
      // "…See more" — textContent returns the truncated string, which won't
      // exactly match the full text stored in DB. Prefix matching covers this.
      //
      // If we find fewer occurrences than anchorDbCount (DB has extra identical
      // messages from past bugs, or old messages scrolled out of the 20-msg DOM
      // window), we fall back to using the MOST RECENT occurrence as the anchor.
      // That's still correct: everything in DOM after the most recent matching
      // OUTBOUND is genuinely new from the participant.

      function anchorMatches(domContent: string, dbContent: string): boolean {
        if (domContent === dbContent) return true;
        // Prefix match to handle DOM truncation ("long message…See more"):
        // the DOM shows the first N chars of the full DB content.
        const prefix = Math.min(dbContent.length, domContent.length, 60);
        return prefix >= 40 && domContent.slice(0, prefix) === dbContent.slice(0, prefix);
      }

      let anchorDomIndex = -1;
      let firstFoundIndex = -1; // most recent DOM occurrence (fallback anchor)
      let found = 0;

      for (let j = domMessages.length - 1; j >= 0; j--) {
        if (
          domMessages[j].direction === lastDbMsg.direction &&
          anchorMatches(domMessages[j].content, lastDbMsg.content)
        ) {
          found++;
          if (firstFoundIndex < 0) firstFoundIndex = j; // record most recent match
          if (found === anchorDbCount) {
            anchorDomIndex = j;
            break;
          }
        }
      }

      // Fallback: DB has more identical messages than DOM shows (old messages
      // scrolled out of the 20-msg window, or duplicate DB entries from past
      // bugs). Use the most recent DOM occurrence as the effective anchor —
      // everything after it is still genuinely new from the participant.
      if (anchorDomIndex < 0 && firstFoundIndex >= 0) {
        anchorDomIndex = firstFoundIndex;
        console.log(
          `[InboxReader] Anchor partial match (${found}/${anchorDbCount} occurrences in DOM) ` +
          `— using most recent at DOM[${anchorDomIndex}]`
        );
      }

      if (anchorDomIndex >= 0) {
        // Anchor found — all DOM messages after it are new
        newMessages = domMessages.slice(anchorDomIndex + 1);
        console.log(
          `[InboxReader] Anchor at DOM[${anchorDomIndex}] ` +
          `(${lastDbMsg.direction} "${lastDbMsg.content.slice(0, 40)}") ` +
          `→ ${newMessages.length} new message(s) after it`
        );
      } else if (lastDbMsg.direction === 'OUTBOUND') {
        // Our last OUTBOUND is not in the DOM window. Two possible reasons:
        //
        // A) DELIVERY LAG — message was just sent (< 120s ago), LinkedIn hasn't
        //    rendered it in the thread DOM yet. Running windowed dedup here would
        //    re-insert old INBOUND messages like "Hii" with createdAt=now() →
        //    messages[0] flips to INBOUND → bot replies again. Safe: skip.
        //
        // B) SCROLLED OUT — OUTBOUND is old, but the conversation grew past the
        //    ~20-message DOM window. New INBOUND messages from the participant
        //    are visible in the DOM but we'd miss them entirely. Fix: windowed dedup
        //    (same as INBOUND branch), bounded to the DOM window size.
        const sentMsAgo = Date.now() - new Date(lastDbMsg.createdAt).getTime();
        const DELIVERY_LAG_THRESHOLD_MS = 120_000; // 2 minutes

        if (sentMsAgo < DELIVERY_LAG_THRESHOLD_MS) {
          // Case A: recent send, likely delivery lag — skip safely
          console.log(
            `[InboxReader] OUTBOUND anchor sent ${Math.round(sentMsAgo / 1000)}s ago ` +
            `— delivery lag, skipping insertion this cycle`
          );
          // newMessages stays [] — nothing inserted
        } else {
          // Case B: old OUTBOUND scrolled out of the DOM window — use windowed dedup
          // so we still catch new INBOUND messages from the participant.
          console.log(
            `[InboxReader] OUTBOUND anchor is ${Math.round(sentMsAgo / 1000)}s old and ` +
            `not in DOM window — using windowed dedup`
          );
          const windowSize = domMessages.length;
          const recentDbWindow = await prisma.linkedInMessage.findMany({
            where: { conversationId: upserted.id },
            orderBy: { createdAt: 'desc' },
            take: windowSize,
            select: { direction: true, content: true },
          });

          const dbWindowCounts = new Map<string, number>();
          for (const m of recentDbWindow) {
            const key = `${m.direction}\0${m.content}`;
            dbWindowCounts.set(key, (dbWindowCounts.get(key) ?? 0) + 1);
          }

          const domCounts = new Map<string, { count: number; example: MessageData }>();
          for (const m of domMessages) {
            const key = `${m.direction}\0${m.content}`;
            const existing = domCounts.get(key);
            domCounts.set(key, {
              count: (existing?.count ?? 0) + 1,
              example: existing?.example ?? m,
            });
          }

          for (const [key, { count: domCount, example }] of domCounts) {
            const sep = key.indexOf('\0');
            const direction = key.slice(0, sep) as 'INBOUND' | 'OUTBOUND';
            const content = key.slice(sep + 1);
            const dbCount = dbWindowCounts.get(key) ?? 0;
            const toInsert = Math.max(0, domCount - dbCount);
            for (let i = 0; i < toInsert; i++) {
              newMessages.push({ direction, content, sentAt: example.sentAt });
            }
          }
          console.log(
            `[InboxReader] Windowed dedup (OUTBOUND scrolled out, window=${windowSize}) ` +
            `→ ${newMessages.length} new message(s)`
          );
        }
      } else {
        // Anchor is INBOUND and not in DOM — the conversation has more messages
        // than LinkedIn renders in the DOM window (very long conversation, or the
        // last INBOUND was far back). Use windowed dedup against the same number
        // of recent DB messages as DOM shows to detect any new messages at the end.
        const windowSize = domMessages.length;
        const recentDbWindow = await prisma.linkedInMessage.findMany({
          where: { conversationId: upserted.id },
          orderBy: { createdAt: 'desc' },
          take: windowSize,
          select: { direction: true, content: true },
        });

        const dbWindowCounts = new Map<string, number>();
        for (const m of recentDbWindow) {
          const key = `${m.direction}\0${m.content}`;
          dbWindowCounts.set(key, (dbWindowCounts.get(key) ?? 0) + 1);
        }

        const domCounts = new Map<string, { count: number; example: MessageData }>();
        for (const m of domMessages) {
          const key = `${m.direction}\0${m.content}`;
          const existing = domCounts.get(key);
          domCounts.set(key, {
            count: (existing?.count ?? 0) + 1,
            example: existing?.example ?? m,
          });
        }

        for (const [key, { count: domCount, example }] of domCounts) {
          const sep = key.indexOf('\0');
          const direction = key.slice(0, sep) as 'INBOUND' | 'OUTBOUND';
          const content = key.slice(sep + 1);
          const dbCount = dbWindowCounts.get(key) ?? 0;
          const toInsert = Math.max(0, domCount - dbCount);
          for (let i = 0; i < toInsert; i++) {
            newMessages.push({ direction, content, sentAt: example.sentAt });
          }
        }
        console.log(
          `[InboxReader] INBOUND anchor not in DOM window (${windowSize} msgs shown) ` +
          `→ windowed dedup found ${newMessages.length} new message(s)`
        );
      }
    }

    // Insert all detected new messages with createdAt = now() so that
    // messages ordered by createdAt DESC in processAutoReplies correctly
    // shows the newest message at [0].
    //
    // OUTBOUND dedup: processAutoReplies already saves every bot reply to DB
    // before sendDM runs. If syncInbox detects the same OUTBOUND content in the
    // DOM it means the anchor count drifted — skip to prevent anchorDbCount
    // inflation which in turn causes stale INBOUND messages to be re-inserted
    // as new (flipping messages[0] back to INBOUND → infinite reply loop).
    for (const msg of newMessages) {
      if (msg.direction === 'OUTBOUND') {
        // OUTBOUND dedup: all bot replies are saved by processAutoReplies before
        // sendDM runs. Re-inserting them inflates anchorDbCount and breaks the
        // anchor search on the next sync.
        const alreadyInDb = await prisma.linkedInMessage.count({
          where: { conversationId: upserted.id, direction: 'OUTBOUND', content: msg.content },
        });
        if (alreadyInDb > 0) {
          console.log(
            `[InboxReader] Skipping duplicate OUTBOUND from DOM scrape: "${msg.content.slice(0, 60)}"`
          );
          continue;
        }
      }

      if (msg.direction === 'INBOUND') {
        // INBOUND dedup: old messages from a long conversation history can appear
        // in the DOM window even after the anchor, and get re-inserted with
        // createdAt=now() — making them messages[0] and triggering a spurious
        // auto-reply. Dedup by content + sentAt window (±2 min to account for
        // LinkedIn's minute-level timestamp granularity).
        const sentAtMs = msg.sentAt.getTime();
        const alreadyInDb = await prisma.linkedInMessage.count({
          where: {
            conversationId: upserted.id,
            direction: 'INBOUND',
            content: msg.content,
            sentAt: {
              gte: new Date(sentAtMs - 2 * 60_000),
              lte: new Date(sentAtMs + 2 * 60_000),
            },
          },
        });
        if (alreadyInDb > 0) {
          console.log(
            `[InboxReader] Skipping duplicate INBOUND from DOM scrape: "${msg.content.slice(0, 60)}"`
          );
          continue;
        }
      }

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
          // Abort — do NOT fall through. Continuing without navigating to the
          // correct thread would send the DM to whatever conversation is currently
          // open in the browser (typically the last-synced thread), silently
          // spamming the wrong person.
          throw new Error(
            `[sendDM] Participant "${participantName}" not found in sidebar — aborting to prevent wrong-thread send`
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

    // Use fill() to set the full message text at once — much faster than
    // pressSequentially character-by-character, which times out on long messages
    // (400 chars × 50ms = 20s+). fill() triggers proper input events on
    // LinkedIn's contenteditable div and completes in milliseconds.
    await input.fill(message);

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
