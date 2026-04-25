/**
 * linkedin.aladdyn — Express API Server
 *
 * Port: 4002
 *
 * On startup:
 * - Mounts all routes
 * - Starts BullMQ workers (non-fatal if Redis is down)
 * - Starts schedulers (inbox sync ~60s, post scheduler 60s)
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import router from './routes/index';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { startPublishWorker } from './jobs/workers/publishWorker';
import { startInboxSyncWorker } from './jobs/workers/inboxSyncWorker';
import { startEngagementWorker } from './jobs/workers/engagementWorker';
import { startAnalyticsWorker } from './jobs/workers/analyticsWorker';
import { startInboxScheduler } from './jobs/scheduler';


const app = express();
const PORT = parseInt(process.env.PORT ?? '4002', 10);

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors({
  origin: process.env.CORS_ORIGIN ?? '*',
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.use(router);

// ── Error Handling ────────────────────────────────────────────────────────────

app.use(notFoundHandler);
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log(`║  linkedin.aladdyn v1.0.0 — port ${PORT}     ║`);
  console.log('╚══════════════════════════════════════════╝\n');

  console.log('Available endpoints:');
  console.log('  GET    /health');
  console.log('  POST   /api/accounts/auth/linkedin/init');
  console.log('  GET    /api/accounts/auth/linkedin/callback');
  console.log('  POST   /api/accounts/connect/oauth');
  console.log('  POST   /api/accounts/connect/session');
  console.log('  POST   /api/accounts/connect/session/launch');
  console.log('  GET    /api/accounts/connect/session/status/:sessionId');
  console.log('  GET    /api/accounts');
  console.log('  GET    /api/accounts/:id');
  console.log('  DELETE /api/accounts/:id');
  console.log('  PUT    /api/accounts/:id/auto-reply');
  console.log('  POST   /api/accounts/:id/refresh-token');
  console.log('  POST   /api/posts');
  console.log('  GET    /api/posts');
  console.log('  GET    /api/posts/:id');
  console.log('  PUT    /api/posts/:id');
  console.log('  DELETE /api/posts/:id');
  console.log('  POST   /api/posts/:id/approve');
  console.log('  POST   /api/posts/:id/publish');
  console.log('  POST   /api/posts/:id/score');
  console.log('  GET    /api/inbox');
  console.log('  GET    /api/inbox/:conversationId');
  console.log('  POST   /api/inbox/:conversationId/reply');
  console.log('  PUT    /api/inbox/:conversationId/auto-reply');
  console.log('  POST   /api/inbox/sync');
  console.log('  POST   /internal/inbox/process-replies      [x-internal-secret]');
  console.log('  POST   /internal/posts/publish-due          [x-internal-secret]');
  console.log('  POST   /internal/posts/create-from-social   [x-internal-secret]');
  console.log('  POST   /internal/reply-suggestion           [x-internal-secret]');
  console.log('  POST   /internal/posts/:postId/scrape-engagement [x-internal-secret]');
  console.log('  POST   /internal/analytics/sync             [x-internal-secret]');
  console.log('  GET    /api/inbox/pending-dms               [auth]');
  console.log('  POST   /api/inbox/enrollment/:id/approve    [auth]');
  console.log('  POST   /api/inbox/enrollment/:id/skip       [auth]');
  console.log();

  // Start workers — non-fatal if Redis is unavailable on boot
  try {
    startPublishWorker();
    startInboxSyncWorker();
    startEngagementWorker();
    startAnalyticsWorker();
    console.log('[Server] BullMQ workers started');
  } catch (err) {
    console.error(
      '[Server] Failed to start BullMQ workers (Redis may be down):',
      err instanceof Error ? err.message : String(err)
    );
    console.warn('[Server] Server will continue without queue workers. Restart when Redis is available.');
  }

  // Start inbox scheduler — polls every ~60s ±15s for auto-reply accounts
  startInboxScheduler();

  console.log(`\n[Server] Ready — http://localhost:${PORT}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received — shutting down');
  process.exit(0);
});

export default app;
