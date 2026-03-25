/**
 * Message Watcher
 *
 * Keeps a persistent Playwright browser open for each account and intercepts
 * LinkedIn's realtime WebSocket / SSE. When any frame arrives on LinkedIn's
 * realtime connection, it means activity has happened in the account
 * (new message, notification, etc). We debounce and enqueue an inbox sync job.
 *
 * This replaces the ~60s polling scheduler with a purely event-driven trigger —
 * inbox syncs only fire when LinkedIn itself pushes data.
 *
 * Architecture:
 * - One persistent browser per account (separate from withSession pool)
 * - Browser stays on linkedin.com/messaging/ to maintain the realtime socket
 * - WebSocket frames + voyager API responses both trigger the debounced sync
 * - Session expiry detected via framenavigated → stops watcher, marks invalid
 */

import prisma from '../lib/prisma';
import { claimSession, releaseSession, BrowserSession } from './browserPool';
import { inboxSyncQueue } from '../jobs/queues';

const DEBOUNCE_MS = 15000; // wait 15s after last event before enqueueing

// Active watcher sessions keyed by accountId
const activeSessions = new Map<string, BrowserSession>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── Debounce helper ────────────────────────────────────────────────────────────

function scheduleSync(accountId: string): void {
  const existing = debounceTimers.get(accountId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    debounceTimers.delete(accountId);
    console.log(`[MessageWatcher] Activity detected — enqueueing inbox sync for ${accountId}`);
    try {
      // jobId deduplication: if a sync is already waiting/active for this account,
      // BullMQ will skip the add. removeOnComplete ensures the slot clears after
      // the job finishes so the next real event can enqueue again.
      await inboxSyncQueue.add(
        'inbox-sync',
        { accountId, triggerAutoReply: true },
        {
          attempts: 2,
          jobId: `inbox-sync-${accountId}`,
          removeOnComplete: true,
          removeOnFail: false,
        }
      );
    } catch (err) {
      console.error(
        `[MessageWatcher] Failed to enqueue sync for ${accountId}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }, DEBOUNCE_MS);

  debounceTimers.set(accountId, timer);
}

// ── Start / Stop ───────────────────────────────────────────────────────────────

export async function startMessageWatcher(accountId: string): Promise<void> {
  if (activeSessions.has(accountId)) {
    return; // already watching
  }

  const account = await prisma.linkedInAccount.findUnique({
    where: { id: accountId },
    select: {
      sessionCookies: true,
      sessionValid: true,
      autoReplyEnabled: true,
      isActive: true,
    },
  });

  if (
    !account?.sessionCookies ||
    !account.sessionValid ||
    !account.autoReplyEnabled ||
    !account.isActive
  ) {
    console.log(`[MessageWatcher] Account ${accountId} not eligible — skipping`);
    return;
  }

  let session: BrowserSession;
  try {
    session = await claimSession(accountId, account.sessionCookies);
  } catch (err) {
    console.error(
      `[MessageWatcher] Failed to claim session for ${accountId}:`,
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  activeSessions.set(accountId, session);
  const { page } = session;

  // ── WebSocket interception ────────────────────────────────────────────────
  // LinkedIn's realtime WebSocket delivers new message events. Any inbound
  // frame = potential new message → trigger debounced sync.
  page.on('websocket', (ws) => {
    const url = ws.url();
    const isRealtimeSocket =
      url.includes('realtime.www.linkedin.com') ||
      url.includes('push.linkedin.com') ||
      url.includes('livefyre') ||
      url.includes('realtime');

    if (!isRealtimeSocket) return;

    console.log(`[MessageWatcher] Realtime WebSocket connected for ${accountId}: ${url}`);

    ws.on('framereceived', () => {
      scheduleSync(accountId);
    });

    ws.on('close', () => {
      console.log(`[MessageWatcher] Realtime WebSocket closed for ${accountId}`);
    });
  });

  // HTTP response interception intentionally removed — too noisy.
  // LinkedIn's messaging page fires dozens of /voyager/api/messaging/ requests
  // per minute for presence, read receipts, typing, etc. The realtime WebSocket
  // above is sufficient to detect actual new messages.

  // ── Session health monitor ────────────────────────────────────────────────
  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (
      url.includes('/login') ||
      url.includes('/checkpoint') ||
      url.includes('/authwall') ||
      url.includes('/uas/login')
    ) {
      console.warn(
        `[MessageWatcher] Session expired for account ${accountId} — stopping watcher`
      );
      await stopMessageWatcher(accountId);
      await prisma.linkedInAccount
        .update({ where: { id: accountId }, data: { sessionValid: false } })
        .catch(() => {});
    }
  });

  // Navigate to messaging to establish the realtime WebSocket connection
  try {
    await page.goto('https://www.linkedin.com/messaging/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    console.log(`[MessageWatcher] Watching account ${accountId} — realtime listener active`);
  } catch (err) {
    console.error(
      `[MessageWatcher] Failed to navigate for ${accountId}:`,
      err instanceof Error ? err.message : String(err)
    );
    await stopMessageWatcher(accountId);
  }
}

export async function stopMessageWatcher(accountId: string): Promise<void> {
  const timer = debounceTimers.get(accountId);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(accountId);
  }

  const session = activeSessions.get(accountId);
  if (session) {
    activeSessions.delete(accountId);
    await releaseSession(session).catch(() => {});
    console.log(`[MessageWatcher] Stopped watching account ${accountId}`);
  }
}

/**
 * Starts watchers for all accounts with autoReply enabled and a valid session.
 * Call once at server boot.
 */
export async function startAllMessageWatchers(): Promise<void> {
  const accounts = await prisma.linkedInAccount.findMany({
    where: { autoReplyEnabled: true, sessionValid: true, isActive: true },
    select: { id: true },
  });

  if (accounts.length === 0) {
    console.log('[MessageWatcher] No eligible accounts — no watchers started');
    return;
  }

  console.log(`[MessageWatcher] Starting watchers for ${accounts.length} account(s)`);
  for (const { id } of accounts) {
    await startMessageWatcher(id);
  }
}
