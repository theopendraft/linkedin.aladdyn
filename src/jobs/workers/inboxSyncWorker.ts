/**
 * Inbox Sync Worker
 *
 * Processes jobs from the linkedin-inbox-sync queue:
 * 1. Call inboxReader.syncInbox(accountId)
 * 2. If triggerAutoReply: call autoReply.processAutoReplies(accountId)
 * 3. Log stats
 *
 * Failures are fully isolated — never affect other services.
 */

import { Worker, Job } from 'bullmq';
import { redisConnection } from '../redis';
import { QUEUE_NAMES, InboxSyncJobData } from '../queues';
import { syncInbox } from '../../services/inboxReader';
import { processAutoReplies } from '../../services/autoReply';

async function processInboxSync(job: Job<InboxSyncJobData>): Promise<void> {
  const { accountId, triggerAutoReply } = job.data;

  console.log(
    `[InboxSyncWorker] Processing sync for account ${accountId} (autoReply: ${triggerAutoReply})`
  );

  try {
    const syncResult = await syncInbox(accountId);
    console.log(
      `[InboxSyncWorker] Sync complete for ${accountId}: ` +
        `${syncResult.conversations.length} conversations, ` +
        `${syncResult.newMessages} new to DB, ` +
        `${syncResult.pendingReplies} pending reply`
    );

    if (triggerAutoReply) {
      // Always run — processAutoReplies does a cheap DB eligibility check
      // (INBOUND messages since lastAutoReplyAt) before opening any browser session.
      // Gating on syncResult.newMessages would miss messages that were synced in a
      // previous cycle but never replied to (e.g. after a failed attempt).
      const replyResult = await processAutoReplies(accountId);
      console.log(
        `[InboxSyncWorker] Auto-reply complete for ${accountId}: ` +
          `processed=${replyResult.processed} replied=${replyResult.replied} skipped=${replyResult.skipped}`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[InboxSyncWorker] Sync failed for account ${accountId}: ${message}`);
    // Re-throw so BullMQ handles retries
    throw err;
  }
}

export function startInboxSyncWorker(): Worker<InboxSyncJobData> {
  const worker = new Worker<InboxSyncJobData>(QUEUE_NAMES.INBOX_SYNC, processInboxSync, {
    connection: redisConnection,
    concurrency: 1, // One inbox sync at a time per worker instance
  });

  worker.on('completed', (job) => {
    console.log(`[InboxSyncWorker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(
      `[InboxSyncWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`
    );
  });

  worker.on('error', (err) => {
    // Non-fatal — worker errors must not crash the server
    console.error('[InboxSyncWorker] Worker error:', err.message);
  });

  console.log('[InboxSyncWorker] Started (concurrency: 1)');
  return worker;
}
