import prisma from '../lib/prisma';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';

export interface CampaignAnalyticsSummary {
  totalPosts: number;
  totalImpressions: number;
  totalClicks: number;
  totalReactions: number;
  totalComments: number;
  totalShares: number;
  avgEngagementRate: number;
  topPost: {
    id: string;
    title: string | null;
    engagementRate: number;
  } | null;
}

export async function aggregateCampaignAnalytics(
  campaignId: string
): Promise<CampaignAnalyticsSummary> {
  const posts = await prisma.linkedInPost.findMany({
    where: {
      campaignId,
      status: 'POSTED',
    },
    select: {
      id: true,
      title: true,
      impressions: true,
      clicks: true,
      reactions: true,
      comments: true,
      shares: true,
      engagementRate: true,
    },
  });

  const totalPosts = posts.length;
  const totalImpressions = posts.reduce(
    (sum, p) => sum + (p.impressions ?? 0),
    0
  );
  const totalClicks = posts.reduce((sum, p) => sum + (p.clicks ?? 0), 0);
  const totalReactions = posts.reduce(
    (sum, p) => sum + (p.reactions ?? 0),
    0
  );
  const totalComments = posts.reduce(
    (sum, p) => sum + (p.comments ?? 0),
    0
  );
  const totalShares = posts.reduce((sum, p) => sum + (p.shares ?? 0), 0);

  const avgEngagementRate =
    totalPosts > 0
      ? posts.reduce((sum, p) => sum + (p.engagementRate ?? 0), 0) /
        totalPosts
      : 0;

  const topPost =
    posts.length > 0
      ? posts.reduce((best, p) =>
          (p.engagementRate ?? 0) > (best.engagementRate ?? 0) ? p : best
        )
      : null;

  await prisma.linkedInCampaign.update({
    where: { id: campaignId },
    data: {
      totalPosts,
      totalImpressions,
      totalClicks,
      totalReactions,
      totalComments,
      totalShares,
      avgEngagementRate,
    },
  });

  return {
    totalPosts,
    totalImpressions,
    totalClicks,
    totalReactions,
    totalComments,
    totalShares,
    avgEngagementRate,
    topPost: topPost
      ? {
          id: topPost.id,
          title: topPost.title ?? null,
          engagementRate: topPost.engagementRate ?? 0,
        }
      : null,
  };
}

export async function generateCampaignInsight(
  campaignId: string
): Promise<string> {
  const campaign = await prisma.linkedInCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: {
      posts: {
        where: { status: 'POSTED' },
        orderBy: { engagementRate: 'desc' },
        select: {
          id: true,
          title: true,
          impressions: true,
          clicks: true,
          reactions: true,
          comments: true,
          shares: true,
          engagementRate: true,
          publishedAt: true,
        },
      },
    },
  });

  const topPerformers = campaign.posts.slice(0, 3);
  const bottomPerformers = campaign.posts.slice(-3).reverse();

  const prompt = `Campaign: "${campaign.name}"
Total posts: ${campaign.posts.length}
Aggregated metrics:
- Impressions: ${campaign.totalImpressions ?? 0}
- Clicks: ${campaign.totalClicks ?? 0}
- Reactions: ${campaign.totalReactions ?? 0}
- Comments: ${campaign.totalComments ?? 0}
- Shares: ${campaign.totalShares ?? 0}
- Avg Engagement Rate: ${(campaign.avgEngagementRate ?? 0).toFixed(2)}%

Top performers:
${topPerformers.map((p) => `- "${p.title ?? 'Untitled'}" — ${(p.engagementRate ?? 0).toFixed(2)}% engagement, ${p.impressions ?? 0} impressions`).join('\n')}

Bottom performers:
${bottomPerformers.map((p) => `- "${p.title ?? 'Untitled'}" — ${(p.engagementRate ?? 0).toFixed(2)}% engagement, ${p.impressions ?? 0} impressions`).join('\n')}`;

  const response = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content:
          'You are a LinkedIn marketing analyst. Provide a concise 3-5 sentence insight summary for this campaign\'s performance. Include what worked, what didn\'t, and one actionable recommendation.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: 0.7,
    max_tokens: 500,
  });

  const insight = response.choices[0]?.message?.content ?? '';

  await prisma.linkedInCampaign.update({
    where: { id: campaignId },
    data: {
      insightSummary: insight,
      insightGeneratedAt: new Date(),
    },
  });

  return insight;
}
