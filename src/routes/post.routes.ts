import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  createPost,
  listPosts,
  getPost,
  updatePost,
  deletePost,
  approvePost,
  publishPost,
  scorePostHandler,
  bulkApprove,
  analyticsSummary,
} from '../controllers/post.controller';

const router = Router();

// All post routes require JWT auth
router.use(requireAuth);

router.post('/', createPost);
router.get('/', listPosts);
router.post('/bulk-approve', bulkApprove);
router.get('/analytics/summary', analyticsSummary);
router.get('/:id', getPost);
router.put('/:id', updatePost);
router.delete('/:id', deletePost);
router.post('/:id/approve', approvePost);
router.post('/:id/publish', publishPost);
router.post('/:id/score', scorePostHandler);

export default router;
