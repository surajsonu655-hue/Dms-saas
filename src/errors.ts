import type { ErrorRequestHandler, Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details: any[] = []) { super(message); }
}
export const badRequest = (m: string, details: any[] = []) => new AppError(400, 'VALIDATION_ERROR', m, details);
export const unauthorized = (m = 'Authentication required', code = 'UNAUTHORIZED') => new AppError(401, code, m);
export const forbidden = (m = 'You do not have permission to perform this action', code = 'FORBIDDEN') => new AppError(403, code, m);
export const notFound = (m = 'Resource not found') => new AppError(404, 'NOT_FOUND', m);
export const conflict = (m: string, code = 'CONFLICT') => new AppError(409, code, m);
export const invalidTransition = (m: string) => new AppError(409, 'INVALID_TRANSITION', m);

export const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500, code = 'INTERNAL_ERROR', message = 'Something went wrong. Please try again.', details: any[] = [];
  if (err instanceof AppError) { status = err.status; code = err.code; message = err.message; details = err.details; }
  else if (err instanceof ZodError) {
    status = 400; code = 'VALIDATION_ERROR'; message = 'Invalid request data';
    details = err.issues.map(i => ({ path: i.path.join('.'), message: i.message }));
  } else if (err?.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body too large'; }
  else if (err?.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; message = 'Malformed JSON body'; }
  else if (err?.code === 'LIMIT_FILE_SIZE') { status = 413; code = 'FILE_TOO_LARGE'; message = 'File is too large'; }
  else if (err?.code === '23505') { status = 409; code = 'CONFLICT'; message = 'A record with the same unique value already exists'; }
  else if (err?.code === '23503') { status = 409; code = 'CONFLICT'; message = 'Related record does not exist or is still in use'; }
  else if (err?.code === '23514') { status = 400; code = 'VALIDATION_ERROR'; message = 'A value violates a data rule'; }
  else if (err?.code === '22P02') { status = 400; code = 'VALIDATION_ERROR'; message = 'Invalid identifier or value format'; }
  if (status >= 500) console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err); // technical details stay server-side
  res.status(status).json({ success: false, message, code, error: { code, message, details } });
};
