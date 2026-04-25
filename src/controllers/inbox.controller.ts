/**
 * Inbox Controller
 *
 * Manages LinkedIn DM conversations:
 * - List conversations
 * - Read thread + messages
 * - Send manual replies
 * - Toggle per-conversation auto-reply
 * - Trigger inbox sync
 */

import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { syncInbox, sendDM } from '../services/inboxReader';

/**
 * GET /api/inbox
 * List conversations for an account (newest first).
 */
export const listConversations = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { accountId, page = '1', limit = '20' } = req.query as Record<string, string>;

  if (!accountId) throw new AppError('accountId query param is required', 400);

  // Verify account ownership
  const account = await prisma.linkedInAccount.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  });

  if (!account) throw new AppError('Account not found', 404);

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const [conversations, total] = await Promise.all([
    prisma.linkedInConversation.findMany({
      where: { accountId },
      orderBy: { lastMessageAt: 'desc' },
      skip,
      take: limitNum,
      select: {
        id: true,
        accountId: true,
        participantLinkedInId: true,
        participantName: true,
        participantHeadline: true,
        participantProfileUrl: true,
        lastMessageAt: true,
        lastMessageSnippet: true,
        unreadCount: true,
        autoReplyEnabled: true,
        lastAutoReplyAt: true,
        autoReplyCount: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.linkedInConversation.count({ where: { accountId } }),
  ]);

  res.json({
    success: true,
    data: conversations,
    meta: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
  });
});

/**
 * GET /api/inbox/:conversationId
 * Get a conversation with its messages (chronological order).
 */
export const getConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { conversationId } = req.params;
  const { page = '1', limit = '50' } = req.query as Record<string, string>;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const skip = (pageNum - 1) * limitNum;

  const conversation = await prisma.linkedInConversation.findFirst({
    where: { id: conversationId, account: { userId } },
    select: {
      id: true,
      accountId: true,
      participantLinkedInId: true,
      participantName: true,
      participantHeadline: true,
      participantProfileUrl: true,
      lastMessageAt: true,
      lastMessageSnippet: true,
      unreadCount: true,
      autoReplyEnabled: true,
      lastAutoReplyAt: true,
      autoReplyCount: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!conversation) throw new AppError('Conversation not found', 404);

  const [messages, total] = await Promise.all([
    prisma.linkedInMessage.findMany({
      where: { conversationId },
      orderBy: { sentAt: 'asc' },
      skip,
      take: limitNum,
    }),
    prisma.linkedInMessage.count({ where: { conversationId } }),
  ]);

  // Mark as read
  if (conversation.unreadCount > 0) {
    await prisma.linkedInConversation.update({
      where: { id: conversationId },
      data: { unreadCount: 0 },
    });
  }

  res.json({
    success: true,
    data: { conversation, messages },
    meta: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
  });
});

/**
 * POST /api/inbox/:conversationId/reply
 * Send a manual reply to a conversation.
 */
export const sendReply = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { conversationId } = req.params;
  const { message }: { message: string } = req.body;

  if (!message || message.trim().length === 0) {
    throw new AppError('message is required', 400);
  }

  const conversation = await prisma.linkedInConversation.findFirst({
    where: { id: conversationId, account: { userId } },
    select: {
      id: true,
      accountId: true,
      participantLinkedInId: true,
      account: {
        select: {
          dailyActionCount: true,
          dailyActionLimit: true,
          dailyActionReset: true,
        },
      },
    },
  });

  if (!conversation) throw new AppError('Conversation not found', 404);

  // Check daily limit
  const account = conversation.account;
  const now = new Date();
  const resetTime = account.dailyActionReset;

  let currentCount = account.dailyActionCount;
  if (!resetTime || resetTime < now) {
    currentCount = 0;
    await prisma.linkedInAccount.update({
      where: { id: conversation.accountId },
      data: {
        dailyActionCount: 0,
        dailyActionReset: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      },
    });
  }

  if (currentCount >= account.dailyActionLimit) {
    throw new AppError(
      `Daily action limit (${account.dailyActionLimit}) reached for this account`,
      429
    );
  }

  // Send via browser session
  await sendDM({
    accountId: conversation.accountId,
    participantLinkedInId: conversation.participantLinkedInId,
    message: message.trim(),
  });

  // Save message to DB
  const savedMessage = await prisma.linkedInMessage.create({
    data: {
      conversationId,
      direction: 'OUTBOUND',
      content: message.trim(),
      sentAt: new Date(),
      isAutoReply: false,
    },
  });

  // Update conversation snippet
  await prisma.linkedInConversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: savedMessage.sentAt,
      lastMessageSnippet: message.trim().slice(0, 200),
    },
  });

  res.json({ success: true, data: savedMessage });
});

/**
 * PUT /api/inbox/:conversationId/auto-reply
 * Toggle per-conversation auto-reply on/off.
 */
export const toggleConversationAutoReply = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { conversationId } = req.params;
    const { autoReplyEnabled }: { autoReplyEnabled: boolean } = req.body;

    if (typeof autoReplyEnabled !== 'boolean') {
      throw new AppError('autoReplyEnabled (boolean) is required', 400);
    }

    const conversation = await prisma.linkedInConversation.findFirst({
      where: { id: conversationId, account: { userId } },
    });

    if (!conversation) throw new AppError('Conversation not found', 404);

    const updated = await prisma.linkedInConversation.update({
      where: { id: conversationId },
      data: { autoReplyEnabled },
      select: {
        id: true,
        autoReplyEnabled: true,
        participantName: true,
        updatedAt: true,
      },
    });

    res.json({ success: true, data: updated });
  }
);

/**
 * POST /api/inbox/sync
 * Trigger a manual inbox sync for an account.
 */
export const triggerSync = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { accountId }: { accountId: string } = req.body;

  if (!accountId) throw new AppError('accountId is required', 400);

  const account = await prisma.linkedInAccount.findFirst({
    where: { id: accountId, userId },
    select: { id: true, sessionValid: true },
  });

  if (!account) throw new AppError('Account not found', 404);

  if (!account.sessionValid) {
    throw new AppError(
      'No valid browser session for this account. Please reconnect.',
      400
    );
  }

  // Run sync asynchronously — don't block the HTTP response
  syncInbox(accountId).catch((err) => {
    console.error(
      `[InboxController] Background sync failed for account ${accountId}:`,
      err instanceof Error ? err.message : String(err)
    );
  });

  res.json({
    success: true,
    message: 'Inbox sync started. This may take a moment.',
  });
});

/**
 * GET /api/inbox/pending-dms
 * List all PENDING_APPROVAL sequence enrollments for accounts owned by this user.
 * Used to display AI-suggested DMs awaiting human approval in the dashboard.
 */
export const listPendingDMs = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { accountId } = req.query as Record<string, string>;

  const accountFilter = accountId
    ? { accountId, userId }
    : { userId };

  const enrollments = await prisma.linkedInSequenceEnrollment.findMany({
    where: {
      status: 'PENDING_APPROVAL',
      sequence: {
        account: accountFilter,
      },
    },
    include: {
      profile: {
        select: {
          id: true,
          linkedinId: true,
          displayName: true,
          headline: true,
          company: true,
          jobTitle: true,
          profileUrl: true,
          avatarUrl: true,
        },
      },
      sequence: {
        select: {
          id: true,
          name: true,
          accountId: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  res.json({ success: true, data: enrollments });
});

/**
 * POST /api/inbox/enrollment/:enrollmentId/approve
 * Approve a PENDING_APPROVAL enrollment — optionally update the message — and
 * send the DM immediately via browser session.
 * Body: { message? } — if omitted, uses the AI-suggested message as-is.
 */
export const approvePendingDM = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { enrollmentId } = req.params;
  const { message: overrideMessage } = req.body as { message?: string };

  const enrollment = await prisma.linkedInSequenceEnrollment.findFirst({
    where: {
      id: enrollmentId,
      status: 'PENDING_APPROVAL',
      sequence: {
        account: { userId },
      },
    },
    include: {
      profile: { select: { linkedinId: true, displayName: true } },
      sequence: {
        include: {
          account: {
            select: {
              id: true,
              dailyActionCount: true,
              dailyActionLimit: true,
              dailyActionReset: true,
            },
          },
        },
      },
      currentStep: true,
    },
  });

  if (!enrollment) throw new AppError('Pending enrollment not found', 404);

  const messageToSend =
    overrideMessage?.trim() ||
    enrollment.suggestedMessage ||
    enrollment.currentStep?.template;

  if (!messageToSend) {
    throw new AppError('No message to send — provide a message in the request body', 400);
  }

  const account = enrollment.sequence.account;
  const now = new Date();

  // Check daily action limit
  let currentCount = account.dailyActionCount;
  if (!account.dailyActionReset || account.dailyActionReset < now) {
    currentCount = 0;
    await prisma.linkedInAccount.update({
      where: { id: account.id },
      data: {
        dailyActionCount: 0,
        dailyActionReset: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      },
    });
  }

  if (currentCount >= account.dailyActionLimit) {
    throw new AppError(`Daily action limit (${account.dailyActionLimit}) reached`, 429);
  }

  // Send via browser session
  await sendDM({
    accountId: account.id,
    participantLinkedInId: enrollment.profile.linkedinId,
    message: messageToSend,
  });

  // Advance enrollment to ACTIVE (or COMPLETED if no further steps)
  const nextStep = enrollment.currentStep
    ? await prisma.linkedInSequenceStep.findFirst({
        where: {
          sequenceId: enrollment.sequenceId,
          order: enrollment.currentStep.order + 1,
        },
      })
    : null;

  await prisma.linkedInSequenceEnrollment.update({
    where: { id: enrollmentId },
    data: {
      status: nextStep ? 'ACTIVE' : 'COMPLETED',
      suggestedMessage: messageToSend,
      lastMessageAt: now,
      ...(nextStep
        ? {
            currentStepId: nextStep.id,
            nextStepAt: new Date(now.getTime() + nextStep.delayHours * 3600 * 1000),
          }
        : { completedAt: now }),
    },
  });

  await prisma.linkedInAccount.update({
    where: { id: account.id },
    data: { dailyActionCount: { increment: 1 } },
  });

  res.json({
    success: true,
    message: `DM sent to ${enrollment.profile.displayName ?? enrollment.profile.linkedinId}`,
    data: { enrollmentId, messageSent: messageToSend },
  });
});

/**
 * POST /api/inbox/enrollment/:enrollmentId/skip
 * Dismiss a PENDING_APPROVAL enrollment without sending anything.
 */
export const skipPendingDM = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { enrollmentId } = req.params;

  const enrollment = await prisma.linkedInSequenceEnrollment.findFirst({
    where: {
      id: enrollmentId,
      status: 'PENDING_APPROVAL',
      sequence: { account: { userId } },
    },
    select: { id: true },
  });

  if (!enrollment) throw new AppError('Pending enrollment not found', 404);

  await prisma.linkedInSequenceEnrollment.update({
    where: { id: enrollmentId },
    data: { status: 'PAUSED' },
  });

  res.json({ success: true, message: 'Suggestion dismissed' });
});
