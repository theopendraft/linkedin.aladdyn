/**
 * Analytics Sync Worker
 *
 * Processes jobs from the linkedin-analytics-sync queue:
 * 1. Call analyticsSyncService.syncAnalyticsForAccount(accountId)
 * 2. Log results
 *
 * Failures are fully isolated — never affect other services.
 */

import { Worker, Job } from 'bullmq';
import { redisConnection } from '../redis';
import { QUEUE_NAMES, AnalyticsSyncJobData } from '../queues';
import { syncAnalyticsForAccount } from '../../services/analyticsSyncService';

async function processAnalyticsSync(job: Job<AnalyticsSyncJobData>): Promise<void> {
  const { accountId } = job.data;

  console.log(`[AnalyticsWorker] Processing analytics sync for account ${accountId}`);

  try {
    const result = await syncAnalyticsForAccount(accountId);
    console.log(
      `[AnalyticsWorker] Sync complete for ${accountId}: ` +
        `synced=${result.synced} failed=${result.failed} skipped=${result.skipped}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[AnalyticsWorker] Sync failed for account ${accountId}: ${message}`);
    throw err;
  }
}

export function startAnalyticsWorker(): Worker<AnalyticsSyncJobData> {
  const worker = new Worker<AnalyticsSyncJobData>(
    QUEUE_NAMES.ANALYTICS_SYNC,
    processAnalyticsSync,
    {
      connection: redisConnection,
      concurrency: 2,
    }
  );

  worker.on('completed', (job) => {
    console.log(`[AnalyticsWorker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(
      `[AnalyticsWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`
    );
  });

  worker.on('error', (err) => {
    console.error('[AnalyticsWorker] Worker error:', err.message);
  });

  console.log('[AnalyticsWorker] Started (concurrency: 2)');
  return worker;
}
