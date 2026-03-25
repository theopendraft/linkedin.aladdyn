/**
 * Diagnostic: use Playwright to navigate to LinkedIn messaging
 * and dump the DOM structure so we know what selectors to use.
 *
 * Run: npx tsx scripts/test-dom-messaging.ts
 */

import prisma from '../src/lib/prisma';
import { decrypt } from '../src/lib/encrypt';
import { chromium } from 'playwright';

const ACCOUNT_ID = '5763314b-ccae-4b5d-89e8-a6983e6cf500';

async function main() {
  const account = await prisma.linkedInAccount.findUnique({
    where: { id: ACCOUNT_ID },
    select: { sessionCookies: true, linkedinId: true },
  });

  if (!account?.sessionCookies) {
    console.error('No session cookies found');
    process.exit(1);
  }

  const cookieJson = decrypt(account.sessionCookies);
  const cookies: { name: string; value: string; domain?: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string }[] = JSON.parse(cookieJson);

  // Launch headed browser so we can see what happens
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  // Load cookies
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

  // Log all network requests to messaging APIs
  const apiCalls: string[] = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('messaging') || url.includes('messenger') || url.includes('Messaging') || url.includes('Messenger')) {
      apiCalls.push(`${response.status()} ${url.slice(0, 150)}`);
      if (response.ok()) {
        try {
          const ct = response.headers()['content-type'] ?? '';
          if (ct.includes('json')) {
            const json = await response.json();
            const keys = Object.keys(json as Record<string, unknown>);
            const elements = (json as Record<string, unknown>)['elements'];
            const included = (json as Record<string, unknown>)['included'];
            console.log(`  API OK: ${url.slice(0, 100)}`);
            console.log(`    keys=${keys.join(',')} elements=${Array.isArray(elements) ? elements.length : 'N/A'} included=${Array.isArray(included) ? included.length : 'N/A'}`);
          }
        } catch { /* ignore */ }
      }
    }
  });

  console.log('\nNavigating to LinkedIn messaging...');
  await page.goto('https://www.linkedin.com/messaging/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // Wait for page to settle
  console.log('Waiting for page to load...');
  await page.waitForTimeout(5000);

  // Check if we got redirected to login
  const currentUrl = page.url();
  console.log('Current URL:', currentUrl);
  if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
    console.error('Session expired — redirected to login');
    await browser.close();
    await prisma.$disconnect();
    return;
  }

  // Dump messaging API calls captured
  console.log('\n--- API calls intercepted ---');
  for (const call of apiCalls) {
    console.log('  ', call);
  }

  // Wait a bit more for dynamic content
  await page.waitForTimeout(3000);

  // Now dump the DOM structure
  console.log('\n--- DOM Analysis ---');

  // 1. Find conversation list items
  const convListSelectors = [
    '.msg-conversation-listitem',
    '.msg-conversations-container__conversations-list li',
    '[data-test-conversation-list-item]',
    '.msg-s-message-list-container',
    '.msg-overlay-list-bubble',
    'li.msg-conversation-card',
    '.msg-thread',
    // New messaging UI selectors
    '[class*="msg-conversation"]',
    '[class*="messaging-thread"]',
    '[class*="conversation-list"]',
  ];

  for (const sel of convListSelectors) {
    const count = await page.locator(sel).count();
    if (count > 0) {
      console.log(`  ✓ Found ${count} elements for: ${sel}`);
      // Get first item's outerHTML truncated
      const html = await page.locator(sel).first().evaluate(
        (el) => el.outerHTML.slice(0, 500)
      ).catch(() => '(could not get HTML)');
      console.log(`    HTML: ${html.slice(0, 300)}`);
    }
  }

  // 2. Just dump all main content area classes to understand the DOM
  const mainClasses = await page.evaluate(() => {
    const main = document.querySelector('main') ?? document.querySelector('#main') ?? document.body;
    const allElements = main.querySelectorAll('*');
    const classSet = new Set<string>();
    allElements.forEach((el) => {
      el.classList.forEach((cls) => {
        if (cls.includes('msg') || cls.includes('message') || cls.includes('conversation') || cls.includes('thread') || cls.includes('messaging') || cls.includes('inbox') || cls.includes('chat')) {
          classSet.add(cls);
        }
      });
    });
    return Array.from(classSet).sort();
  });

  console.log('\n  Messaging-related CSS classes found:');
  for (const cls of mainClasses) {
    console.log(`    .${cls}`);
  }

  // 3. Try to find any conversation text/names
  const visibleText = await page.evaluate(() => {
    const main = document.querySelector('main') ?? document.body;
    return main.innerText.slice(0, 2000);
  });
  console.log('\n  Visible text (first 2000 chars):');
  console.log(visibleText.slice(0, 1500));

  // Wait for user to see the browser, then close
  console.log('\n--- Keeping browser open for 15 seconds for visual inspection ---');
  await page.waitForTimeout(15000);

  await browser.close();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
