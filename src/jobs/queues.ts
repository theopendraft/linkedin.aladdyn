/**
 * BullMQ Queue Definitions
 *
 * linkedin-publish        — post publishing jobs
 * linkedin-inbox-sync     — inbox sync + auto-reply jobs
 * linkedin-analytics-sync — periodic analytics fetch from LinkedIn API
 * linkedin-engagement     — engagement scraping (who liked/commented)
 * linkedin-sequence       — outreach sequence step processing
 */

import { Queue } from 'bullmq';
import { redisConnection } from './redis';

// ── Queue names ────────────────────────────────────────────────────────────────

export const QUEUE_NAMES = {
  PUBLISH: 'linkedin-publish',
  INBOX_SYNC: 'linkedin-inbox-sync',
  ANALYTICS_SYNC: 'linkedin-analytics-sync',
  ENGAGEMENT: 'linkedin-engagement',
  SEQUENCE: 'linkedin-sequence',
} as const;

// ── Job data types ─────────────────────────────────────────────────────────────

export interface PublishJobData {
  postId: string;
  accountId: string;
}

export interface InboxSyncJobData {
  accountId: string;
  triggerAutoReply: boolean;
}

export interface AnalyticsSyncJobData {
  accountId: string;
}

export interface EngagementJobData {
  postId: string;
  accountId: string;
}

export interface SequenceJobData {
  type: 'process-due' | 'auto-enroll';
  postId?: string; // for auto-enroll
}

// ── Queue instances ────────────────────────────────────────────────────────────

/** Post publishing queue — processes SCHEDULED posts at their target time */
export const publishQueue = new Queue<PublishJobData>(QUEUE_NAMES.PUBLISH, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 15_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

/** Inbox sync queue — fetches new messages and triggers auto-reply if enabled */
export const inboxSyncQueue = new Queue<InboxSyncJobData>(QUEUE_NAMES.INBOX_SYNC, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 30_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
});

/** Analytics sync queue — fetches post analytics from LinkedIn API */
export const analyticsSyncQueue = new Queue<AnalyticsSyncJobData>(QUEUE_NAMES.ANALYTICS_SYNC, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 60_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
});

/** Engagement scrape queue — scrapes who liked/commented on posts */
export const engagementQueue = new Queue<EngagementJobData>(QUEUE_NAMES.ENGAGEMENT, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 300 },
    removeOnFail: { count: 100 },
  },
});

/** Sequence processing queue — sends due sequence messages */
export const sequenceQueue = new Queue<SequenceJobData>(QUEUE_NAMES.SEQUENCE, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 30_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
});
