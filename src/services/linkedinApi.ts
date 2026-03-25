/**
 * LinkedIn Marketing API Service
 *
 * Wraps the LinkedIn v2 REST API for:
 * - Profile fetch
 * - Token refresh
 * - UGC post publishing
 * - Post analytics retrieval
 *
 * Base URL: https://api.linkedin.com/v2
 */

import axios, { AxiosError } from 'axios';

const BASE_URL = 'https://api.linkedin.com/v2';

export interface LinkedInProfile {
  id: string;
  displayName: string;
  headline: string;
  profileUrl: string;
}

export interface TokenRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface PublishPostResult {
  postId: string;
}

export interface PostAnalytics {
  impressions: number;
  clicks: number;
  reactions: number;
  comments: number;
  shares: number;
}

/**
 * Fetches the authenticated user's LinkedIn profile.
 */
export async function getProfile(accessToken: string): Promise<LinkedInProfile> {
  try {
    // /v2/userinfo is the OIDC endpoint — works with openid + profile scopes.
    // The legacy /v2/me endpoint requires r_liteprofile which is not granted
    // by the "Sign In with LinkedIn using OpenID Connect" product.
    const res = await axios.get('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data = res.data;
    // sub is the stable member identifier (may be "urn:li:person:XXX" or plain ID)
    const sub: string = data.sub ?? '';
    const id = sub.startsWith('urn:li:person:') ? sub.split(':').pop()! : sub;
    const displayName: string = data.name ?? `${data.given_name ?? ''} ${data.family_name ?? ''}`.trim();

    return {
      id,
      displayName,
      headline: '',
      profileUrl: `https://www.linkedin.com/in/${id}`,
    };
  } catch (err) {
    const message = extractApiError(err);
    throw new Error(`Failed to fetch LinkedIn profile: ${message}`);
  }
}

/**
 * Refreshes an expired access token using the refresh token.
 * LinkedIn refresh tokens are valid for 365 days.
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<TokenRefreshResult> {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET are required');
  }

  try {
    const res = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    return {
      accessToken: res.data.access_token,
      refreshToken: res.data.refresh_token ?? refreshToken, // LinkedIn may not rotate
      expiresIn: res.data.expires_in ?? 5183944, // ~60 days
    };
  } catch (err) {
    const message = extractApiError(err);
    throw new Error(`Failed to refresh LinkedIn access token: ${message}`);
  }
}

/**
 * Publishes a UGC post to LinkedIn.
 *
 * Posts as an organization (company page) when orgId is provided,
 * otherwise posts as a personal profile.
 */
export async function publishPost(params: {
  accessToken: string;
  linkedinUserId: string; // LinkedIn member URN
  text: string;
  mediaUrls?: string[];
  visibility?: string;
  orgId?: string;
}): Promise<PublishPostResult> {
  const { accessToken, linkedinUserId, text, visibility = 'PUBLIC', orgId } = params;

  const author = orgId
    ? `urn:li:organization:${orgId.replace(/^urn:li:organization:/, '')}`
    : `urn:li:person:${linkedinUserId}`;

  const body: Record<string, unknown> = {
    author,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': visibility,
    },
  };

  try {
    const res = await axios.post(`${BASE_URL}/ugcPosts`, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
    });

    // LinkedIn returns the post URN in the x-restli-id header or in the body
    const postId: string =
      res.headers['x-restli-id'] ?? res.data.id ?? res.data['id'] ?? '';

    return { postId };
  } catch (err) {
    const message = extractApiError(err);
    throw new Error(`Failed to publish LinkedIn post: ${message}`);
  }
}

/**
 * Fetches post-level analytics for a specific LinkedIn post.
 * Uses the Organization Share Statistics API.
 */
export async function getPostAnalytics(params: {
  accessToken: string;
  linkedinPostId: string;
}): Promise<PostAnalytics> {
  const { accessToken, linkedinPostId } = params;

  try {
    // Encode the URN for use as a query param
    const encodedShare = encodeURIComponent(linkedinPostId);

    const res = await axios.get(
      `${BASE_URL}/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodedShare}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'LinkedIn-Version': '202401',
        },
      }
    );

    const element = res.data?.elements?.[0]?.totalShareStatistics ?? {};

    return {
      impressions: element.impressionCount ?? 0,
      clicks: element.clickCount ?? 0,
      reactions: element.likeCount ?? 0,
      comments: element.commentCount ?? 0,
      shares: element.shareCount ?? 0,
    };
  } catch (err) {
    const message = extractApiError(err);
    throw new Error(`Failed to fetch LinkedIn post analytics: ${message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractApiError(err: unknown): string {
  if (err instanceof AxiosError) {
    const data = err.response?.data;
    if (data && typeof data === 'object') {
      return (
        (data as Record<string, unknown>)['message']?.toString() ??
          (data as Record<string, unknown>)['error']?.toString() ??
          JSON.stringify(data)
      );
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
