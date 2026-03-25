/**
 * LinkedIn Voyager API Client
 *
 * Direct HTTP client that uses stored session cookies (li_at + JSESSIONID)
 * to call LinkedIn's internal voyager API. No browser needed.
 *
 * This is the same approach used by LinkedIn automation tools:
 * - li_at cookie = session auth
 * - JSESSIONID value = CSRF token (sent as csrf-token header)
 *
 * Advantages over Playwright interception:
 * - Faster (no browser overhead)
 * - More reliable (direct API calls, not fragile interception)
 * - Can poll frequently (every 30-60s)
 *
 * Hard constraints:
 * - Never log cookie values or message content in production
 * - Randomize polling intervals
 * - Respect daily action limits
 */

import { decrypt } from '../lib/encrypt';

// ── Types ────────────────────────────────────────────────────────────────────

interface StoredCookie {
  name: string;
  value: string;
  domain?: string;
}

export interface VoyagerConversation {
  conversationUrn: string;
  participantPublicId: string;
  participantName: string;
  participantHeadline: string;
  lastMessageText: string;
  lastMessageAt: number | null;
  unreadCount: number;
  messages: VoyagerMessage[];
}

export interface VoyagerMessage {
  text: string;
  senderPublicId: string;
  createdAt: number;
}

// ── Cookie helpers ───────────────────────────────────────────────────────────

function extractSessionTokens(encryptedCookies: string): {
  liAt: string;
  jsessionId: string;
  allCookies: string;
} {
  const cookieJson = decrypt(encryptedCookies);
  const cookies: StoredCookie[] = JSON.parse(cookieJson);

  const liAt = cookies.find((c) => c.name === 'li_at')?.value;
  const jsessionRaw = cookies.find((c) => c.name === 'JSESSIONID')?.value;
  // JSESSIONID is stored with surrounding quotes — strip them for the CSRF header
  const jsessionId = jsessionRaw?.replace(/"/g, '') ?? '';

  if (!liAt) throw new Error('SESSION_EXPIRED: No li_at cookie found');
  if (!jsessionId) throw new Error('SESSION_EXPIRED: No JSESSIONID cookie found');

  // Build full cookie header from all stored cookies
  const allCookies = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  return { liAt, jsessionId, allCookies };
}

function buildHeaders(tokens: { jsessionId: string; allCookies: string }): Record<string, string> {
  return {
    Cookie: tokens.allCookies,
    'csrf-token': tokens.jsessionId,
    Accept: 'application/vnd.linkedin.normalized+json+2.1',
    'x-restli-protocol-version': '2.0.0',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-li-lang': 'en_US',
    'x-li-page-instance': 'urn:li:page:messaging_thread;' + Math.random().toString(36).slice(2),
    'x-li-track': JSON.stringify({
      clientVersion: '1.13.17',
      mpVersion: '1.13.17',
      osName: 'web',
      timezoneOffset: 5.5,
      timezone: 'Asia/Calcutta',
      deviceFormFactor: 'DESKTOP',
      mpName: 'voyager-web',
      displayDensity: 1,
    }),
  };
}

// ── API calls ────────────────────────────────────────────────────────────────

/**
 * Fetches the conversation list from LinkedIn's messaging inbox.
 */
export async function fetchConversations(
  encryptedCookies: string,
  accountLinkedinId: string | null
): Promise<VoyagerConversation[]> {
  const tokens = extractSessionTokens(encryptedCookies);
  const headers = buildHeaders(tokens);

  const url =
    'https://www.linkedin.com/voyager/api/messaging/conversations' +
    '?keyVersion=LEGACY_INBOX&q=syncToken&count=20';

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('SESSION_EXPIRED');
    }
    throw new Error(`LinkedIn conversations API error: ${res.status}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  return parseConversationsResponse(json, accountLinkedinId);
}

/**
 * Fetches messages within a specific conversation thread.
 */
export async function fetchConversationMessages(
  encryptedCookies: string,
  conversationUrn: string,
  accountLinkedinId: string | null,
  count = 20
): Promise<VoyagerMessage[]> {
  const tokens = extractSessionTokens(encryptedCookies);
  const headers = buildHeaders(tokens);

  // URL-encode the URN
  const encoded = encodeURIComponent(conversationUrn);
  const url =
    `https://www.linkedin.com/voyager/api/messaging/conversations/${encoded}/events` +
    `?count=${count}`;

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('SESSION_EXPIRED');
    }
    throw new Error(`LinkedIn events API error: ${res.status}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  return parseEventsResponse(json, accountLinkedinId);
}

/**
 * Sends a message to an existing conversation.
 */
export async function sendMessageViaAPI(
  encryptedCookies: string,
  conversationUrn: string,
  text: string
): Promise<void> {
  const tokens = extractSessionTokens(encryptedCookies);
  const headers = {
    ...buildHeaders(tokens),
    'Content-Type': 'application/json',
  };

  const encoded = encodeURIComponent(conversationUrn);
  const url = `https://www.linkedin.com/voyager/api/messaging/conversations/${encoded}/events`;

  const body = JSON.stringify({
    eventCreate: {
      value: {
        'com.linkedin.voyager.messaging.create.MessageCreate': {
          attributedBody: {
            text,
            attributes: [],
          },
          attachments: [],
        },
      },
    },
    dedupeByClientGeneratedToken: false,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('SESSION_EXPIRED');
    }
    const text = await res.text().catch(() => '');
    throw new Error(`LinkedIn send message error: ${res.status} — ${text.slice(0, 200)}`);
  }
}

// ── Response parsers ─────────────────────────────────────────────────────────

/**
 * LinkedIn's voyager response contains 'included' (entities) and 'elements' (threads).
 * We need to resolve participants and messages from the 'included' array.
 */
function parseConversationsResponse(
  data: Record<string, unknown>,
  accountLinkedinId: string | null
): VoyagerConversation[] {
  const elements = (data['elements'] as Record<string, unknown>[]) ?? [];
  const included = (data['included'] as Record<string, unknown>[]) ?? [];

  // Build a lookup map for included entities by entityUrn
  const entityMap = new Map<string, Record<string, unknown>>();
  for (const item of included) {
    const urn = item['entityUrn'] as string | undefined;
    if (urn) entityMap.set(urn, item);
  }

  const results: VoyagerConversation[] = [];

  for (const conv of elements) {
    try {
      const entityUrn = (conv['entityUrn'] as string) ?? '';
      const lastActivityAt = (conv['lastActivityAt'] as number) ?? null;

      // Participants — resolve from included entities
      const participantUrns =
        ((conv['*participants'] as string[]) ?? []).length > 0
          ? (conv['*participants'] as string[])
          : ((conv['participants'] as string[]) ?? []);

      let participantPublicId = '';
      let participantName = '';
      let participantHeadline = '';

      for (const pUrn of participantUrns) {
        const participant = entityMap.get(pUrn);
        if (!participant) continue;

        // Resolve the mini profile reference
        const miniProfileUrn =
          (participant['*miniProfile'] as string) ??
          (participant['miniProfile'] as string) ??
          '';
        const miniProfile = entityMap.get(miniProfileUrn) ?? participant;

        const pubId = (miniProfile['publicIdentifier'] as string) ?? '';
        // Skip the account owner's own participant entry
        if (pubId && pubId !== accountLinkedinId) {
          participantPublicId = pubId;
          const firstName = (miniProfile['firstName'] as string) ?? '';
          const lastName = (miniProfile['lastName'] as string) ?? '';
          participantName = `${firstName} ${lastName}`.trim();
          participantHeadline = (miniProfile['occupation'] as string) ?? '';
          break;
        }
      }

      // If we couldn't identify the other participant, try from included profiles
      if (!participantPublicId) {
        // Fallback: scan included for profiles that aren't the account owner
        for (const item of included) {
          const urn = (item['entityUrn'] as string) ?? '';
          if (
            urn.includes('fs_miniProfile') &&
            (item['publicIdentifier'] as string) !== accountLinkedinId
          ) {
            participantPublicId = (item['publicIdentifier'] as string) ?? '';
            const fn = (item['firstName'] as string) ?? '';
            const ln = (item['lastName'] as string) ?? '';
            participantName = `${fn} ${ln}`.trim();
            participantHeadline = (item['occupation'] as string) ?? '';
            break;
          }
        }
      }

      // Messages from events within the conversation element
      const eventUrns = (conv['*events'] as string[]) ?? [];
      const messages: VoyagerMessage[] = [];
      for (const eUrn of eventUrns) {
        const event = entityMap.get(eUrn);
        if (!event) continue;

        const msg = parseMessageEvent(event, accountLinkedinId);
        if (msg) messages.push(msg);
      }

      // Also check 'events' array directly
      const directEvents = (conv['events'] as Record<string, unknown>[]) ?? [];
      for (const event of directEvents) {
        const msg = parseMessageEvent(event, accountLinkedinId);
        if (msg) messages.push(msg);
      }

      // Last message snippet
      const lastSnippet = messages.length > 0
        ? messages[messages.length - 1].text.slice(0, 200)
        : '';

      const unreadCount = (conv['unreadCount'] as number) ?? 0;

      results.push({
        conversationUrn: entityUrn,
        participantPublicId,
        participantName: participantName || 'Unknown',
        participantHeadline,
        lastMessageText: lastSnippet,
        lastMessageAt: lastActivityAt,
        unreadCount,
        messages,
      });
    } catch (err) {
      console.warn(
        '[LinkedInClient] Failed to parse conversation:',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return results;
}

function parseEventsResponse(
  data: Record<string, unknown>,
  accountLinkedinId: string | null
): VoyagerMessage[] {
  const elements = (data['elements'] as Record<string, unknown>[]) ?? [];
  const included = (data['included'] as Record<string, unknown>[]) ?? [];

  // Build entity lookup from included
  const entityMap = new Map<string, Record<string, unknown>>();
  for (const item of included) {
    const urn = item['entityUrn'] as string | undefined;
    if (urn) entityMap.set(urn, item);
  }

  const messages: VoyagerMessage[] = [];
  for (const event of elements) {
    const msg = parseMessageEvent(event, accountLinkedinId, entityMap);
    if (msg) messages.push(msg);
  }

  return messages;
}

function parseMessageEvent(
  event: Record<string, unknown>,
  accountLinkedinId: string | null,
  entityMap?: Map<string, Record<string, unknown>>
): VoyagerMessage | null {
  const createdAt = (event['createdAt'] as number) ?? 0;
  if (!createdAt) return null;

  // Extract message text — multiple possible shapes
  let text = '';

  // Shape 1: eventContent → MessageEvent → attributedBody → text
  const eventContent = event['eventContent'] as Record<string, unknown> | undefined;
  if (eventContent) {
    const msgEvent =
      (eventContent['com.linkedin.voyager.messaging.event.MessageEvent'] as
        | Record<string, unknown>
        | undefined) ??
      (eventContent['messageEvent'] as Record<string, unknown> | undefined);

    if (msgEvent) {
      const body = msgEvent['attributedBody'] as Record<string, unknown> | undefined;
      text = (body?.['text'] as string) ?? '';

      // Some responses nest body directly
      if (!text) {
        text = (msgEvent['body'] as string) ?? '';
      }
    }
  }

  // Shape 2: direct body field
  if (!text) {
    const body = event['body'] as Record<string, unknown> | undefined;
    text = (body?.['text'] as string) ?? (event['body'] as string) ?? '';
  }

  if (!text.trim()) return null;

  // Determine sender
  let senderPublicId = '';

  // from → MessagingMember → miniProfile → publicIdentifier
  const from = event['from'] as Record<string, unknown> | undefined;
  if (from) {
    const member =
      (from['com.linkedin.voyager.messaging.MessagingMember'] as
        | Record<string, unknown>
        | undefined) ?? from;
    const miniProfile = member['miniProfile'] as Record<string, unknown> | undefined;
    senderPublicId = (miniProfile?.['publicIdentifier'] as string) ?? '';

    // Try resolving from *miniProfile reference
    if (!senderPublicId && entityMap) {
      const miniRef = (member['*miniProfile'] as string) ?? '';
      const resolved = entityMap.get(miniRef);
      if (resolved) {
        senderPublicId = (resolved['publicIdentifier'] as string) ?? '';
      }
    }
  }

  // Also try *from reference
  if (!senderPublicId && entityMap) {
    const fromRef = (event['*from'] as string) ?? '';
    const fromEntity = entityMap.get(fromRef);
    if (fromEntity) {
      const miniRef = (fromEntity['*miniProfile'] as string) ?? '';
      const resolved = entityMap.get(miniRef);
      senderPublicId = (resolved?.['publicIdentifier'] as string) ?? '';
    }
  }

  // Fallback: subtype can hint at direction
  if (!senderPublicId) {
    const subtype = (event['subtype'] as string) ?? '';
    if (subtype === 'MEMBER_TO_MEMBER') {
      senderPublicId = 'unknown-sender';
    }
  }

  return {
    text: text.trim(),
    senderPublicId,
    createdAt,
  };
}
