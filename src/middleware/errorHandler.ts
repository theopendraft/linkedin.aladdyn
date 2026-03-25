/**
 * Error Handling Middleware
 *
 * AppError     — structured error class with statusCode
 * asyncHandler — wraps async route handlers so rejections reach errorHandler
 * errorHandler — Express 4-arg error middleware
 * notFoundHandler — catch-all 404
 */

import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode = 500, isOperational = true) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Maps Prisma error codes to friendly AppErrors.
 */
function handlePrismaError(error: Record<string, unknown>): AppError {
  switch (error['code']) {
    case 'P2002':
      return new AppError('A record with this information already exists', 409);
    case 'P2025':
      return new AppError('Record not found', 404);
    case 'P2003':
      return new AppError('Foreign key constraint failed', 400);
    case 'P2014':
      return new AppError('Invalid ID provided', 400);
    default:
      return new AppError('Database operation failed', 500);
  }
}

/**
 * Central Express error handler.
 * Must be registered after all routes with 4 arguments.
 */
export function errorHandler(
  error: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  let statusCode = 500;
  let message = 'Internal Server Error';

  // Prisma errors have a 'code' property
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as Record<string, unknown>)['code'] === 'string' &&
    ((error as Record<string, unknown>)['code'] as string).startsWith('P')
  ) {
    const prismaErr = handlePrismaError(error as Record<string, unknown>);
    statusCode = prismaErr.statusCode;
    message = prismaErr.message;
  } else if (error instanceof AppError) {
    statusCode = error.statusCode;
    message = error.message;
  } else if (error.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token';
  } else if (error.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token expired';
  } else if (error.name === 'ValidationError') {
    statusCode = 400;
    message = error.message;
  } else {
    message = error.message || message;
  }

  console.error(
    `[ErrorHandler] ${req.method} ${req.path} → ${statusCode}: ${message}`
  );

  if (statusCode >= 500) {
    console.error('[ErrorHandler] Stack:', error.stack);
  }

  const body: Record<string, unknown> = { success: false, error: message };

  if (process.env.NODE_ENV === 'development' && statusCode >= 500) {
    body['stack'] = error.stack;
  }

  res.status(statusCode).json(body);
}

/**
 * Wraps an async Express handler so any rejected promise is forwarded to next().
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Catch-all 404 — register after all routes, before errorHandler.
 */
export function notFoundHandler(req: Request, res: Response, next: NextFunction): void {
  next(new AppError(`Route ${req.method} ${req.path} not found`, 404));
}
