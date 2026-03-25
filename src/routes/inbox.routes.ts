import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  listConversations,
  getConversation,
  sendReply,
  toggleConversationAutoReply,
  triggerSync,
} from '../controllers/inbox.controller';

const router = Router();

// All inbox routes require JWT auth
router.use(requireAuth);

router.get('/', listConversations);
// /sync must come before /:conversationId to avoid being matched as a param
router.post('/sync', triggerSync);
router.get('/:conversationId', getConversation);
router.post('/:conversationId/reply', sendReply);
router.put('/:conversationId/auto-reply', toggleConversationAutoReply);

export default router;
