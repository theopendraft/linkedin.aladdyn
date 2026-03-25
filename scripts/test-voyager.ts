/**
 * Diagnostic: test LinkedIn voyager API endpoints with stored session cookies.
 * Run: npx tsx scripts/test-voyager.ts
 */

import prisma from '../src/lib/prisma';
import { decrypt } from '../src/lib/encrypt';

const ACCOUNT_ID = '5763314b-ccae-4b5d-89e8-a6983e6cf500';

async function main() {
  const account = await prisma.linkedInAccount.findUnique({
    where: { id: ACCOUNT_ID },
    select: { sessionCookies: true, linkedinId: true, sessionValid: true },
  });

  if (!account?.sessionCookies) {
    console.error('No session cookies found');
    process.exit(1);
  }

  console.log('Account linkedinId:', account.linkedinId);
  console.log('Session valid:', account.sessionValid);

  const cookieJson = decrypt(account.sessionCookies);
  const cookies: { name: string; value: string }[] = JSON.parse(cookieJson);

  console.log('\nStored cookies:', cookies.map((c) => c.name).join(', '));

  const liAt = cookies.find((c) => c.name === 'li_at')?.value;
  const jsessionRaw = cookies.find((c) => c.name === 'JSESSIONID')?.value;
  const jsessionId = jsessionRaw?.replace(/"/g, '') ?? '';

  console.log('li_at present:', !!liAt);
  console.log('JSESSIONID present:', !!jsessionId);
  console.log('JSESSIONID value (first 20 chars):', jsessionId.slice(0, 20) + '...');

  if (!liAt || !jsessionId) {
    console.error('Missing critical cookies');
    process.exit(1);
  }

  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  const baseHeaders: Record<string, string> = {
    Cookie: cookieHeader,
    'csrf-token': jsessionId,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-li-lang': 'en_US',
    'x-restli-protocol-version': '2.0.0',
  };

  // Test a bunch of known endpoints with different Accept headers
  const acceptHeaders = [
    'application/vnd.linkedin.normalized+json+2.1',
    'application/json',
  ];

  const endpoints = [
    // Conversations list — various param combos
    '/voyager/api/messaging/conversations',
    '/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX',
    '/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&count=10',
    '/voyager/api/messaging/conversations?q=syncToken&count=10',

    // New messaging API (graphql-based voyager endpoints)
    '/voyager/api/voyagerMessagingDashConversations?q=unarchived&count=10',
    '/voyager/api/voyagerMessagingDashMessagingThreads?q=criteria&count=10',

    // Me endpoint (sanity check that cookies work)
    '/voyager/api/me',

    // Identity check
    '/voyager/api/identity/profiles/me',

    // Messaging graphQL
    '/voyager/api/graphql?queryId=messengerConversations',
  ];

  for (const accept of acceptHeaders) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Accept: ${accept}`);
    console.log('='.repeat(60));

    for (const endpoint of endpoints) {
      const url = `https://www.linkedin.com${endpoint}`;
      try {
        const res = await fetch(url, {
          headers: { ...baseHeaders, Accept: accept },
          signal: AbortSignal.timeout(10000),
        });

        const contentType = res.headers.get('content-type') ?? '';
        let bodyPreview = '';

        if (contentType.includes('json')) {
          const json = await res.json();
          bodyPreview = JSON.stringify(json).slice(0, 300);

          // If successful, show the top-level keys
          if (res.ok && typeof json === 'object' && json !== null) {
            const keys = Object.keys(json as Record<string, unknown>);
            const elements = (json as Record<string, unknown>)['elements'];
            const elemCount = Array.isArray(elements) ? elements.length : 'N/A';
            bodyPreview = `keys=[${keys.join(',')}] elements.length=${elemCount}`;
          }
        } else {
          bodyPreview = `(non-JSON: ${contentType})`;
        }

        const status = res.status;
        const icon = res.ok ? '✓' : '✗';
        console.log(`\n  ${icon} ${status} ${endpoint}`);
        console.log(`    ${bodyPreview}`);
      } catch (err) {
        console.log(`\n  ✗ ERR ${endpoint}`);
        console.log(`    ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
