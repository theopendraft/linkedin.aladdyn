import prisma from '../lib/prisma';
import { decrypt } from '../lib/encrypt';
import {
  getPostAnalytics,
  LinkedInApiError,
  refreshAccessToken,
} from './linkedinApi';
import { aggregateCampaignAnalytics } from './campaignAnalytics';

export interface AnalyticsSyncResult {
  synced: number;
  failed: number;
  skipped: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function syncAnalyticsForAccount(
  accountId: string
): Promise<AnalyticsSyncResult> {
  const account = await prisma.linkedInAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: {
      id: true,
      accessToken: true,
      refreshToken: true,
      tokenExpiry: true,
      orgId: true,
    },
  });

  if (!account.accessToken) {
    throw new Error(`No access token found for account ${accountId}`);
  }

  let accessToken = decrypt(account.accessToken);

  // Refresh token if expired or expiring within 5 minutes
  if (
    account.tokenExpiry &&
    account.tokenExpiry.getTime() < Date.now() + 5 * 60 * 1000
  ) {
    if (!account.refreshToken) {
      throw new Error(
        `Access token is expiring and no refresh token is available for account ${accountId}`
      );
    }

    const refreshed = await refreshAccessToken(
      decrypt(account.refreshToken)
    );
    accessToken = refreshed.accessToken;
  }

  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  const sixHoursAgo  = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const oneDayAgo    = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const posts = await prisma.linkedInPost.findMany({
    where: {
      accountId,
      status: 'POSTED',
      linkedinPostId: { not: null },
      OR: [
        { analyticsAt: null },
        // Posts published in the last 24h: re-sync every 30 min to catch new reactions quickly
        {
          AND: [
            { createdAt: { gte: oneDayAgo } },
            { analyticsAt: { lt: thirtyMinAgo } },
          ],
        },
        // Older posts: 6-hour window is fine
        {
          AND: [
            { createdAt: { lt: oneDayAgo } },
            { analyticsAt: { lt: sixHoursAgo } },
          ],
        },
      ],
    },
    select: {
      id: true,
      linkedinPostId: true,
      campaignId: true,
      postAsPersonal: true,
    },
  });

  const isPersonalAccount = !account.orgId;

  if (isPersonalAccount) {
    console.log(
      `[AnalyticsSync] Account ${accountId} has no orgId — using personal post analytics (reactions/comments only)`
    );
  }

  let synced = 0;
  let failed = 0;
  let skipped = 0;

  const affectedCampaignIds = new Set<string>();

  for (const [index, post] of posts.entries()) {
    if (!post.linkedinPostId) {
      skipped++;
      continue;
    }

    // Personal account posts: aggregate from our own LinkedInEngagement rows (no API scope needed).
    // Org posts: use LinkedIn Organization Share Statistics API.
    const usePersonal = isPersonalAccount || post.postAsPersonal;

    try {
      let analytics: { impressions: number; clicks: number; reactions: number; comments: number; shares: number };

      if (usePersonal) {
        // Aggregate engagement counts from Playwright-scraped rows
        const [reactionCount, commentCount] = await Promise.all([
          prisma.linkedInEngagement.count({ where: { postId: post.id, type: 'LIKE' } }),
          prisma.linkedInEngagement.count({ where: { postId: post.id, type: 'COMMENT' } }),
        ]);
        analytics = { impressions: 0, clicks: 0, reactions: reactionCount, comments: commentCount, shares: 0 };
        console.log(`[AnalyticsSync] Personal post ${post.id}: reactions=${reactionCount} comments=${commentCount} (from scraped engagements)`);
      } else {
        analytics = await getPostAnalytics({
          accessToken,
          linkedinPostId: post.linkedinPostId,
          organizationId: account.orgId!,
        });
      }

      const engagementRate =
        analytics.impressions > 0
          ? ((analytics.reactions +
              analytics.comments +
              analytics.shares) /
              analytics.impressions) *
            100
          : 0;

      await prisma.linkedInPost.update({
        where: { id: post.id },
        data: {
          impressions: analytics.impressions,
          clicks: analytics.clicks,
          reactions: analytics.reactions,
          comments: analytics.comments,
          shares: analytics.shares,
          engagementRate,
          analyticsAt: new Date(),
        },
      });

      if (post.campaignId) {
        affectedCampaignIds.add(post.campaignId);
      }

      synced++;
    } catch (error) {
      if (error instanceof LinkedInApiError && error.isPermissionError && !usePersonal) {
        // Org analytics permission error — skip all remaining posts for this account
        const remaining = posts.length - index;
        skipped += remaining;
        console.warn(
          `[AnalyticsSync] Skipping remaining analytics for account ${accountId}: insufficient LinkedIn permissions (${error.message})`
        );
        break;
      }

      console.error(`[AnalyticsSync] Failed to sync post ${post.id}:`, error);
      failed++;
    }

    // Rate limit: 200ms delay between API calls
    await delay(200);
  }

  // Aggregate analytics for affected campaigns
  for (const campaignId of affectedCampaignIds) {
    try {
      await aggregateCampaignAnalytics(campaignId);
    } catch (error) {
      console.error(
        `[AnalyticsSync] Failed to aggregate campaign ${campaignId}:`,
        error
      );
    }
  }

  console.log(
    `[AnalyticsSync] Account ${accountId}: synced=${synced}, failed=${failed}, skipped=${skipped}`
  );

  return { synced, failed, skipped };
}
