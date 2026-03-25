/**
 * Diagnostic: probe LinkedIn's current messaging API endpoints.
 * The old /voyager/api/messaging/conversations is dead (500).
 * Run: npx tsx scripts/test-voyager2.ts
 */

import prisma from '../src/lib/prisma';
import { decrypt } from '../src/lib/encrypt';

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
  const cookies: { name: string; value: string }[] = JSON.parse(cookieJson);
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const jsessionId = cookies.find((c) => c.name === 'JSESSIONID')?.value?.replace(/"/g, '') ?? '';

  // First, get the actual member URN from /me
  const meRes = await fetch('https://www.linkedin.com/voyager/api/me', {
    headers: {
      Cookie: cookieHeader,
      'csrf-token': jsessionId,
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  const meData = await meRes.json() as Record<string, unknown>;
  const plainId = meData['plainId'] as number | undefined;
  const miniProfile = meData['miniProfile'] as Record<string, unknown> | undefined;
  const entityUrn = miniProfile?.['entityUrn'] as string | undefined;
  const publicIdentifier = miniProfile?.['publicIdentifier'] as string | undefined;

  console.log('plainId:', plainId);
  console.log('entityUrn:', entityUrn);
  console.log('publicIdentifier:', publicIdentifier);

  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    'csrf-token': jsessionId,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-li-lang': 'en_US',
    'x-restli-protocol-version': '2.0.0',
  };

  // Test new-style messaging endpoints
  const endpoints = [
    // Dash-style messaging (newer)
    { url: '/voyager/api/voyagerMessagingDashConversations?q=search&count=10', accept: 'application/vnd.linkedin.normalized+json+2.1' },
    { url: '/voyager/api/voyagerMessagingDashConversations?decorationId=com.linkedin.voyager.dash.deco.messaging.fullConversation&count=10&q=search', accept: 'application/vnd.linkedin.normalized+json+2.1' },

    // GraphQL messaging
    { url: '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.b459246e10be5c789eb3d4f9f5f37a5b&variables=(count:10)', accept: 'application/json' },
    { url: '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations&variables=(count:10)', accept: 'application/json' },

    // messaging-web based (another pattern)
    { url: '/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&start=0&count=10', accept: 'application/vnd.linkedin.normalized+json+2.1' },

    // messagingDashMessengerConversations (newer pattern used in 2025+)
    { url: '/voyager/api/voyagerMessagingDashMessengerConversations?q=criteria&count=10', accept: 'application/vnd.linkedin.normalized+json+2.1' },
    { url: '/voyager/api/voyagerMessagingDashMessengerConversations?q=search&count=10', accept: 'application/vnd.linkedin.normalized+json+2.1' },

    // messagingDashMessengerMessages
    { url: '/voyager/api/voyagerMessagingDashMessengerMessages?q=criteria&count=10', accept: 'application/vnd.linkedin.normalized+json+2.1' },

    // try the conversation endpoint with different protocol version
    { url: '/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&count=10', accept: 'application/vnd.linkedin.normalized+json+2.1', extraHeaders: { 'x-restli-protocol-version': '1.0.0' } },

    // messaging threads (used by some LinkedIn versions)
    { url: '/voyager/api/messaging/threads?count=10', accept: 'application/vnd.linkedin.normalized+json+2.1' },

    // Dash messaging members
    { url: '/voyager/api/voyagerMessagingDashMessagingMembers', accept: 'application/vnd.linkedin.normalized+json+2.1' },

    // Try with decorationId (LinkedIn often requires specific decorations)
    { url: '/voyager/api/messaging/conversations?decorationId=com.linkedin.voyager.messaging.FullConversation&count=10', accept: 'application/vnd.linkedin.normalized+json+2.1' },

    // messaging/conversationsBySyncToken (another known pattern)
    { url: '/voyager/api/messaging/conversationsBySyncToken', accept: 'application/vnd.linkedin.normalized+json+2.1' },
  ];

  for (const ep of endpoints) {
    const url = `https://www.linkedin.com${ep.url}`;
    try {
      const finalHeaders = {
        ...headers,
        Accept: ep.accept,
        ...(ep as Record<string, unknown>).extraHeaders as Record<string, string> | undefined ?? {},
      };
      const res = await fetch(url, {
        headers: finalHeaders,
        signal: AbortSignal.timeout(10000),
      });

      const contentType = res.headers.get('content-type') ?? '';
      let preview = '';

      if (contentType.includes('json')) {
        const json = await res.json() as Record<string, unknown>;
        if (res.ok) {
          const keys = Object.keys(json);
          const elements = json['elements'];
          const included = json['included'];
          const data = json['data'];
          preview = `keys=[${keys.join(',')}]`;
          if (Array.isArray(elements)) preview += ` elements=${elements.length}`;
          if (Array.isArray(included)) preview += ` included=${included.length}`;
          if (data && typeof data === 'object') {
            const dataKeys = Object.keys(data as Record<string, unknown>);
            preview += ` data.keys=[${dataKeys.join(',')}]`;
          }
        } else {
          preview = JSON.stringify(json).slice(0, 200);
        }
      } else {
        preview = `(non-JSON: ${contentType})`;
      }

      const icon = res.ok ? '✓' : '✗';
      console.log(`\n${icon} ${res.status} ${ep.url}`);
      console.log(`  ${preview}`);
    } catch (err) {
      console.log(`\n✗ ERR ${ep.url}`);
      console.log(`  ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
