import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  listConversations,
  getConversation,
  sendReply,
  toggleConversationAutoReply,
  triggerSync,
  listPendingDMs,
  approvePendingDM,
  skipPendingDM,
} from '../controllers/inbox.controller';

const router = Router();

// All inbox routes require JWT auth
router.use(requireAuth);

router.get('/', listConversations);
// Static paths must come before /:conversationId to avoid param capture
router.post('/sync', triggerSync);
router.get('/pending-dms', listPendingDMs);
router.post('/enrollment/:enrollmentId/approve', approvePendingDM);
router.post('/enrollment/:enrollmentId/skip', skipPendingDM);
router.get('/:conversationId', getConversation);
router.post('/:conversationId/reply', sendReply);
router.put('/:conversationId/auto-reply', toggleConversationAutoReply);

export default router;
