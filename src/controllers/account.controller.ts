/**
 * Account Controller
 *
 * Handles LinkedIn account connection (OAuth tokens + browser sessions),
 * listing, disconnecting, and auto-reply configuration.
 *
 * Hard constraints:
 * - Never expose accessToken, refreshToken, or sessionCookies in any response
 * - All tokens stored encrypted via encrypt()
 */

import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { encrypt, decrypt } from '../lib/encrypt';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { getProfile, refreshAccessToken } from '../services/linkedinApi';
import { launchLinkedInLogin, getLaunchStatus } from '../services/sessionLauncher';
import { startMessageWatcher, stopMessageWatcher } from '../services/messageWatcher';
import { syncAnalyticsForAccount } from '../services/analyticsSyncService';

// Fields always excluded from account responses
const SAFE_ACCOUNT_SELECT = {
  id: true,
  userId: true,
  funnelId: true,
  linkedinId: true,
  displayName: true,
  headline: true,
  profileUrl: true,
  orgId: true,
  tokenExpiry: true,
  sessionValid: true,
  lastSessionAt: true,
  autoReplyEnabled: true,
  replySystemPrompt: true,
  dailyActionLimit: true,
  dailyActionCount: true,
  dailyActionReset: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  // Excluded: accessToken, refreshToken, sessionCookies
} as const;

/**
 * POST /api/accounts/connect/oauth
 * Save OAuth tokens after the user completes LinkedIn OAuth.
 */
export const connectOAuth = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const {
    funnelId,
    accessToken,
    refreshToken,
    expiresIn,
    orgId,
  }: {
    funnelId: string;
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    orgId?: string;
  } = req.body;

  if (!funnelId || !accessToken) {
    throw new AppError('funnelId and accessToken are required', 400);
  }

  // Fetch LinkedIn profile with the provided token
  let profile: { id: string; displayName: string; headline: string; profileUrl: string };
  try {
    profile = await getProfile(accessToken);
  } catch (err) {
    throw new AppError(
      `Failed to fetch LinkedIn profile: ${err instanceof Error ? err.message : 'Unknown error'}`,
      400
    );
  }

  const tokenExpiry = expiresIn
    ? new Date(Date.now() + expiresIn * 1000)
    : new Date(Date.now() + 5183944 * 1000); // 60 days default

  // Upsert account — one LinkedIn identity per user/funnel
  const account = await prisma.linkedInAccount.upsert({
    where: { linkedinId: profile.id },
    create: {
      userId,
      funnelId,
      accessToken: encrypt(accessToken),
      refreshToken: refreshToken ? encrypt(refreshToken) : null,
      tokenExpiry,
      linkedinId: profile.id,
      displayName: profile.displayName,
      headline: profile.headline,
      profileUrl: profile.profileUrl,
      orgId: orgId ?? null,
    },
    update: {
      userId,
      funnelId,
      accessToken: encrypt(accessToken),
      refreshToken: refreshToken ? encrypt(refreshToken) : undefined,
      tokenExpiry,
      displayName: profile.displayName,
      headline: profile.headline,
      profileUrl: profile.profileUrl,
      orgId: orgId ?? undefined,
    },
    select: SAFE_ACCOUNT_SELECT,
  });

  res.status(200).json({ success: true, data: account });
});

/**
 * POST /api/accounts/connect/session
 * Save browser session cookies after a Playwright login flow.
 */
export const connectSession = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { accountId, cookies }: { accountId: string; cookies: string } = req.body;

  if (!accountId || !cookies) {
    throw new AppError('accountId and cookies are required', 400);
  }

  // Validate the cookies are parseable JSON before encrypting
  try {
    JSON.parse(cookies);
  } catch {
    throw new AppError('cookies must be a valid JSON string', 400);
  }

  // Verify account belongs to this user
  const existing = await prisma.linkedInAccount.findFirst({
    where: { id: accountId, userId },
  });

  if (!existing) {
    throw new AppError('Account not found', 404);
  }

  const account = await prisma.linkedInAccount.update({
    where: { id: accountId },
    data: {
      sessionCookies: encrypt(cookies),
      sessionValid: true,
      lastSessionAt: new Date(),
    },
    select: SAFE_ACCOUNT_SELECT,
  });

  // Start realtime message watcher now that a valid session exists
  startMessageWatcher(accountId).catch(() => {});

  res.status(200).json({ success: true, data: account });
});

/**
 * GET /api/accounts
 * List all LinkedIn accounts for the authenticated user.
 */
export const listAccounts = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;

  const accounts = await prisma.linkedInAccount.findMany({
    where: { userId, isActive: true },
    select: SAFE_ACCOUNT_SELECT,
    orderBy: { createdAt: 'desc' },
  });

  res.json({ success: true, data: accounts });
});

/**
 * GET /api/accounts/:id
 * Get a single account (safe fields only).
 */
export const getAccount = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const account = await prisma.linkedInAccount.findFirst({
    where: { id, userId },
    select: SAFE_ACCOUNT_SELECT,
  });

  if (!account) {
    throw new AppError('Account not found', 404);
  }

  res.json({ success: true, data: account });
});

/**
 * DELETE /api/accounts/:id
 * Disconnect a LinkedIn account and delete all related data.
 */
export const disconnectAccount = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const account = await prisma.linkedInAccount.findFirst({
    where: { id, userId },
  });

  if (!account) {
    throw new AppError('Account not found', 404);
  }

  // Stop realtime watcher before deleting
  await stopMessageWatcher(id).catch(() => {});

  // Cascade delete — posts and conversations deleted via Prisma cascade
  await prisma.linkedInAccount.delete({ where: { id } });

  res.json({ success: true, message: 'Account disconnected and all data deleted' });
});

/**
 * PUT /api/accounts/:id/auto-reply
 * Enable/disable auto-reply and optionally update the system prompt.
 */
export const toggleAutoReply = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;
  const {
    autoReplyEnabled,
    replySystemPrompt,
  }: { autoReplyEnabled: boolean; replySystemPrompt?: string } = req.body;

  if (typeof autoReplyEnabled !== 'boolean') {
    throw new AppError('autoReplyEnabled (boolean) is required', 400);
  }

  const existing = await prisma.linkedInAccount.findFirst({
    where: { id, userId },
  });

  if (!existing) {
    throw new AppError('Account not found', 404);
  }

  const DEFAULT_REPLY_PROMPT =
    'Reply only to genuine business enquiries. Skip cold sales pitches, marketing messages, and connection milestone notifications. For greetings like "Hello" or "Hi", respond warmly and ask how you can help. Keep replies concise and professional.';

  // When turning auto-reply on for the first time with no instructions set,
  // seed a sensible default so genie behaves correctly out of the box.
  const resolvedPrompt =
    replySystemPrompt !== undefined
      ? replySystemPrompt
      : existing.replySystemPrompt ?? (autoReplyEnabled ? DEFAULT_REPLY_PROMPT : null);

  const account = await prisma.linkedInAccount.update({
    where: { id },
    data: {
      autoReplyEnabled,
      replySystemPrompt: resolvedPrompt,
    },
    select: SAFE_ACCOUNT_SELECT,
  });

  // Start or stop the realtime watcher to match the new setting
  if (autoReplyEnabled) {
    startMessageWatcher(id).catch(() => {});
  } else {
    stopMessageWatcher(id).catch(() => {});
  }

  res.json({ success: true, data: account });
});

/**
 * POST /api/accounts/connect/session/launch
 * Launches a headed browser so the user can log into LinkedIn manually.
 * Cookies are captured automatically on successful login.
 * Returns a sessionId the client can poll for status.
 */
export const launchSessionConnect = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { accountId }: { accountId: string } = req.body;

  if (!accountId) {
    throw new AppError('accountId is required', 400);
  }

  // Verify account belongs to this user
  const existing = await prisma.linkedInAccount.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError('Account not found', 404);
  }

  const sessionId = await launchLinkedInLogin(accountId);

  res.json({ success: true, data: { sessionId } });
});

/**
 * GET /api/accounts/connect/session/status/:sessionId
 * Returns the current status of a headed login session.
 * status: 'waiting' | 'success' | 'error'
 */
export const sessionConnectStatus = asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const state = getLaunchStatus(sessionId);

  if (!state) {
    throw new AppError('Session not found or expired', 404);
  }

  res.json({ success: true, data: state });
});

/**
 * POST /api/accounts/:id/refresh-token
 * Manually trigger a token refresh for an account.
 */
export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;

  const account = await prisma.linkedInAccount.findFirst({
    where: { id, userId },
    select: {
      id: true,
      refreshToken: true,
    },
  });

  if (!account || !account.refreshToken) {
    throw new AppError(
      'Account not found or no refresh token available',
      404
    );
  }

  let decryptedRefreshToken: string;
  try {
    decryptedRefreshToken = decrypt(account.refreshToken);
  } catch {
    throw new AppError('Stored refresh token is corrupted', 500);
  }

  const result = await refreshAccessToken(decryptedRefreshToken);

  const tokenExpiry = new Date(Date.now() + result.expiresIn * 1000);

  await prisma.linkedInAccount.update({
    where: { id },
    data: {
      accessToken: encrypt(result.accessToken),
      refreshToken: encrypt(result.refreshToken),
      tokenExpiry,
    },
  });

  res.json({
    success: true,
    data: { tokenExpiry, message: 'Token refreshed successfully' },
  });
});

/**
 * POST /api/accounts/:id/analytics/sync
 * Trigger an on-demand analytics sync for all POSTED posts on this account.
 * Runs in the background — returns immediately so the UI stays responsive.
 */
export const triggerAnalyticsSync = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { id } = req.params;

    const account = await prisma.linkedInAccount.findFirst({
      where: { id, userId },
      select: { id: true },
    });

    if (!account) throw new AppError('Account not found', 404);

    // Fire and forget — analytics sync can take up to ~30s for large accounts
    syncAnalyticsForAccount(id).catch((err) => {
      console.error(
        `[AnalyticsSync] On-demand sync error for account ${id}:`,
        err instanceof Error ? err.message : String(err)
      );
    });

    res.json({
      success: true,
      data: { message: 'Analytics sync started — refresh in ~30 seconds' },
    });
  }
);

/**
 * GET /api/accounts/:id/status
 * Returns real-time connection health: token validity + session validity.
 * Computed fields so the frontend always has accurate state.
 */
export const getAccountStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { id } = req.params;

    const account = await prisma.linkedInAccount.findFirst({
      where: { id, userId },
      select: {
        id: true,
        tokenExpiry: true,
        sessionValid: true,
        lastSessionAt: true,
        refreshToken: true,
        dailyActionCount: true,
        dailyActionLimit: true,
        dailyActionReset: true,
      },
    });

    if (!account) throw new AppError('Account not found', 404);

    const now = new Date();
    const isTokenExpired = account.tokenExpiry
      ? account.tokenExpiry < now
      : true; // no expiry stored → treat as expired
    const canRefreshToken = !!account.refreshToken;

    res.json({
      success: true,
      data: {
        accountId: id,
        isTokenExpired,
        tokenExpiry: account.tokenExpiry,
        canRefreshToken,
        sessionValid: account.sessionValid,
        lastSessionAt: account.lastSessionAt,
        dailyActionCount: account.dailyActionCount,
        dailyActionLimit: account.dailyActionLimit,
      },
    });
  }
);
