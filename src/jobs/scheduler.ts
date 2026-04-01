/**
 * Schedulers — Post + Inbox + Analytics + Engagement + Sequence
 *
 * Task 1 (every 60s): Find APPROVED posts with scheduledAt ≤ now+5min → enqueue
 * Task 2 (~15min ±5min jitter): Inbox sync for auto-reply accounts
 * Task 3 (~30min ±10min jitter): Analytics sync for all active accounts
 * Task 4 (~60min ±15min jitter): Engagement scrape for recent POSTED posts
 * Task 5 (~10min ±3min jitter): Process due sequence messages
 *
 * Per hard constraints: no fixed 24/7 schedule — randomized windows.
 */

import {
  publishQueue,
  inboxSyncQueue,
  analyticsSyncQueue,
  engagementQueue,
  sequenceQueue,
} from './queues';
import prisma from '../lib/prisma';
import { evaluateABTests } from '../services/abTesting';

const LOOKAHEAD_MINUTES = 5;

/**
 * Returns a random interval within [baseMs - jitterMs, baseMs + jitterMs].
 */
function randomInterval(baseMs: number, jitterMs: number): number {
  return baseMs + (Math.random() * 2 - 1) * jitterMs;
}

// ── Task 1: Post scheduler ─────────────────────────────────────────────────────

async function scheduleUpcomingPosts(): Promise<void> {
  const now = new Date();
  const lookahead = new Date(now.getTime() + LOOKAHEAD_MINUTES * 60 * 1000);

  const posts = await prisma.linkedInPost.findMany({
    where: {
      status: 'APPROVED',
      scheduledAt: { lte: lookahead },
    },
    include: { account: { select: { id: true } } },
    take: 50,
  });

  if (posts.length === 0) return;

  console.log(`[Scheduler] Enqueueing ${posts.length} upcoming posts`);

  for (const post of posts) {
    const delay = post.scheduledAt
      ? Math.max(0, post.scheduledAt.getTime() - now.getTime())
      : 0;

    await prisma.linkedInPost.update({
      where: { id: post.id },
      data: { status: 'SCHEDULED' },
    });

    await publishQueue.add(
      `publish-${post.id}`,
      { postId: post.id, accountId: post.account.id },
      {
        delay,
        jobId: `publish-${post.id}`,
      }
    );

    console.log(
      `[Scheduler] Enqueued post ${post.id} in ${Math.round(delay / 1000)}s`
    );
  }
}

// ── Task 2: Inbox sync scheduler ──────────────────────────────────────────────

async function scheduleInboxSyncs(): Promise<void> {
  const accounts = await prisma.linkedInAccount.findMany({
    where: {
      autoReplyEnabled: true,
      sessionValid: true,
      isActive: true,
    },
    select: { id: true },
  });

  if (accounts.length === 0) return;

  console.log(`[Scheduler] Enqueueing inbox sync for ${accounts.length} accounts`);

  for (const account of accounts) {
    // Use the same jobId scheme as messageWatcher so scheduler and watcher
    // deduplicate against each other — if one is already waiting, the add is a no-op.
    await inboxSyncQueue.add(
      'inbox-sync',
      { accountId: account.id, triggerAutoReply: true },
      {
        jobId: `inbox-sync-${account.id}`,
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 2,
      }
    );
  }
}

// ── Task 3: Analytics sync scheduler ──────────────────────────────────────────

async function scheduleAnalyticsSyncs(): Promise<void> {
  const accounts = await prisma.linkedInAccount.findMany({
    where: {
      isActive: true,
      accessToken: { not: null },
    },
    select: { id: true },
  });

  if (accounts.length === 0) return;

  console.log(`[Scheduler] Enqueueing analytics sync for ${accounts.length} accounts`);

  for (const account of accounts) {
    await analyticsSyncQueue.add(
      `analytics-sync-${account.id}-${Date.now()}`,
      { accountId: account.id }
    );
  }
}

// ── Task 4: Engagement scrape scheduler ───────────────────────────────────────

async function scheduleEngagementScrapes(): Promise<void> {
  // Find POSTED posts from the last 7 days that haven't been scraped recently
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const posts = await prisma.linkedInPost.findMany({
    where: {
      status: 'POSTED',
      linkedinPostId: { not: null },
      publishedAt: { gte: sevenDaysAgo },
      account: { sessionValid: true, isActive: true },
    },
    select: { id: true, accountId: true },
    take: 10, // Limit per cycle
  });

  if (posts.length === 0) return;

  console.log(`[Scheduler] Enqueueing engagement scrape for ${posts.length} posts`);

  for (const post of posts) {
    await engagementQueue.add(
      `engagement-${post.id}-${Date.now()}`,
      { postId: post.id, accountId: post.accountId }
    );
  }
}

// ── Task 5: Sequence processing scheduler ─────────────────────────────────────

async function scheduleSequenceProcessing(): Promise<void> {
  // Check if there are any active sequences with due enrollments
  const dueCount = await prisma.linkedInSequenceEnrollment.count({
    where: {
      status: 'ACTIVE',
      nextStepAt: { lte: new Date() },
    },
  });

  if (dueCount === 0) return;

  console.log(`[Scheduler] ${dueCount} sequence enrollments due — enqueueing processor`);

  await sequenceQueue.add(
    `sequence-process-${Date.now()}`,
    { type: 'process-due' }
  );
}

// ── Task 6: A/B test evaluation (piggybacks on analytics scheduler) ───────────

async function evaluateABTestResults(): Promise<void> {
  try {
    const result = await evaluateABTests();
    if (result.decided > 0) {
      console.log(`[Scheduler] A/B tests evaluated: ${result.evaluated}, decided: ${result.decided}`);
    }
  } catch (err) {
    console.error(
      '[Scheduler] A/B test evaluation error:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

/** Starts the post scheduler loop (every 60s). */
export function startPostScheduler(intervalMs = 60_000): NodeJS.Timeout {
  console.log('[Scheduler] Post scheduler started (every 60s)');

  const tick = async () => {
    try {
      await scheduleUpcomingPosts();
    } catch (err) {
      console.error(
        '[Scheduler] Post scheduler error:',
        err instanceof Error ? err.message : String(err)
      );
    }
  };

  tick();
  return setInterval(tick, intervalMs);
}

/** Starts the inbox sync loop (~60s ±15s for near-real-time auto-reply). */
export function startInboxScheduler(): void {
  console.log('[Scheduler] Inbox sync scheduler started (~60s ±15s)');

  const schedule = () => {
    const interval = randomInterval(60_000, 15_000); // 45–75 seconds

    setTimeout(async () => {
      try {
        await scheduleInboxSyncs();
      } catch (err) {
        console.error(
          '[Scheduler] Inbox sync error:',
          err instanceof Error ? err.message : String(err)
        );
      } finally {
        schedule();
      }
    }, interval);
  };

  schedule();
}

/** Starts the analytics sync loop (~30min ±10min jitter). */
export function startAnalyticsScheduler(): void {
  console.log('[Scheduler] Analytics scheduler started (~30min ±10min jitter)');

  const schedule = () => {
    const interval = randomInterval(30 * 60 * 1000, 10 * 60 * 1000);
    console.log(`[Scheduler] Next analytics sync in ${Math.round(interval / 60000)}min`);

    setTimeout(async () => {
      try {
        await scheduleAnalyticsSyncs();
        // Also evaluate A/B tests after analytics sync
        await evaluateABTestResults();
      } catch (err) {
        console.error(
          '[Scheduler] Analytics sync error:',
          err instanceof Error ? err.message : String(err)
        );
      } finally {
        schedule();
      }
    }, interval);
  };

  schedule();
}

/** Starts the engagement scrape loop (~60min ±15min jitter). */
export function startEngagementScheduler(): void {
  console.log('[Scheduler] Engagement scheduler started (~60min ±15min jitter)');

  const schedule = () => {
    const interval = randomInterval(60 * 60 * 1000, 15 * 60 * 1000);
    console.log(`[Scheduler] Next engagement scrape in ${Math.round(interval / 60000)}min`);

    setTimeout(async () => {
      try {
        await scheduleEngagementScrapes();
      } catch (err) {
        console.error(
          '[Scheduler] Engagement scrape error:',
          err instanceof Error ? err.message : String(err)
        );
      } finally {
        schedule();
      }
    }, interval);
  };

  schedule();
}

/** Starts the sequence processing loop (~10min ±3min jitter). */
export function startSequenceScheduler(): void {
  console.log('[Scheduler] Sequence scheduler started (~10min ±3min jitter)');

  const schedule = () => {
    const interval = randomInterval(10 * 60 * 1000, 3 * 60 * 1000);

    setTimeout(async () => {
      try {
        await scheduleSequenceProcessing();
      } catch (err) {
        console.error(
          '[Scheduler] Sequence processing error:',
          err instanceof Error ? err.message : String(err)
        );
      } finally {
        schedule();
      }
    }, interval);
  };

  schedule();
}
