import prisma from '../lib/prisma';
import { withSession, randomDelay, BrowserSession } from './browserPool';

export interface ScrapedProfile {
  linkedinId: string;
  displayName: string;
  headline: string;
  company: string;
  jobTitle: string;
  industry: string;
  location: string;
  profileUrl: string;
  avatarUrl: string;
}

export async function scrapeProfile(
  linkedinId: string,
  session: BrowserSession
): Promise<ScrapedProfile> {
  const { page } = session;
  const profileUrl = `https://www.linkedin.com/in/${linkedinId}/`;

  await randomDelay(1500, 3000);

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });

  try {
    await page.waitForSelector('.pv-top-card, main', { timeout: 10000 });
  } catch {
    throw new Error(
      `[ProfileScraper] Profile page did not load for ${linkedinId}`
    );
  }

  await randomDelay(1500, 3000);

  const displayName = await page.evaluate(
    'document.querySelector(".pv-top-card--list .text-heading-xlarge, h1")?.textContent?.trim() || ""'
  );

  const headline = await page.evaluate(
    'document.querySelector(".pv-top-card--list .text-body-medium")?.textContent?.trim() || ""'
  );

  const company = await page.evaluate(
    'document.querySelector(".pv-top-card--experience-list-item, #experience ~ .pvs-list__outer-container li:first-child span[aria-hidden=true]")?.textContent?.trim() || ""'
  );

  const jobTitle = await page.evaluate(
    'document.querySelector("#experience ~ .pvs-list__outer-container li:first-child .t-bold span[aria-hidden=true], .pv-top-card--experience-list-item .t-bold")?.textContent?.trim() || ""'
  );

  const location = await page.evaluate(
    'document.querySelector(".pv-top-card--list .text-body-small.inline.t-black--light")?.textContent?.trim() || ""'
  );

  const avatarUrl = await page.evaluate(
    'document.querySelector(".pv-top-card-profile-picture__image, .pv-top-card-profile-picture img")?.getAttribute("src") || ""'
  );

  const profile: ScrapedProfile = {
    linkedinId,
    displayName: String(displayName),
    headline: String(headline),
    company: String(company),
    jobTitle: String(jobTitle),
    industry: '',
    location: String(location),
    profileUrl,
    avatarUrl: String(avatarUrl),
  };

  console.log(`[ProfileScraper] Scraped profile ${linkedinId}`);

  return profile;
}

export async function scrapeAndUpsertProfile(
  linkedinId: string,
  accountId: string
): Promise<ScrapedProfile> {
  const profile = await withSession(accountId, async function (session) {
    return scrapeProfile(linkedinId, session);
  });

  await prisma.linkedInProfile.upsert({
    where: { linkedinId: profile.linkedinId },
    create: {
      linkedinId: profile.linkedinId,
      displayName: profile.displayName,
      headline: profile.headline,
      company: profile.company,
      jobTitle: profile.jobTitle,
      industry: profile.industry,
      location: profile.location,
      profileUrl: profile.profileUrl,
      avatarUrl: profile.avatarUrl,
      lastScrapedAt: new Date(),
    },
    update: {
      displayName: profile.displayName,
      headline: profile.headline,
      company: profile.company,
      jobTitle: profile.jobTitle,
      industry: profile.industry,
      location: profile.location,
      avatarUrl: profile.avatarUrl,
      lastScrapedAt: new Date(),
      totalInteractions: { increment: 1 },
    },
  });

  return profile;
}
