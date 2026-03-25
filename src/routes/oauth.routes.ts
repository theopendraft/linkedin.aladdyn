import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { initiateOAuth, handleOAuthCallback } from '../controllers/oauth.controller';

const router = Router();

// POST /api/accounts/auth/linkedin/init — requires JWT, returns auth URL
router.post('/init', requireAuth, initiateOAuth);

// GET /api/accounts/auth/linkedin/callback — no JWT (LinkedIn redirects here)
router.get('/callback', handleOAuthCallback);

export default router;
