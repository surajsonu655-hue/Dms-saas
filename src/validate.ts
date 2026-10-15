import { z } from 'zod';

export const uuid = z.string().uuid('Must be a valid UUID');
export const mobile = z.string().trim().regex(/^\+?[0-9]{10,15}$/, 'Mobile must be 10-15 digits');
export const email = z.string().trim().toLowerCase().email();
export const money = z.coerce.number().finite().min(0).max(1_000_000_000).refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At most 2 decimal places');
export const positiveMoney = money.refine(v => v > 0, 'Must be greater than 0');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const password = z.string().min(8).max(128)
  .refine(v => /[A-Z]/.test(v) && /[0-9]/.test(v), 'Password needs at least one capital letter and one number');
export const modeKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,24}$/, 'Invalid payment mode');
export const lat = z.coerce.number().min(-90).max(90);
export const lng = z.coerce.number().min(-180).max(180);
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const likePattern = (s: string) => '%' + s.replace(/[\\%_]/g, m => '\\' + m) + '%';
