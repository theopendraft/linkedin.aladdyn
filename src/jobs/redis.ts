/**
 * Shared Redis connection configuration for BullMQ.
 *
 * All queues and workers reuse this connection config.
 * BullMQ calls .duplicate() internally per worker — no manual duplication needed.
 */

function parseRedisUrl(url: string): { host: string; port: number; password?: string } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

const { host, port, password } = parseRedisUrl(
  process.env.REDIS_URL || 'redis://localhost:6379'
);

export const redisConnection = {
  host,
  port,
  ...(password ? { password } : {}),
  maxRetriesPerRequest: null as null, // Required by BullMQ
};
