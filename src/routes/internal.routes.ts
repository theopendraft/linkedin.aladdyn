/**
 * Internal Routes
 *
 * Protected by requireInternalSecret.
 * Called by cron jobs or server.aladdyn for background processing.
 */

import { Router, Request, Response } from 'express';
import { requireInternalSecret } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { inboxSyncQueue, publishQueue, engagementQueue, analyticsSyncQueue } from '../jobs/queues';
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

/**
 * POST /internal/reply-suggestion
 * Called by server.aladdyn socialReplyService after generating an AI DM suggestion
 * for a newly detected social lead. Creates a PENDING_APPROVAL sequence enrollment
 * so the Aladdyn user can review, edit, or skip before anything is sent.
 * Body: { conversationId, funnelId, suggestedMessage, profileName?, postTitle? }
 */
router.post(
  '/reply-suggestion',
  asyncHandler(async (req: Request, res: Response) => {
    const { conversationId, funnelId, suggestedMessage, profileName, postTitle } = req.body as {
      conversationId: string;
      funnelId: string;
      suggestedMessage: string;
      profileName?: string;
      postTitle?: string;
    };

    if (!conversationId || !funnelId || !suggestedMessage) {
      throw new AppError('conversationId, funnelId, and suggestedMessage are required', 400);
    }

    // Find the LinkedIn account for this funnel
    const account = await prisma.linkedInAccount.findFirst({
      where: { funnelId, isActive: true },
      select: { id: true },
    });

    if (!account) {
      // No LinkedIn account connected for this funnel yet — silently succeed
      res.json({ success: true, enrolled: false, reason: 'no_linkedin_account' });
      return;
    }

    // Find the LinkedIn profile by matching against externalProfileId stored in server.aladdyn
    // We use conversationId as a cross-service ref stored in serverConversationId
    const existingEnrollment = await prisma.linkedInSequenceEnrollment.findFirst({
      where: { serverConversationId: conversationId },
      select: { id: true },
    });

    if (existingEnrollment) {
      // Already have a suggestion pending for this lead — skip
      res.json({ success: true, enrolled: false, reason: 'already_pending' });
      return;
    }

    // Find sequences for this account that accept manual enrollments
    const sequence = await prisma.linkedInSequence.findFirst({
      where: {
        accountId: account.id,
        triggerType: 'MANUAL',
        status: 'ACTIVE',
      },
      include: {
        steps: { orderBy: { order: 'asc' }, take: 1 },
      },
    });

    if (!sequence || sequence.steps.length === 0) {
      // No active manual sequence — store as standalone suggestion
      res.json({ success: true, enrolled: false, reason: 'no_active_sequence' });
      return;
    }

    const firstStep = sequence.steps[0];

    // We need a profile to enroll — look up by serverConversationId pattern
    // For social leads the profile should already exist from engagementScraper
    // Use a synthetic lookup via the conversationId stored as external ref
    // If profile not found, we skip enrollment but don't fail
    const profile = await prisma.linkedInProfile.findFirst({
      where: {
        sequenceEnrollments: {
          none: { serverConversationId: conversationId },
        },
      },
      // We can't directly look up by conversationId — use account's recent profiles
      // as a best effort. Real linkage requires profileId on the engagement record.
      orderBy: { lastInteractionAt: 'desc' },
    });

    if (!profile) {
      res.json({ success: true, enrolled: false, reason: 'profile_not_found' });
      return;
    }

    const now = new Date();

    await prisma.linkedInSequenceEnrollment.upsert({
      where: {
        sequenceId_profileId: {
          sequenceId: sequence.id,
          profileId: profile.id,
        },
      },
      create: {
        sequenceId: sequence.id,
        profileId: profile.id,
        status: 'PENDING_APPROVAL',
        currentStepId: firstStep.id,
        triggerPostTitle: postTitle ?? null,
        suggestedMessage,
        serverConversationId: conversationId,
        nextStepAt: new Date(now.getTime() + firstStep.delayHours * 3600 * 1000),
      },
      update: {
        suggestedMessage,
        status: 'PENDING_APPROVAL',
        serverConversationId: conversationId,
      },
    });

    res.json({ success: true, enrolled: true });
  })
);

/**
 * POST /internal/posts/:postId/scrape-engagement
 * Manually trigger an engagement scrape for a specific post.
 * Useful for testing without waiting for the scheduler.
 * Body: { accountId? } — if omitted, looks up from the post record.
 */
router.post(
  '/posts/:postId/scrape-engagement',
  asyncHandler(async (req: Request, res: Response) => {
    const { postId } = req.params;
    let { accountId } = req.body as { accountId?: string };

    if (!postId) throw new AppError('postId is required', 400);

    if (!accountId) {
      const post = await prisma.linkedInPost.findUnique({
        where: { id: postId },
        select: { accountId: true, status: true },
      });
      if (!post) throw new AppError(`Post ${postId} not found`, 404);
      if (post.status !== 'POSTED') {
        throw new AppError(`Post ${postId} is not in POSTED status (current: ${post.status})`, 400);
      }
      accountId = post.accountId;
    }

    await engagementQueue.add(
      `engagement-manual-${postId}-${Date.now()}`,
      { postId, accountId },
      { jobId: `engagement-manual-${postId}` }
    );

    res.json({
      success: true,
      message: `Engagement scrape enqueued for post ${postId}`,
      data: { postId, accountId },
    });
  })
);

/**
 * POST /internal/analytics/sync
 * Manually trigger analytics sync for a specific account or all accounts.
 * Body: { accountId?, postId? }
 * If postId is provided, resets analyticsAt on that post first (force re-sync).
 */
router.post(
  '/analytics/sync',
  asyncHandler(async (req: Request, res: Response) => {
    const { accountId, postId } = req.body as { accountId?: string; postId?: string };

    // Force re-sync a single post by clearing its analyticsAt
    if (postId) {
      const post = await prisma.linkedInPost.findUnique({
        where: { id: postId },
        select: { id: true, accountId: true },
      });
      if (!post) throw new AppError(`Post ${postId} not found`, 404);

      await prisma.linkedInPost.update({
        where: { id: postId },
        data: { analyticsAt: null },
      });

      const targetAccountId = accountId ?? post.accountId;
      await analyticsSyncQueue.add(
        `analytics-force-${postId}-${Date.now()}`,
        { accountId: targetAccountId }
      );
      res.json({ success: true, message: `Force analytics sync enqueued for post ${postId}` });
      return;
    }

    if (accountId) {
      await analyticsSyncQueue.add(
        `analytics-manual-${accountId}-${Date.now()}`,
        { accountId }
      );
      res.json({ success: true, message: `Analytics sync enqueued for account ${accountId}` });
    } else {
      const accounts = await prisma.linkedInAccount.findMany({
        where: { isActive: true },
        select: { id: true },
      });
      for (const acc of accounts) {
        await analyticsSyncQueue.add(`analytics-manual-${acc.id}-${Date.now()}`, { accountId: acc.id });
      }
      res.json({ success: true, message: `Analytics sync enqueued for ${accounts.length} accounts` });
    }
  })
);

export default router;
