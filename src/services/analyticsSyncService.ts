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

  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

  const posts = await prisma.linkedInPost.findMany({
    where: {
      accountId,
      status: 'POSTED',
      linkedinPostId: { not: null },
      OR: [
        { analyticsAt: null },
        { analyticsAt: { lt: sixHoursAgo } },
      ],
    },
    select: {
      id: true,
      linkedinPostId: true,
      campaignId: true,
      postAsPersonal: true,
    },
  });

  if (!account.orgId) {
    console.warn(
      `[AnalyticsSync] Skipping analytics for account ${accountId}: missing organization ID`
    );
    return { synced: 0, failed: 0, skipped: posts.length };
  }

  let synced = 0;
  let failed = 0;
  let skipped = 0;

  const affectedCampaignIds = new Set<string>();

  for (const [index, post] of posts.entries()) {
    if (!post.linkedinPostId || post.postAsPersonal) {
      skipped++;
      continue;
    }

    try {
      const analytics = await getPostAnalytics({
        accessToken,
        linkedinPostId: post.linkedinPostId,
        organizationId: account.orgId,
      });

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
      if (
        error instanceof LinkedInApiError &&
        error.isPermissionError
      ) {
        const remaining = posts.length - index;
        skipped += remaining;

        console.warn(
          `[AnalyticsSync] Skipping remaining analytics for account ${accountId}: insufficient LinkedIn permissions (${error.message})`
        );
        break;
      }

      console.error(
        `[AnalyticsSync] Failed to sync post ${post.id}:`,
        error
      );
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
