/**
 * Bull Board — Queue Monitoring UI
 *
 * Can run standalone: npm run queue:ui → http://localhost:4003/ui
 * Also mountable into the main Express app via getBullBoardRouter().
 */

import 'dotenv/config';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import {
  publishQueue,
  inboxSyncQueue,
  analyticsSyncQueue,
  engagementQueue,
  sequenceQueue,
} from './queues';

/**
 * Creates and returns a Bull Board Express adapter mounted at the given base path.
 * Use in the main server: app.use('/admin/queues', getBullBoardRouter())
 */
export function getBullBoardRouter(basePath = '/admin/queues') {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(basePath);

  createBullBoard({
    queues: [
      new BullMQAdapter(publishQueue) as never,
      new BullMQAdapter(inboxSyncQueue) as never,
      new BullMQAdapter(analyticsSyncQueue) as never,
      new BullMQAdapter(engagementQueue) as never,
      new BullMQAdapter(sequenceQueue) as never,
    ],
    serverAdapter,
  });

  return serverAdapter.getRouter();
}

// ── Standalone mode (npm run queue:ui) ────────────────────────────────────────

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const express = require('express') as typeof import('express');
  const app = express();

  const PORT = 4003;
  app.use('/ui', getBullBoardRouter('/ui'));

  app.listen(PORT, () => {
    console.log(`[BullBoard] Dashboard running at http://localhost:${PORT}/ui`);
    console.log(
      '[BullBoard] Monitoring queues: ' +
        'linkedin-publish, linkedin-inbox-sync, linkedin-analytics-sync, ' +
        'linkedin-engagement, linkedin-sequence'
    );
  });
}
