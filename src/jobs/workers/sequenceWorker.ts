/**
 * Sequence Worker
 *
 * Processes jobs from the linkedin-sequence queue:
 * - 'process-due': process all enrollments where nextStepAt <= now
 * - 'auto-enroll': auto-enroll profiles that engaged with a specific post
 *
 * Failures are fully isolated — never affect other services.
 */

import { Worker, Job } from 'bullmq';
import { redisConnection } from '../redis';
import { QUEUE_NAMES, SequenceJobData } from '../queues';
import {
  processSequenceDueMessages,
  autoEnrollEngagedProfiles,
} from '../../services/sequenceEngine';

async function processSequenceJob(job: Job<SequenceJobData>): Promise<void> {
  const { type, postId } = job.data;

  if (type === 'process-due') {
    console.log('[SequenceWorker] Processing due sequence messages');

    try {
      const result = await processSequenceDueMessages();
      console.log(
        `[SequenceWorker] Process-due complete: ` +
          `processed=${result.processed} sent=${result.sent} completed=${result.completed} errors=${result.errors}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SequenceWorker] Process-due failed: ${message}`);
      throw err;
    }
  } else if (type === 'auto-enroll' && postId) {
    console.log(`[SequenceWorker] Auto-enrolling profiles for post ${postId}`);

    try {
      const enrolled = await autoEnrollEngagedProfiles(postId);
      console.log(`[SequenceWorker] Auto-enrolled ${enrolled} profiles for post ${postId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SequenceWorker] Auto-enroll failed for post ${postId}: ${message}`);
      throw err;
    }
  }
}

export function startSequenceWorker(): Worker<SequenceJobData> {
  const worker = new Worker<SequenceJobData>(
    QUEUE_NAMES.SEQUENCE,
    processSequenceJob,
    {
      connection: redisConnection,
      concurrency: 1, // Sequential sequence processing
    }
  );

  worker.on('completed', (job) => {
    console.log(`[SequenceWorker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(
      `[SequenceWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`
    );
  });

  worker.on('error', (err) => {
    console.error('[SequenceWorker] Worker error:', err.message);
  });

  console.log('[SequenceWorker] Started (concurrency: 1)');
  return worker;
}
