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
import { createLogger } from '../../utils/logger';

const logger = createLogger({ service: 'inbox-sync-worker' });

async function processInboxSync(job: Job<InboxSyncJobData>): Promise<void> {
  const { accountId, triggerAutoReply } = job.data;

  logger.info('Processing sync', { accountId, triggerAutoReply: String(triggerAutoReply) });

  try {
    const syncResult = await syncInbox(accountId);
    logger.info('Sync complete', {
      accountId,
      conversations: String(syncResult.conversations.length),
      newMessages: String(syncResult.newMessages),
      pendingReplies: String(syncResult.pendingReplies),
    });

    if (triggerAutoReply) {
      // Always run — processAutoReplies does a cheap DB eligibility check
      // (INBOUND messages since lastAutoReplyAt) before opening any browser session.
      // Gating on syncResult.newMessages would miss messages that were synced in a
      // previous cycle but never replied to (e.g. after a failed attempt).
      const replyResult = await processAutoReplies(accountId);
      logger.info('Auto-reply complete', {
        accountId,
        processed: String(replyResult.processed),
        replied: String(replyResult.replied),
        skipped: String(replyResult.skipped),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Sync failed', { accountId, error: message });
    // Re-throw so BullMQ handles retries
    throw err;
  }
}

export function startInboxSyncWorker(): Worker<InboxSyncJobData> {
  const worker = new Worker<InboxSyncJobData>(QUEUE_NAMES.INBOX_SYNC, processInboxSync, {
    connection: redisConnection,
    concurrency: 1, // One inbox sync at a time per worker instance
    // Inbox sync involves Playwright browser automation across multiple conversations
    // (navigate, wait for load, networkidle, random delays). Default lockDuration is
    // 30s — far too short. Set to 5 minutes so BullMQ doesn't mark the job as stalled
    // while the browser is still working.
    lockDuration: 300_000, // 5 minutes
  });

  worker.on('completed', (job) => {
    logger.info('Job completed', { jobId: job.id ?? '' });
  });

  worker.on('failed', (job, err) => {
    logger.error('Job failed', { jobId: job?.id ?? '', attempt: String(job?.attemptsMade ?? 0), error: err.message });
  });

  worker.on('error', (err) => {
    // Non-fatal — worker errors must not crash the server
    logger.error('Worker error', { error: err.message });
  });

  logger.info('Started', { concurrency: '1' });
  return worker;
}
