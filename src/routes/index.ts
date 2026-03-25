/**
 * Route Registry
 *
 * Mounts all route modules onto a single Express Router.
 * Imported once in server.ts.
 */

import { Router } from 'express';
import healthRoutes from './health.routes';
import accountRoutes from './account.routes';
import oauthRoutes from './oauth.routes';
import postRoutes from './post.routes';
import inboxRoutes from './inbox.routes';
import internalRoutes from './internal.routes';

const router = Router();

router.use('/health', healthRoutes);
// OAuth routes must come before accountRoutes — accountRoutes has a catch-all
// requireAuth middleware that would 401 the LinkedIn callback redirect
router.use('/api/accounts/auth/linkedin', oauthRoutes);
router.use('/api/accounts', accountRoutes);
router.use('/api/posts', postRoutes);
router.use('/api/inbox', inboxRoutes);
router.use('/internal', internalRoutes);

export default router;
