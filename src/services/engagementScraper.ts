import prisma from '../lib/prisma';
import { withSession, randomDelay } from './browserPool';
import { decrypt } from '../lib/encrypt';

export interface EngagerInfo {
  linkedinId: string;
  displayName: string;
  headline?: string;
}

export interface CommentInfo {
  linkedinId: string;
  displayName: string;
  headline?: string;
  commentText: string;
}

export interface EngagementResult {
  likes: EngagerInfo[];
  comments: CommentInfo[];
  totalScraped: number;
}

const MAX_DAILY_ACTIONS = 30;

async function checkDailyActionLimit(accountId: string): Promise<void> {
  const account = await prisma.linkedInAccount.findUnique({
    where: { id: accountId },
    select: { dailyActionCount: true, dailyActionReset: true },
  });

  if (!account) {
    throw new Error(
      `[EngagementScraper] Account ${accountId} not found`
    );
  }

  const today = new Date().toDateString();
  const lastActionDay = account.dailyActionReset
    ? new Date(account.dailyActionReset).toDateString()
    : null;

  const currentCount =
    lastActionDay === today ? account.dailyActionCount : 0;

  if (currentCount >= MAX_DAILY_ACTIONS) {
    throw new Error(
      `[EngagementScraper] Daily action limit (${MAX_DAILY_ACTIONS}) reached for account ${accountId}`
    );
  }
}

async function incrementActionCount(accountId: string): Promise<void> {
  const today = new Date().toDateString();
  const account = await prisma.linkedInAccount.findUnique({
    where: { id: accountId },
    select: { dailyActionReset: true },
  });

  const lastActionDay = account?.dailyActionReset
    ? new Date(account.dailyActionReset).toDateString()
    : null;

  if (lastActionDay === today) {
    await prisma.linkedInAccount.update({
      where: { id: accountId },
      data: {
        dailyActionCount: { increment: 1 },
        dailyActionReset: new Date(),
      },
    });
  } else {
    await prisma.linkedInAccount.update({
      where: { id: accountId },
      data: {
        dailyActionCount: 1,
        dailyActionReset: new Date(),
      },
    });
  }
}

export async function scrapePostEngagements(
  postId: string,
  accountId: string
): Promise<EngagementResult> {
  await checkDailyActionLimit(accountId);

  const post = await prisma.linkedInPost.findUnique({
    where: { id: postId },
    select: { id: true, linkedinPostId: true },
  });

  if (!post || !post.linkedinPostId) {
    throw new Error(
      `[EngagementScraper] Post ${postId} not found or missing linkedinPostId`
    );
  }

  const linkedinPostId = post.linkedinPostId;

  // Fetch encrypted session cookies for this account
  const account = await prisma.linkedInAccount.findUnique({
    where: { id: accountId },
    select: { sessionCookies: true, sessionValid: true },
  });

  if (!account?.sessionCookies || !account.sessionValid) {
    throw new Error(
      `[EngagementScraper] No valid browser session for account ${accountId} — user must log in via session connect first`
    );
  }

  const result = await withSession(
    accountId,
    account.sessionCookies,
    async function (session) {
      const { page } = session;
      const postUrl = `https://www.linkedin.com/feed/update/${linkedinPostId}/`;

      await randomDelay(1500, 3000);

      await page.goto(postUrl, { waitUntil: 'domcontentloaded' });

      try {
        await page.waitForSelector(
          '.feed-shared-update-v2, .scaffold-finite-scroll',
          { timeout: 10000 }
        );
      } catch {
        throw new Error(
          `[EngagementScraper] Post page did not load for ${linkedinPostId}`
        );
      }

      // --- Scrape reactions ---
      const likes: EngagerInfo[] = [];

      await randomDelay(1500, 3000);

      const reactionsButton = await page.$(
        '.social-details-social-counts__reactions-count, button[aria-label*="reaction"]'
      );

      if (reactionsButton) {
        await randomDelay(1500, 3000);
        await reactionsButton.click();

        try {
          await page.waitForSelector(
            '.social-details-reactors-modal, .artdeco-modal',
            { timeout: 8000 }
          );
        } catch {
          console.log(
            '[EngagementScraper] Reactions modal did not appear'
          );
        }

        await randomDelay(1500, 3000);

        const reactors = await page.evaluate(
          '(function() {' +
            'var items = document.querySelectorAll(".social-details-reactors-modal .artdeco-list__item, .artdeco-modal .artdeco-list__item");' +
            'var result = [];' +
            'items.forEach(function(item) {' +
            '  var nameEl = item.querySelector(".artdeco-entity-lockup__title span[aria-hidden=true], .actor-name");' +
            '  var headlineEl = item.querySelector(".artdeco-entity-lockup__subtitle span[aria-hidden=true], .actor-description");' +
            '  var linkEl = item.querySelector("a[href*=\'/in/\']");' +
            '  var href = linkEl ? linkEl.getAttribute("href") : "";' +
            '  var idMatch = href ? href.match(/\\/in\\/([^\\/\\?]+)/) : null;' +
            '  var linkedinId = idMatch ? idMatch[1] : "";' +
            '  var displayName = nameEl ? nameEl.textContent.trim() : "";' +
            '  var headline = headlineEl ? headlineEl.textContent.trim() : "";' +
            '  if (linkedinId && displayName) {' +
            '    result.push({ linkedinId: linkedinId, displayName: displayName, headline: headline });' +
            '  }' +
            '});' +
            'return result;' +
            '})()'
        ) as EngagerInfo[];

        likes.push(...reactors);

        // Close the modal
        await randomDelay(1500, 3000);
        const closeButton = await page.$(
          '.artdeco-modal__dismiss, button[aria-label="Dismiss"]'
        );
        if (closeButton) {
          await closeButton.click();
          await randomDelay(1000, 2000);
        }
      }

      // --- Scrape comments ---
      await randomDelay(1500, 3000);

      const comments = await page.evaluate(
        '(function() {' +
          'var items = document.querySelectorAll(".comments-comments-list__comment-item, .comments-comment-item");' +
          'var result = [];' +
          'items.forEach(function(item) {' +
          '  var nameEl = item.querySelector(".comments-post-meta__name-text span[aria-hidden=true], .comment-actor-name span[aria-hidden=true]");' +
          '  var headlineEl = item.querySelector(".comments-post-meta__headline, .comment-actor-description");' +
          '  var textEl = item.querySelector(".comments-comment-item__main-content span[dir=ltr], .comment-body span[dir=ltr]");' +
          '  var linkEl = item.querySelector("a[href*=\'/in/\']");' +
          '  var href = linkEl ? linkEl.getAttribute("href") : "";' +
          '  var idMatch = href ? href.match(/\\/in\\/([^\\/\\?]+)/) : null;' +
          '  var linkedinId = idMatch ? idMatch[1] : "";' +
          '  var displayName = nameEl ? nameEl.textContent.trim() : "";' +
          '  var headline = headlineEl ? headlineEl.textContent.trim() : "";' +
          '  var commentText = textEl ? textEl.textContent.trim() : "";' +
          '  if (linkedinId && displayName) {' +
          '    result.push({ linkedinId: linkedinId, displayName: displayName, headline: headline, commentText: commentText });' +
          '  }' +
          '});' +
          'return result;' +
          '})()'
      ) as CommentInfo[];

      return { likes, comments };
    }
  );

  await incrementActionCount(accountId);

  // Upsert profiles + create engagement records
  const allEngagers: Array<{ linkedinId: string; displayName: string; headline?: string }> = [
    ...result.likes,
    ...result.comments,
  ];

  const uniqueEngagers = new Map<string, { displayName: string; headline?: string }>();
  for (const engager of allEngagers) {
    if (!uniqueEngagers.has(engager.linkedinId)) {
      uniqueEngagers.set(engager.linkedinId, {
        displayName: engager.displayName,
        headline: engager.headline,
      });
    }
  }

  // Upsert profiles and collect their DB ids
  const profileIdMap = new Map<string, string>(); // linkedinId → DB uuid

  for (const [linkedinId, data] of uniqueEngagers) {
    const profile = await prisma.linkedInProfile.upsert({
      where: { linkedinId },
      create: {
        linkedinId,
        displayName: data.displayName,
        headline: data.headline || '',
        totalInteractions: 1,
        lastScrapedAt: new Date(),
      },
      update: {
        displayName: data.displayName,
        headline: data.headline || undefined,
        totalInteractions: { increment: 1 },
        lastInteractionAt: new Date(),
      },
      select: { id: true },
    });
    profileIdMap.set(linkedinId, profile.id);
  }

  // Build engagement records using profileId (DB uuid), skip duplicates on re-scrape
  const likeData = result.likes
    .map((liker) => {
      const profileId = profileIdMap.get(liker.linkedinId);
      if (!profileId) return null;
      return { postId, profileId, type: 'LIKE' as const };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const commentData = result.comments
    .map((commenter) => {
      const profileId = profileIdMap.get(commenter.linkedinId);
      if (!profileId) return null;
      return {
        postId,
        profileId,
        type: 'COMMENT' as const,
        content: commenter.commentText || null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  await prisma.linkedInEngagement.createMany({
    data: [...likeData, ...commentData],
    skipDuplicates: true,
  });

  const totalScraped = result.likes.length + result.comments.length;

  console.log(
    `[EngagementScraper] Scraped ${totalScraped} engagements for post ${postId}`
  );

  return {
    likes: result.likes,
    comments: result.comments,
    totalScraped,
  };
}
