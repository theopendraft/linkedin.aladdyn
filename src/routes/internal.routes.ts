/**
 * Internal Routes
 *
 * Protected by requireInternalSecret.
 * Called by cron jobs or server.aladdyn for background processing.
 */

import { Router, Request, Response } from 'express';
import { requireInternalSecret } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { inboxSyncQueue, publishQueue } from '../jobs/queues';
import prisma from '../lib/prisma';

const router = Router();

// All internal routes require x-internal-secret header
router.use(requireInternalSecret);

/**
 * POST /internal/inbox/process-replies
 * Trigger auto-reply processing for a specific account or all eligible accounts.
 * Body: { accountId?: string }
 */
router.post(
  '/inbox/process-replies',
  asyncHandler(async (req: Request, res: Response) => {
    const { accountId } = req.body as { accountId?: string };

    if (accountId) {
      // Single account
      await inboxSyncQueue.add(
        `inbox-sync-${accountId}-${Date.now()}`,
        { accountId, triggerAutoReply: true }
      );

      res.json({
        success: true,
        message: `Inbox sync + auto-reply enqueued for account ${accountId}`,
      });
    } else {
      // All eligible accounts
      const accounts = await prisma.linkedInAccount.findMany({
        where: {
          autoReplyEnabled: true,
          sessionValid: true,
          isActive: true,
        },
        select: { id: true },
      });

      for (const account of accounts) {
        await inboxSyncQueue.add(
          `inbox-sync-${account.id}-${Date.now()}`,
          { accountId: account.id, triggerAutoReply: true }
        );
      }

      res.json({
        success: true,
        message: `Inbox sync + auto-reply enqueued for ${accounts.length} accounts`,
        data: { accountCount: accounts.length },
      });
    }
  })
);

/**
 * POST /internal/posts/publish-due
 * Trigger immediate publish-due check (same logic as scheduler tick).
 * Useful for testing or manual triggers from admin tooling.
 */
router.post(
  '/posts/publish-due',
  asyncHandler(async (req: Request, res: Response) => {
    const now = new Date();
    const lookahead = new Date(now.getTime() + 5 * 60 * 1000);

    const posts = await prisma.linkedInPost.findMany({
      where: {
        status: 'APPROVED',
        scheduledAt: { lte: lookahead },
      },
      include: { account: { select: { id: true } } },
      take: 50,
    });

    let enqueued = 0;

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

      enqueued++;
    }

    res.json({
      success: true,
      message: `Enqueued ${enqueued} posts for publishing`,
      data: { enqueued },
    });
  })
);

/**
 * POST /internal/posts/create-from-social
 * Called by Social_Scene when it has a LinkedIn post ready to publish.
 * Looks up the LinkedInAccount by funnelId, creates a LinkedInPost, and
 * either enqueues it immediately or leaves it for the scheduler.
 * Body: { funnelId, text, imageUrls?, scheduledAt?, socialPostId? }
 */
router.post(
  '/posts/create-from-social',
  asyncHandler(async (req: Request, res: Response) => {
    const {
      funnelId,
      text,
      imageUrls,
      scheduledAt,
    } = req.body as {
      funnelId: string;
      text: string;
      imageUrls?: string[];
      scheduledAt?: string;
    };

    if (!funnelId || !text) {
      throw new AppError('funnelId and text are required', 400);
    }

    const account = await prisma.linkedInAccount.findFirst({
      where: { funnelId, isActive: true },
      select: { id: true },
    });

    if (!account) {
      throw new AppError(
        `No active LinkedIn account found for funnelId ${funnelId}. Connect LinkedIn first.`,
        404
      );
    }

    const scheduledAtDate = scheduledAt ? new Date(scheduledAt) : null;
    const isImmediate = !scheduledAtDate || scheduledAtDate <= new Date();

    const post = await prisma.linkedInPost.create({
      data: {
        accountId: account.id,
        text,
        mediaUrls: imageUrls ?? [],
        postType: (imageUrls?.length ?? 0) > 0 ? 'IMAGE' : 'TEXT',
        scheduledAt: scheduledAtDate,
        status: 'APPROVED',
      },
      select: { id: true },
    });

    if (isImmediate) {
      await prisma.linkedInPost.update({
        where: { id: post.id },
        data: { status: 'SCHEDULED' },
      });

      await publishQueue.add(
        `publish-${post.id}`,
        { postId: post.id, accountId: account.id },
        { jobId: `publish-${post.id}` }
      );
    }

    res.json({
      success: true,
      data: { postId: post.id, status: isImmediate ? 'SCHEDULED' : 'APPROVED' },
    });
  })
);

export default router;
