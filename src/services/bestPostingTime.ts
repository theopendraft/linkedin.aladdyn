import prisma from '../lib/prisma';

export interface PostingTimeRecommendation {
  dayOfWeek: number;
  hour: number;
  avgEngagementRate: number;
  sampleSize: number;
  confidence: 'high' | 'medium' | 'low';
}

export async function predictBestPostingTimes(
  accountId: string
): Promise<PostingTimeRecommendation[]> {
  const posts = await prisma.linkedInPost.findMany({
    where: {
      accountId,
      status: 'POSTED',
      publishedAt: { not: null },
      engagementRate: { not: null },
    },
    select: {
      publishedAt: true,
      engagementRate: true,
    },
  });

  if (posts.length < 5) {
    console.log(
      `[BestPostingTime] Account ${accountId} has only ${posts.length} posts — need at least 5 for predictions`
    );
    return [];
  }

  const slotMap = new Map<
    string,
    { totalEngagement: number; count: number; dayOfWeek: number; hour: number }
  >();

  for (const post of posts) {
    const publishedAt = post.publishedAt!;
    const dayOfWeek = publishedAt.getUTCDay();
    const hour = publishedAt.getUTCHours();
    const key = `${dayOfWeek}-${hour}`;

    const existing = slotMap.get(key);
    if (existing) {
      existing.totalEngagement += post.engagementRate!;
      existing.count += 1;
    } else {
      slotMap.set(key, {
        totalEngagement: post.engagementRate!,
        count: 1,
        dayOfWeek,
        hour,
      });
    }
  }

  const recommendations: PostingTimeRecommendation[] = [];

  for (const slot of slotMap.values()) {
    if (slot.count < 2) continue;

    const avgEngagementRate = slot.totalEngagement / slot.count;

    let confidence: 'high' | 'medium' | 'low';
    if (slot.count >= 5) {
      confidence = 'high';
    } else if (slot.count >= 3) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }

    recommendations.push({
      dayOfWeek: slot.dayOfWeek,
      hour: slot.hour,
      avgEngagementRate,
      sampleSize: slot.count,
      confidence,
    });
  }

  recommendations.sort((a, b) => b.avgEngagementRate - a.avgEngagementRate);

  return recommendations.slice(0, 10);
}
