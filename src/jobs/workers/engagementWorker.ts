/**
 * Engagement Scrape Worker
 *
 * Processes jobs from the linkedin-engagement queue:
 * 1. Call engagementScraper.scrapePostEngagements(postId, accountId)
 * 2. Auto-enroll engaged profiles into linked sequences
 * 3. Log results
 *
 * Failures are fully isolated — never affect other services.
 */

import { Worker, Job } from 'bullmq';
import { redisConnection } from '../redis';
import { QUEUE_NAMES, EngagementJobData } from '../queues';
import { scrapePostEngagements } from '../../services/engagementScraper';
import { autoEnrollEngagedProfiles } from '../../services/sequenceEngine';

async function processEngagement(job: Job<EngagementJobData>): Promise<void> {
  const { postId, accountId } = job.data;

  console.log(`[EngagementWorker] Processing engagement scrape for post ${postId}`);

  try {
    const result = await scrapePostEngagements(postId, accountId);
    console.log(
      `[EngagementWorker] Scrape complete for post ${postId}: ` +
        `${result.likes.length} likes, ${result.comments.length} comments, ${result.totalScraped} total`
    );

    // Auto-enroll engaged profiles into linked sequences
    if (result.totalScraped > 0) {
      const enrolled = await autoEnrollEngagedProfiles(postId);
      if (enrolled > 0) {
        console.log(
          `[EngagementWorker] Auto-enrolled ${enrolled} profiles into sequences for post ${postId}`
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[EngagementWorker] Scrape failed for post ${postId}: ${message}`);
    throw err;
  }
}

export function startEngagementWorker(): Worker<EngagementJobData> {
  const worker = new Worker<EngagementJobData>(
    QUEUE_NAMES.ENGAGEMENT,
    processEngagement,
    {
      connection: redisConnection,
      concurrency: 1, // One scrape at a time — browser resource intensive
    }
  );

  worker.on('completed', (job) => {
    console.log(`[EngagementWorker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(
      `[EngagementWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`
    );
  });

  worker.on('error', (err) => {
    console.error('[EngagementWorker] Worker error:', err.message);
  });

  console.log('[EngagementWorker] Started (concurrency: 1)');
  return worker;
}
