/**
 * Post Controller
 *
 * Handles the full LinkedIn post lifecycle:
 * DRAFT → APPROVED → SCHEDULED/PUBLISHING → POSTED | FAILED
 *
 * Uses BullMQ publish queue for scheduled and immediate publishing.
 */

import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { publishQueue } from '../jobs/queues';
import { decrypt } from '../lib/encrypt';
import * as linkedinApi from '../services/linkedinApi';
import { scorePost } from '../services/contentScorer';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * POST /api/posts
 * Create a new post draft.
 */
export const createPost = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const {
    accountId,
    text,
    mediaUrls,
    postType,
    visibility,
    scheduledAt,
  }: {
    accountId: string;
    text: string;
    mediaUrls?: string[];
    postType?: string;
    visibility?: string;
    scheduledAt?: string;
  } = req.body;

  if (!accountId) throw new AppError('accountId is required', 400);
  if (!text || text.trim().length === 0) throw new AppError('text is required', 400);

  // Verify account belongs to user
  const account = await prisma.linkedInAccount.findFirst({
    where: { id: accountId, userId },
  });

  if (!account) throw new AppError('Account not found', 404);

  const post = await prisma.linkedInPost.create({
    data: {
      accountId,
      text: text.trim(),
      mediaUrls: mediaUrls ?? [],
      postType: postType ?? 'TEXT',
      visibility: visibility ?? 'PUBLIC',
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      status: 'DRAFT',
    },
  });

  res.status(201).json({ success: true, data: post });
});

/**
 * GET /api/posts
 * Paginated list of posts, filterable by accountId and status.
 */
export const listPosts = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const {
    accountId,
    status,
    page = '1',
    limit = String(DEFAULT_PAGE_SIZE),
  } = req.query as Record<string, string>;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limit, 10) || DEFAULT_PAGE_SIZE));
  const skip = (pageNum - 1) * limitNum;

  // Build account filter — only show posts from accounts the user owns
  const userAccounts = await prisma.linkedInAccount.findMany({
    where: {
      userId,
      ...(accountId ? { id: accountId } : {}),
    },
    select: { id: true },
  });

  const accountIds = userAccounts.map((a) => a.id);

  if (accountIds.length === 0) {
    res.json({ success: true, data: [], meta: { page: pageNum, limit: limitNum, total: 0 } });
    return;
  }

  type PostStatus = 'DRAFT' | 'APPROVED' | 'SCHEDULED' | 'PUBLISHING' | 'POSTED' | 'FAILED' | 'DELETED';

  // If a specific status is requested, use equals; otherwise exclude DELETED
  const statusFilter: { equals?: PostStatus; notIn?: PostStatus[] } = status
    ? { equals: status as PostStatus }
    : { notIn: ['DELETED' as PostStatus] };

  const where = {
    accountId: { in: accountIds },
    status: statusFilter,
  };

  const [posts, total] = await Promise.all([
    prisma.linkedInPost.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limitNum,
    }),
    prisma.linkedInPost.count({ where }),
  ]);

  res.json({
    success: true,
    data: posts,
    meta: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
  });
});

/**
 * GET /api/posts/:id
 * Get a single post.
 */
export const getPost = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const post = await prisma.linkedInPost.findFirst({
    where: { id, account: { userId } },
  });

  if (!post) throw new AppError('Post not found', 404);

  res.json({ success: true, data: post });
});

/**
 * PUT /api/posts/:id
 * Update a post — only allowed when status is DRAFT.
 */
export const updatePost = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;
  const {
    text,
    mediaUrls,
    postType,
    visibility,
    scheduledAt,
  } = req.body as {
    text?: string;
    mediaUrls?: string[];
    postType?: string;
    visibility?: string;
    scheduledAt?: string | null;
  };

  const post = await prisma.linkedInPost.findFirst({
    where: { id, account: { userId } },
  });

  if (!post) throw new AppError('Post not found', 404);
  if (post.status !== 'DRAFT') {
    throw new AppError(`Cannot edit a post with status ${post.status}. Only DRAFT posts can be edited.`, 400);
  }

  const updated = await prisma.linkedInPost.update({
    where: { id },
    data: {
      ...(text !== undefined ? { text: text.trim() } : {}),
      ...(mediaUrls !== undefined ? { mediaUrls } : {}),
      ...(postType !== undefined ? { postType } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
      ...(scheduledAt !== undefined
        ? { scheduledAt: scheduledAt ? new Date(scheduledAt) : null }
        : {}),
    },
  });

  res.json({ success: true, data: updated });
});

/**
 * DELETE /api/posts/:id
 * Soft-delete a post by setting status=DELETED.
 */
export const deletePost = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const post = await prisma.linkedInPost.findFirst({
    where: { id, account: { userId } },
  });

  if (!post) throw new AppError('Post not found', 404);

  await prisma.linkedInPost.update({
    where: { id },
    data: { status: 'DELETED' },
  });

  res.json({ success: true, message: 'Post deleted' });
});

/**
 * POST /api/posts/:id/approve
 * Transitions DRAFT → APPROVED and enqueues for publishing.
 * If scheduledAt is in the future, uses BullMQ delay.
 * If no scheduledAt, enqueues for immediate publishing.
 */
export const approvePost = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const post = await prisma.linkedInPost.findFirst({
    where: { id, account: { userId } },
    include: { account: { select: { id: true } } },
  });

  if (!post) throw new AppError('Post not found', 404);
  if (post.status !== 'DRAFT') {
    throw new AppError(`Cannot approve a post with status ${post.status}`, 400);
  }

  const now = new Date();
  const scheduledAt = post.scheduledAt;
  const isFuture = scheduledAt && scheduledAt > now;

  // Mark as APPROVED (scheduler will pick it up, or enqueue now)
  const updated = await prisma.linkedInPost.update({
    where: { id },
    data: { status: 'APPROVED' },
  });

  // Enqueue with BullMQ's native delay — no scheduler needed.
  // BullMQ holds the job in Redis and processes it at exactly the right time.
  const delay = scheduledAt ? Math.max(0, scheduledAt.getTime() - now.getTime()) : 0;

  await publishQueue.add(
    `publish:${id}`,
    { postId: id, accountId: post.account.id },
    { delay, jobId: `publish:${id}` }
  );

  const scheduled = await prisma.linkedInPost.update({
    where: { id },
    data: { status: 'SCHEDULED' },
  });

  const message = isFuture
    ? `Post approved and scheduled for ${scheduledAt!.toISOString()}`
    : 'Post approved and enqueued for publishing';

  res.json({ success: true, data: scheduled, message });
});

/**
 * POST /api/posts/:id/publish
 * Immediately publish a post (bypasses queue for real-time publishing).
 */
export const publishPost = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const post = await prisma.linkedInPost.findFirst({
    where: { id, account: { userId } },
    include: {
      account: {
        select: {
          id: true,
          linkedinId: true,
          accessToken: true,
          orgId: true,
          tokenExpiry: true,
        },
      },
    },
  });

  if (!post) throw new AppError('Post not found', 404);

  if (!['DRAFT', 'APPROVED', 'FAILED'].includes(post.status)) {
    throw new AppError(
      `Cannot publish a post with status ${post.status}. Post must be DRAFT, APPROVED, or FAILED.`,
      400
    );
  }

  if (!post.account.accessToken) {
    throw new AppError('No LinkedIn access token for this account', 400);
  }

  // Mark as PUBLISHING
  await prisma.linkedInPost.update({
    where: { id },
    data: { status: 'PUBLISHING' },
  });

  try {
    const accessToken = decrypt(post.account.accessToken);

    const result = await linkedinApi.publishPost({
      accessToken,
      linkedinUserId: post.account.linkedinId ?? '',
      text: post.text,
      mediaUrls: post.mediaUrls,
      visibility: post.visibility,
      orgId: post.account.orgId ?? undefined,
    });

    const published = await prisma.linkedInPost.update({
      where: { id },
      data: {
        status: 'POSTED',
        linkedinPostId: result.postId,
        publishedAt: new Date(),
        publishError: null,
        publishAttempts: { increment: 1 },
      },
    });

    res.json({ success: true, data: published });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await prisma.linkedInPost.update({
      where: { id },
      data: {
        status: 'FAILED',
        publishError: message,
        publishAttempts: { increment: 1 },
      },
    });

    throw new AppError(`Publishing failed: ${message}`, 502);
  }
});

/**
 * POST /api/posts/:id/score
 * Run AI content scoring on the post text and save results.
 */
export const scorePostHandler = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const post = await prisma.linkedInPost.findFirst({
    where: { id, account: { userId } },
  });

  if (!post) throw new AppError('Post not found', 404);

  const scores = await scorePost(post.text);

  const updated = await prisma.linkedInPost.update({
    where: { id },
    data: {
      hookScore: scores.hookScore,
      readabilityScore: scores.readabilityScore,
      ctaScore: scores.ctaScore,
      aiSuggestions: scores.suggestions,
    },
  });

  res.json({ success: true, data: updated });
});

/**
 * POST /api/posts/bulk-approve
 * Approve multiple draft posts at once.
 */
export const bulkApprove = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { postIds }: { postIds: string[] } = req.body;

  if (!Array.isArray(postIds) || postIds.length === 0) {
    throw new AppError('postIds array is required', 400);
  }

  // Verify all posts belong to user's accounts
  const posts = await prisma.linkedInPost.findMany({
    where: {
      id: { in: postIds },
      status: 'DRAFT',
      account: { userId },
    },
    select: { id: true },
  });

  const validIds = posts.map((p) => p.id);

  const result = await prisma.linkedInPost.updateMany({
    where: { id: { in: validIds } },
    data: { status: 'APPROVED' },
  });

  res.json({
    success: true,
    data: {
      approved: result.count,
      requested: postIds.length,
      skipped: postIds.length - result.count,
    },
  });
});

/**
 * GET /api/posts/analytics/summary
 * Aggregate analytics for all posted content on an account.
 */
export const analyticsSummary = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { accountId } = req.query as Record<string, string>;

    if (!accountId) throw new AppError('accountId query param is required', 400);

    // Verify account ownership
    const account = await prisma.linkedInAccount.findFirst({
      where: { id: accountId, userId },
      select: { id: true },
    });
    if (!account) throw new AppError('Account not found', 404);

    const posts = await prisma.linkedInPost.findMany({
      where: { accountId, status: 'POSTED' },
      select: {
        impressions: true,
        clicks: true,
        reactions: true,
        comments: true,
        shares: true,
        engagementRate: true,
        publishedAt: true,
      },
    });

    const summary = {
      totalPosts: posts.length,
      impressions: posts.reduce((s, p) => s + (p.impressions ?? 0), 0),
      clicks: posts.reduce((s, p) => s + (p.clicks ?? 0), 0),
      reactions: posts.reduce((s, p) => s + (p.reactions ?? 0), 0),
      comments: posts.reduce((s, p) => s + (p.comments ?? 0), 0),
      shares: posts.reduce((s, p) => s + (p.shares ?? 0), 0),
      avgEngagementRate:
        posts.length > 0
          ? posts.reduce((s, p) => s + (p.engagementRate ?? 0), 0) /
            posts.length
          : 0,
      lastPublishedAt:
        posts.length > 0
          ? posts.sort(
              (a, b) =>
                (b.publishedAt?.getTime() ?? 0) -
                (a.publishedAt?.getTime() ?? 0)
            )[0]?.publishedAt
          : null,
    };

    res.json({ success: true, data: summary });
  }
);
