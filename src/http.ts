import type { Response } from 'express';
export const ok = (res: Response, data: any, message = 'OK', status = 200, meta?: any) =>
  res.status(status).json({ success: true, data, message, ...(meta ? { meta } : {}) });
export const created = (res: Response, data: any, message = 'Created') => ok(res, data, message, 201);
