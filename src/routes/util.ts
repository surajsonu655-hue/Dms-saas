import type { Request } from 'express';
import { pageQuery } from '../validate.js';
export const paging = (req: Request) => { const p = pageQuery.parse(req.query); return { ...p, offset: (p.page - 1) * p.limit }; };
export const meta = (p: { page: number; limit: number }, total: number) => ({ page: p.page, limit: p.limit, total, totalPages: Math.max(1, Math.ceil(total / p.limit)) });
export const sortBy = (req: Request, allowed: Record<string, string>, def: string) => {
  const col = allowed[String(req.query.sort ?? '')] ?? def; const dir = String(req.query.dir ?? 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'; return `${col} ${dir}`;
};
