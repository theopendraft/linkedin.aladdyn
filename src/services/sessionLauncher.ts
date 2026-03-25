/**
 * Session Launcher
 *
 * Launches a visible (headed) Chromium browser so the user can log into
 * LinkedIn manually. Once the li_at session cookie appears, cookies are
 * captured, encrypted, and stored — no browser extension required.
 *
 * Usage:
 *   const sessionId = await launchLinkedInLogin(accountId, userId);
 *   // frontend polls getLaunchStatus(sessionId) every 2s
 */

import { chromium } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../lib/prisma';
import { encrypt } from '../lib/encrypt';

export interface LaunchState {
  status: 'waiting' | 'success' | 'error';
  message?: string;
}

// In-memory state — keyed by sessionId, auto-expires after 10 minutes
const launchSessions = new Map<string, LaunchState & { expiresAt: number }>();

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of launchSessions.entries()) {
    if (state.expiresAt < now) launchSessions.delete(id);
  }
}, 5 * 60 * 1000);

export function getLaunchStatus(sessionId: string): LaunchState | null {
  const state = launchSessions.get(sessionId);
  if (!state) return null;
  return { status: state.status, message: state.message };
}

/**
 * Start a headed LinkedIn login flow for the given account.
 * Returns a sessionId the frontend can poll for status.
 */
export async function launchLinkedInLogin(
  accountId: string
): Promise<string> {
  const sessionId = uuidv4();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 min TTL
  launchSessions.set(sessionId, { status: 'waiting', expiresAt });

  // Fire and forget — browser runs in background
  runLoginFlow(sessionId, accountId).catch((err) => {
    launchSessions.set(sessionId, {
      status: 'error',
      message: err?.message ?? 'Unknown error during login flow',
      expiresAt,
    });
  });

  return sessionId;
}

async function runLoginFlow(
  sessionId: string,
  accountId: string
): Promise<void> {
  const browser = await chromium.launch({
    headless: false,
    args: ['--window-size=1280,800', '--window-position=100,100'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    // Set window title so user knows which window is for login
    await page.goto('https://www.linkedin.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // Poll for li_at cookie — up to 3 minutes
    const MAX_WAIT_MS = 180_000;
    const POLL_INTERVAL_MS = 2_000;
    const deadline = Date.now() + MAX_WAIT_MS;
    let loggedIn = false;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      try {
        const cookies = await context.cookies('https://www.linkedin.com');
        const liAt = cookies.find((c) => c.name === 'li_at');

        if (liAt) {
          // Save all cookies encrypted in DB
          const cookieJson = JSON.stringify(
            cookies.map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              expires: c.expires,
              httpOnly: c.httpOnly,
              secure: c.secure,
              sameSite: c.sameSite,
            }))
          );

          await prisma.linkedInAccount.update({
            where: { id: accountId },
            data: {
              sessionCookies: encrypt(cookieJson),
              sessionValid: true,
              lastSessionAt: new Date(),
            },
          });

          const expiresAt = Date.now() + 10 * 60 * 1000;
          launchSessions.set(sessionId, { status: 'success', expiresAt });
          loggedIn = true;
          break;
        }
      } catch {
        // Page is navigating — ignore and keep polling
      }
    }

    if (!loggedIn) {
      const expiresAt = Date.now() + 10 * 60 * 1000;
      launchSessions.set(sessionId, {
        status: 'error',
        message: 'Login timed out — no session detected after 3 minutes',
        expiresAt,
      });
    }
  } finally {
    try {
      await browser.close();
    } catch {
      // ignore close errors
    }
  }
}
