/**
 * Publish Worker
 *
 * Processes jobs from the linkedin-publish queue:
 * 1. Mark post as PUBLISHING
 * 2. Load account + decrypt access token
 * 3. Refresh token if expired
 * 4. Call linkedinApi.publishPost()
 * 5. On success: POSTED + save linkedinPostId
 * 6. On failure: FAILED + save error + increment attempts
 *
 * Errors are re-thrown so BullMQ handles retries per queue config.
 * Failures are fully isolated — never affect other services.
 */

import { Worker, Job, UnrecoverableError } from 'bullmq';
import prisma from '../../lib/prisma';
import { redisConnection } from '../redis';
import { QUEUE_NAMES, PublishJobData } from '../queues';
import { decrypt, encrypt } from '../../lib/encrypt';
import * as linkedinApi from '../../services/linkedinApi';
import { createLogger } from '../../utils/logger';

const logger = createLogger({ service: 'linkedin-publish-worker' });

const DAILY_POST_LIMIT = 5; // LinkedIn API guideline: avoid more than 5 posts/day/account

async function processPublish(job: Job<PublishJobData>): Promise<void> {
  const { postId, accountId } = job.data;
  logger.info('Processing post', { postId, accountId });

  // Check daily post limit before locking the post as PUBLISHING
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const postsToday = await prisma.linkedInPost.count({
    where: {
      accountId,
      status: 'POSTED',
      publishedAt: { gte: today },
    },
  });

  if (postsToday >= DAILY_POST_LIMIT) {
    // Reset back to APPROVED and move scheduledAt forward 24h so the scheduler
    // re-enqueues it tomorrow without immediate re-processing.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await prisma.linkedInPost.update({
      where: { id: postId },
      data: { status: 'APPROVED', scheduledAt: tomorrow },
    });
    logger.warn('Daily post limit reached — rescheduled', { postId, accountId, rescheduledTo: tomorrow.toISOString(), limit: String(DAILY_POST_LIMIT) });
    // UnrecoverableError prevents BullMQ retries — post is safely reset above
    throw new UnrecoverableError(
      `Daily post limit (${DAILY_POST_LIMIT}) reached for account ${accountId}`
    );
  }

  // Mark as PUBLISHING to prevent duplicate processing
  await prisma.linkedInPost.update({
    where: { id: postId },
    data: { status: 'PUBLISHING' },
  });

  let account: {
    id: string;
    linkedinId: string | null;
    accessToken: string | null;
    refreshToken: string | null;
    tokenExpiry: Date | null;
    orgId: string | null;
  } | null = null;

  let post: {
    text: string;
    mediaUrls: string[];
    visibility: string;
    postType: string;
  } | null = null;

  try {
    // Load account and post
    [account, post] = await Promise.all([
      prisma.linkedInAccount.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          linkedinId: true,
          accessToken: true,
          refreshToken: true,
          tokenExpiry: true,
          orgId: true,
        },
      }),
      prisma.linkedInPost.findUnique({
        where: { id: postId },
        select: {
          text: true,
          mediaUrls: true,
          visibility: true,
          postType: true,
        },
      }),
    ]);

    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    if (!post) {
      throw new Error(`Post ${postId} not found`);
    }

    if (!account.accessToken) {
      throw new Error(`No access token for account ${accountId}`);
    }

    let accessToken = decrypt(account.accessToken);

    // Check token expiry and refresh if needed
    const now = new Date();
    if (account.tokenExpiry && account.tokenExpiry <= now) {
      if (!account.refreshToken) {
        throw new Error(`Access token expired and no refresh token available for account ${accountId}`);
      }

      logger.info('Token expired, refreshing', { accountId });
      const decryptedRefresh = decrypt(account.refreshToken);
      const refreshed = await linkedinApi.refreshAccessToken(decryptedRefresh);

      // Persist refreshed tokens
      await prisma.linkedInAccount.update({
        where: { id: accountId },
        data: {
          accessToken: encrypt(refreshed.accessToken),
          refreshToken: encrypt(refreshed.refreshToken),
          tokenExpiry: new Date(Date.now() + refreshed.expiresIn * 1000),
        },
      });

      accessToken = refreshed.accessToken;
    }

    // Publish to LinkedIn
    const result = await linkedinApi.publishPost({
      accessToken,
      linkedinUserId: account.linkedinId ?? '',
      text: post.text,
      mediaUrls: post.mediaUrls,
      visibility: post.visibility,
      orgId: account.orgId ?? undefined,
    });

    // Success — update post record
    await prisma.linkedInPost.update({
      where: { id: postId },
      data: {
        status: 'POSTED',
        linkedinPostId: result.postId,
        publishedAt: new Date(),
        publishError: null,
        publishAttempts: { increment: 1 },
      },
    });

    logger.info('Post published successfully', { postId, linkedinPostId: result.postId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Publish failed', { postId, accountId, error: message });

    // Mark as FAILED and record error
    await prisma.linkedInPost.update({
      where: { id: postId },
      data: {
        status: 'FAILED',
        publishError: message,
        publishAttempts: { increment: 1 },
      },
    }).catch((dbErr) => {
      logger.error('Failed to update post status to FAILED', { postId, error: dbErr instanceof Error ? dbErr.message : String(dbErr) });
    });

    // Re-throw so BullMQ handles retry logic per queue backoff config
    throw err;
  }
}

export function startPublishWorker(): Worker<PublishJobData> {
  const worker = new Worker<PublishJobData>(QUEUE_NAMES.PUBLISH, processPublish, {
    connection: redisConnection,
    concurrency: 2, // Conservative — LinkedIn rate limits apply
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

  logger.info('Started', { concurrency: '2' });
  return worker;
}
