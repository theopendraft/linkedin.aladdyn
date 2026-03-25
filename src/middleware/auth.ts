/**
 * Authentication Middleware
 *
 * requireAuth      — validates Bearer JWT tokens issued by server.aladdyn
 * requireInternalSecret — validates x-internal-secret header for service-to-service calls
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthUser {
  id: string;
  email?: string;
  role?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Validates Bearer JWT from server.aladdyn.
 * Attaches decoded payload to req.user.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: 'Missing or invalid Authorization header',
    });
    return;
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SECRET || 'fallback-secret';

  try {
    const decoded = jwt.verify(token, secret) as AuthUser & { userId?: string };
    // server.aladdyn signs tokens with `userId`, normalise to `id`
    req.user = { ...decoded, id: decoded.id ?? decoded.userId ?? '' };
    next();
  } catch {
    res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
    });
  }
}

/**
 * Validates x-internal-secret header for internal service-to-service calls.
 * Used by /internal/* routes called from server.aladdyn or cron jobs.
 */
export function requireInternalSecret(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = req.headers['x-internal-secret'];
  const expected = process.env.INTERNAL_API_SECRET || 'aladdyn-internal-secret';

  if (!secret || secret !== expected) {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return;
  }

  next();
}
