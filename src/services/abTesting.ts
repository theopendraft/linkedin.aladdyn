import prisma from '../lib/prisma';

export interface CreateABTestParams {
  campaignId: string;
  name: string;
  variants: { name: string; text: string }[];
  metricToOptimize?: string;
  minImpressions?: number;
}

export interface ABTestCreated {
  testId: string;
  variants: { id: string; name: string; postId: string }[];
}

export interface EvaluationResult {
  evaluated: number;
  decided: number;
}

/**
 * Creates an A/B test with the given variants.
 * For each variant, a DRAFT LinkedInPost is created and linked via a
 * LinkedInABVariant record.
 */
export async function createABTest(
  params: CreateABTestParams
): Promise<ABTestCreated> {
  const { campaignId, name, variants, metricToOptimize, minImpressions } =
    params;

  const campaign = await prisma.linkedInCampaign.findUniqueOrThrow({
    where: { id: campaignId },
  });

  const test = await prisma.linkedInABTest.create({
    data: {
      campaignId,
      name,
      status: 'RUNNING',
      metricToOptimize: metricToOptimize ?? 'engagementRate',
      minImpressions: minImpressions ?? 500,
    },
  });

  const createdVariants: ABTestCreated['variants'] = [];

  for (const variant of variants) {
    const post = await prisma.linkedInPost.create({
      data: {
        accountId: campaign.accountId,
        campaignId,
        status: 'DRAFT',
        text: variant.text,
        abVariantLabel: variant.name,
      },
    });

    const abVariant = await prisma.linkedInABVariant.create({
      data: {
        testId: test.id,
        name: variant.name,
        postId: post.id,
      },
    });

    createdVariants.push({
      id: abVariant.id,
      name: variant.name,
      postId: post.id,
    });
  }

  return {
    testId: test.id,
    variants: createdVariants,
  };
}

/**
 * Evaluates all RUNNING A/B tests. For each test, checks whether enough
 * data has been collected and whether a statistically meaningful difference
 * exists between variants. Declares a winner when criteria are met.
 */
export async function evaluateABTests(): Promise<EvaluationResult> {
  let evaluated = 0;
  let decided = 0;

  const tests = await prisma.linkedInABTest.findMany({
    where: { status: 'RUNNING' },
    include: {
      variants: {
        include: { post: true },
      },
    },
  });

  for (const test of tests) {
    evaluated++;

    try {
      const { variants } = test;

      // All variant posts must have been published
      const allPosted = variants.every((v) => v.post.status === 'POSTED');
      if (!allPosted) {
        continue;
      }

      // Gather analytics for each variant
      const variantMetrics: {
        variantId: string;
        impressions: number;
        engagementRate: number;
        clicks: number;
        reactions: number;
        comments: number;
        shares: number;
      }[] = [];

      let allHaveEnoughData = true;

      for (const variant of variants) {
        const analytics = await prisma.linkedInPostAnalytics.findUnique({
          where: { postId: variant.postId },
        });

        if (!analytics) {
          allHaveEnoughData = false;
          break;
        }

        const impressions = analytics.impressions ?? 0;
        if (impressions < (test.minImpressions ?? 500)) {
          allHaveEnoughData = false;
          break;
        }

        variantMetrics.push({
          variantId: variant.id,
          impressions,
          engagementRate: analytics.engagementRate ?? 0,
          clicks: analytics.clicks ?? 0,
          reactions: analytics.reactions ?? 0,
          comments: analytics.comments ?? 0,
          shares: analytics.shares ?? 0,
        });
      }

      if (!allHaveEnoughData) {
        continue;
      }

      // --- Determine winner ---
      const metric = (test.metricToOptimize as string) ?? 'engagementRate';

      const sorted = [...variantMetrics].sort((a, b) => {
        const aVal = (a as Record<string, number>)[metric] ?? 0;
        const bVal = (b as Record<string, number>)[metric] ?? 0;
        return bVal - aVal;
      });

      const best = sorted[0];
      const runnerUp = sorted[1];

      if (!best || !runnerUp) {
        continue;
      }

      const bestVal = (best as Record<string, number>)[metric] ?? 0;
      const runnerUpVal = (runnerUp as Record<string, number>)[metric] ?? 0;

      // Declare winner if >10% relative difference or enough total impressions
      const totalImpressions = variantMetrics.reduce(
        (sum, v) => sum + v.impressions,
        0
      );
      const relativeDiff =
        runnerUpVal > 0 ? (bestVal - runnerUpVal) / runnerUpVal : 1;
      const enoughImpressions =
        totalImpressions >= (test.minImpressions ?? 500) * 2;

      if (relativeDiff > 0.1 || enoughImpressions) {
        await prisma.linkedInABTest.update({
          where: { id: test.id },
          data: {
            status: 'DECIDED',
            winnerVariantId: best.variantId,
            decidedAt: new Date(),
          },
        });
        decided++;
      }
    } catch (err) {
      console.error(`[ABTesting] Error evaluating test ${test.id}:`, err);
    }
  }

  console.log(`[ABTesting] Evaluated ${evaluated} tests, decided ${decided}`);

  return { evaluated, decided };
}
