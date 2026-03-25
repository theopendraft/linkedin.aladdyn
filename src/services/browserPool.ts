/**
 * Browser Pool — Playwright Session Management
 *
 * Manages headless Chromium sessions loaded with stored LinkedIn cookies.
 * Uses playwright-extra with StealthPlugin to avoid bot detection.
 *
 * Hard constraints enforced here:
 * - Realistic viewport with random variation
 * - Asia/Kolkata timezone + Chrome 120 user agent
 * - randomDelay() helper used before every browser action
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import { decrypt } from '../lib/encrypt';

// playwright-extra and its stealth plugin use CommonJS default exports.
// We use require() here to avoid ESM interop issues with these packages.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const playwrightExtra = require('playwright-extra') as { chromium: typeof import('playwright').chromium & { use: (plugin: unknown) => void } };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StealthPlugin = require('puppeteer-extra-plugin-stealth') as () => unknown;

const { chromium } = playwrightExtra;

// Register stealth plugin once at module load
chromium.use(StealthPlugin());

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  accountId: string;
}

export interface StoredCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Returns a random integer delay in [minMs, maxMs] milliseconds.
 * Use before every automated action.
 */
export function randomDelay(minMs = 1500, maxMs = 4000): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns a random viewport size centered around 1280×800 ±50px.
 */
function randomViewport(): { width: number; height: number } {
  const width = 1280 + Math.floor((Math.random() * 2 - 1) * 50);
  const height = 800 + Math.floor((Math.random() * 2 - 1) * 50);
  return { width, height };
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Launches a stealth Chromium instance with the stored LinkedIn cookies loaded.
 *
 * @param accountId    Used to tag the session for logging
 * @param encryptedCookies  AES-256-GCM encrypted cookie JSON string
 */
export async function claimSession(
  accountId: string,
  encryptedCookies: string
): Promise<BrowserSession> {
  const cookieJson = decrypt(encryptedCookies);
  let cookies: StoredCookie[];

  try {
    cookies = JSON.parse(cookieJson) as StoredCookie[];
  } catch {
    throw new Error(`[BrowserPool] Failed to parse cookies for account ${accountId}`);
  }

  const viewport = randomViewport();

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--window-size=${viewport.width},${viewport.height}`,
    ],
  });

  const context = await browser.newContext({
    viewport,
    userAgent: USER_AGENT,
    timezoneId: 'Asia/Kolkata',
    locale: 'en-US',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Convert stored cookies to Playwright format
  const playwrightCookies = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain ?? '.linkedin.com',
    path: c.path ?? '/',
    expires: c.expires ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? true,
    sameSite: (c.sameSite ?? 'None') as 'Strict' | 'Lax' | 'None',
  }));

  await context.addCookies(playwrightCookies);

  const page = await context.newPage();

  console.log(`[BrowserPool] Session claimed for account ${accountId}`);

  return { browser, context, page, accountId };
}

/**
 * Closes the browser context and browser for a session.
 * Always call this — even on error — to free resources.
 */
export async function releaseSession(session: BrowserSession): Promise<void> {
  try {
    await session.context.close();
  } catch {
    // ignore close errors
  }
  try {
    await session.browser.close();
  } catch {
    // ignore close errors
  }
  console.log(`[BrowserPool] Session released for account ${session.accountId}`);
}

/**
 * Convenience wrapper: claim → run fn → release (guaranteed even on error).
 */
export async function withSession<T>(
  accountId: string,
  encryptedCookies: string,
  fn: (session: BrowserSession) => Promise<T>
): Promise<T> {
  const session = await claimSession(accountId, encryptedCookies);
  try {
    return await fn(session);
  } finally {
    await releaseSession(session);
  }
}
