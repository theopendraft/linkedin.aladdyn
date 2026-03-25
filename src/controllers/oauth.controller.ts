/**
 * OAuth Controller
 *
 * Handles the full LinkedIn OAuth 2.0 authorization code flow:
 *   1. POST /api/accounts/auth/linkedin/init  — returns the LinkedIn auth URL
 *   2. GET  /api/accounts/auth/linkedin/callback — exchanges code, saves account,
 *      redirects browser back to the frontend
 *
 * Hard constraints:
 * - Tokens encrypted before storage (never stored plaintext)
 * - State param carries userId + funnelId so callback can authenticate without
 *   a session (LinkedIn redirects directly to the backend, no Bearer header)
 */

import { Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { getProfile } from '../services/linkedinApi';
import { encrypt } from '../lib/encrypt';
import prisma from '../lib/prisma';

const LINKEDIN_AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

const SCOPES = ['openid', 'profile', 'email', 'w_member_social'].join(' ');

// ── state helpers ─────────────────────────────────────────────────────────────

function encodeState(data: object): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

function decodeState(state: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(state, 'base64url').toString('utf-8'));
  } catch {
    throw new AppError('Invalid OAuth state parameter', 400);
  }
}

// ── handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /api/accounts/auth/linkedin/init
 * Requires JWT auth. Returns the LinkedIn authorization URL — the frontend
 * does window.location.href = url to start the OAuth flow.
 */
export const initiateOAuth = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { funnelId } = req.body as { funnelId?: string };

  if (!funnelId) throw new AppError('funnelId is required', 400);

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    throw new AppError(
      'LINKEDIN_CLIENT_ID and LINKEDIN_REDIRECT_URI must be configured',
      500
    );
  }

  const state = encodeState({ userId, funnelId });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: SCOPES,
  });

  const url = `${LINKEDIN_AUTH_URL}?${params.toString()}`;

  res.json({ success: true, data: { url } });
});

/**
 * GET /api/accounts/auth/linkedin/callback
 * No JWT auth — LinkedIn calls this URL directly after the user authorises.
 * Exchanges the code, saves the account, then redirects to the frontend.
 */
export const handleOAuthCallback = async (
  req: Request,
  res: Response
): Promise<void> => {
  const frontendBase =
    process.env.FRONTEND_URL || 'http://localhost:5173';

  const redirect = (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    res.redirect(`${frontendBase}/linkedin/oauth/callback?${qs}`);
  };

  const { code, state, error, error_description } = req.query as Record<
    string,
    string
  >;

  console.log('[OAuth callback] query:', JSON.stringify({ code: code ? '***' : undefined, state, error, error_description }));

  if (error) {
    console.error('[OAuth callback] LinkedIn returned error:', error, error_description);
    redirect({ error: error_description || error });
    return;
  }

  if (!code || !state) {
    redirect({ error: 'missing_code' });
    return;
  }

  // Decode state
  let userId: string;
  let funnelId: string;
  try {
    const decoded = decodeState(state) as { userId?: string; funnelId?: string };
    if (!decoded.userId || !decoded.funnelId) throw new Error();
    userId = decoded.userId;
    funnelId = decoded.funnelId;
  } catch {
    redirect({ error: 'invalid_state' });
    return;
  }

  // Exchange code for tokens
  const clientId = process.env.LINKEDIN_CLIENT_ID!;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET!;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI!;

  let accessToken: string;
  let refreshToken: string | undefined;
  let expiresIn: number;

  try {
    const tokenRes = await fetch(LINKEDIN_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('[OAuth] Token exchange failed:', errText);
      redirect({ error: 'token_exchange_failed' });
      return;
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;
    expiresIn = tokens.expires_in;
  } catch (err) {
    console.error('[OAuth] Token exchange error:', err);
    redirect({ error: 'token_exchange_failed' });
    return;
  }

  // Fetch LinkedIn profile to get linkedinId + display info
  let profile: {
    id: string;
    displayName: string;
    headline: string;
    profileUrl: string;
  };
  try {
    profile = await getProfile(accessToken);
  } catch (err) {
    console.error('[OAuth] Profile fetch failed:', err);
    redirect({ error: 'profile_fetch_failed' });
    return;
  }

  // Upsert account
  const tokenExpiry = new Date(Date.now() + expiresIn * 1000);

  try {
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
      },
      select: { id: true, displayName: true },
    });

    redirect({
      connected: 'true',
      accountId: account.id,
      funnelId,
      name: account.displayName ?? '',
    });
  } catch (err) {
    console.error('[OAuth] Failed to save account:', err);
    redirect({ error: 'save_failed' });
  }
};
