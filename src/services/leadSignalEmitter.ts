/**
 * Lead Signal Emitter
 *
 * After a post engagement scrape, emits lead signals to server.aladdyn
 * for each new liker/commenter. server.aladdyn creates canonical Conversation
 * records and triggers AI DM suggestion generation.
 *
 * Fully isolated — errors are logged, never thrown to caller.
 * Respects the contract: linkedin.aladdyn failures never cascade.
 */

import prisma from '../lib/prisma';
import type { EngagerInfo, CommentInfo } from './engagementScraper';

const SERVER_ALADDYN_URL = process.env.SERVER_ALADDYN_URL ?? 'http://localhost:3001';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET ?? '';

interface LeadSignalPayload {
  source: 'LINKEDIN';
  funnelId: string;
  userId: string;
  externalProfileId: string;
  externalProfileUrl?: string;
  name?: string;
  headline?: string;
  company?: string;
  engagementType: 'LIKE' | 'COMMENT' | 'SHARE';
  content?: string;
  postId: string;
  postTitle?: string;
  idempotencyKey: string;
}

async function emitSignal(payload: LeadSignalPayload): Promise<void> {
  try {
    const res = await fetch(`${SERVER_ALADDYN_URL}/internal/lead-signal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': INTERNAL_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(
        `[LeadSignalEmitter] server.aladdyn rejected signal for ${payload.externalProfileId}: ` +
          `${res.status} ${text.slice(0, 200)}`
      );
    }
  } catch (err) {
    // Network failure — log only, never throw
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[LeadSignalEmitter] Network error emitting signal: ${msg}`);
  }
}

/**
 * Emit lead signals to server.aladdyn for all engagers on a post.
 * Also marks each engagement record with leadSignalSentAt.
 */
export async function emitLeadSignals(
  postId: string,
  accountId: string,
  likes: EngagerInfo[],
  comments: CommentInfo[]
): Promise<void> {
  // Fetch account context (funnelId, userId needed for server.aladdyn)
  const account = await prisma.linkedInAccount.findUnique({
    where: { id: accountId },
    select: { funnelId: true, userId: true },
  });

  if (!account) {
    console.error(`[LeadSignalEmitter] Account ${accountId} not found — skipping lead signals`);
    return;
  }

  // Fetch post for title context
  const post = await prisma.linkedInPost.findUnique({
    where: { id: postId },
    select: { text: true },
  });

  // Use first ~80 chars of post text as title proxy
  const postTitle = post?.text ? post.text.slice(0, 80).replace(/\n/g, ' ') : undefined;

  const { funnelId, userId } = account;
  const now = new Date();

  // Emit for likes
  for (const liker of likes) {
    const idempotencyKey = `LINKEDIN:${postId}:${liker.linkedinId}:LIKE`;

    await emitSignal({
      source: 'LINKEDIN',
      funnelId,
      userId,
      externalProfileId: liker.linkedinId,
      externalProfileUrl: `https://www.linkedin.com/in/${liker.linkedinId}`,
      name: liker.displayName,
      headline: liker.headline,
      engagementType: 'LIKE',
      postId,
      postTitle,
      idempotencyKey,
    });

    // Mark engagement record as signal-sent (resolve profileId first — updateMany has no relation filter)
    await prisma.linkedInProfile
      .findUnique({ where: { linkedinId: liker.linkedinId }, select: { id: true } })
      .then((p) => {
        if (!p) return;
        return prisma.linkedInEngagement.updateMany({
          where: { postId, profileId: p.id, type: 'LIKE', leadSignalSentAt: null },
          data: { leadSignalSentAt: now },
        });
      })
      .catch(() => {}); // non-critical
  }

  // Emit for comments
  for (const commenter of comments) {
    const idempotencyKey = `LINKEDIN:${postId}:${commenter.linkedinId}:COMMENT`;

    await emitSignal({
      source: 'LINKEDIN',
      funnelId,
      userId,
      externalProfileId: commenter.linkedinId,
      externalProfileUrl: `https://www.linkedin.com/in/${commenter.linkedinId}`,
      name: commenter.displayName,
      headline: commenter.headline,
      engagementType: 'COMMENT',
      content: commenter.commentText,
      postId,
      postTitle,
      idempotencyKey,
    });

    await prisma.linkedInProfile
      .findUnique({ where: { linkedinId: commenter.linkedinId }, select: { id: true } })
      .then((p) => {
        if (!p) return;
        return prisma.linkedInEngagement.updateMany({
          where: { postId, profileId: p.id, type: 'COMMENT', leadSignalSentAt: null },
          data: { leadSignalSentAt: now },
        });
      })
      .catch(() => {});
  }
}
