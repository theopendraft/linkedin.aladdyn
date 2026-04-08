import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  connectOAuth,
  connectSession,
  launchSessionConnect,
  sessionConnectStatus,
  listAccounts,
  getAccount,
  disconnectAccount,
  toggleAutoReply,
  refreshToken,
  triggerAnalyticsSync,
  getAccountStatus,
} from '../controllers/account.controller';

const router = Router();

// All account routes require JWT auth
router.use(requireAuth);

router.post('/connect/oauth', connectOAuth);
router.post('/connect/session', connectSession);
router.post('/connect/session/launch', launchSessionConnect);
router.get('/connect/session/status/:sessionId', sessionConnectStatus);
router.get('/', listAccounts);
router.get('/:id', getAccount);
router.delete('/:id', disconnectAccount);
router.put('/:id/auto-reply', toggleAutoReply);
router.post('/:id/refresh-token', refreshToken);
router.post('/:id/analytics/sync', triggerAnalyticsSync);
router.get('/:id/status', getAccountStatus);

export default router;
