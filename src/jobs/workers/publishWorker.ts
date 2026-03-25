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

import { Worker, Job } from 'bullmq';
import prisma from '../../lib/prisma';
import { redisConnection } from '../redis';
import { QUEUE_NAMES, PublishJobData } from '../queues';
import { decrypt, encrypt } from '../../lib/encrypt';
import * as linkedinApi from '../../services/linkedinApi';

async function processPublish(job: Job<PublishJobData>): Promise<void> {
  const { postId, accountId } = job.data;
  console.log(`[PublishWorker] Processing post ${postId}`);

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

      console.log(`[PublishWorker] Token expired for account ${accountId}, refreshing...`);
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

    console.log(`[PublishWorker] Post ${postId} published successfully (LinkedIn ID: ${result.postId})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[PublishWorker] Publish failed for post ${postId}: ${message}`);

    // Mark as FAILED and record error
    await prisma.linkedInPost.update({
      where: { id: postId },
      data: {
        status: 'FAILED',
        publishError: message,
        publishAttempts: { increment: 1 },
      },
    }).catch((dbErr) => {
      console.error(`[PublishWorker] Failed to update post status to FAILED:`, dbErr);
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
    console.log(`[PublishWorker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(
      `[PublishWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`
    );
  });

  worker.on('error', (err) => {
    // Non-fatal — worker errors must not crash the server
    console.error('[PublishWorker] Worker error:', err.message);
  });

  console.log('[PublishWorker] Started (concurrency: 2)');
  return worker;
}
