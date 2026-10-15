import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { one, query } from './db.js';
import { forbidden, unauthorized, wrap } from './errors.js';
import { loadPermissions, PLATFORM_PERMISSIONS, BUSINESS_PERMISSIONS, type Role } from './permissions.js';
import { randomToken, sha256 } from './crypto.js';

export interface Auth {
  kind: 'user' | 'api_key';
  userId: string | null;           // null for API keys
  role: Role | 'api';
  businessId: string | null;       // ALWAYS derived server-side; never read from request bodies
  sessionId: string | null;
  perms: Set<string>;
  name: string;
}
declare module 'express-serve-static-core' { interface Request { auth?: Auth } }

export const hashPassword = (p: string) => bcrypt.hash(p, config.isTest ? 4 : 11);
export const verifyPassword = (p: string, h: string) => bcrypt.compare(p, h);

export function signAccessToken(userId: string, sid: string) {
  return jwt.sign({ sub: userId, sid }, config.jwtSecret, { expiresIn: config.accessTtlSec, issuer: 'dms' });
}
export async function createSession(userId: string, ip?: string, ua?: string) {
  const refresh = randomToken(40);
  const expires = new Date(Date.now() + config.refreshTtlDays * 864e5);
  const s = await one<{ id: string }>(`INSERT INTO sessions(user_id,refresh_hash,expires_at,ip,user_agent) VALUES($1,$2,$3,$4,$5) RETURNING id`, [userId, sha256(refresh), expires, ip ?? null, ua ?? null]);
  return { sessionId: s!.id, accessToken: signAccessToken(userId, s!.id), refreshToken: refresh, expiresIn: config.accessTtlSec };
}

async function authFromBearer(token: string): Promise<Auth> {
  let payload: any;
  try { payload = jwt.verify(token, config.jwtSecret, { issuer: 'dms' }); } catch { throw unauthorized('Session expired or invalid', 'TOKEN_INVALID'); }
  const row = await one<any>(`SELECT u.id,u.role,u.business_id,u.name,u.status,u.deleted_at,b.status AS bstatus,b.deleted_at AS bdeleted,
                                     s.revoked_at,s.expires_at
                                FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN businesses b ON b.id=u.business_id
                               WHERE s.id=$1 AND u.id=$2`, [payload.sid, payload.sub]);
  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) throw unauthorized('Session has ended. Please sign in again.', 'SESSION_ENDED');
  if (row.status !== 'active' || row.deleted_at) throw forbidden('Your account is not active', 'ACCOUNT_INACTIVE');
  if (row.role !== 'owner' && (row.bstatus !== 'active' || row.bdeleted)) throw forbidden('This business is not active. Contact the platform owner.', 'BUSINESS_SUSPENDED');
  const perms = row.role === 'owner' ? new Set([...BUSINESS_PERMISSIONS, ...PLATFORM_PERMISSIONS]) : await loadPermissions(row.id);
  return { kind: 'user', userId: row.id, role: row.role, businessId: row.business_id, sessionId: payload.sid, perms, name: row.name };
}

export const SCOPE_PERMISSIONS = ['orders.view', 'orders.create', 'orders.edit', 'customers.view', 'customers.create', 'deliveries.view', 'reports.view'];

async function authFromApiKey(key: string): Promise<Auth> {
  const row = await one<any>(`SELECT k.id,k.business_id,k.scopes,k.revoked_at,b.status,b.deleted_at FROM api_keys k JOIN businesses b ON b.id=k.business_id WHERE k.key_hash=$1`, [sha256(key)]);
  if (!row || row.revoked_at) throw unauthorized('Invalid API key', 'API_KEY_INVALID');
  if (row.status !== 'active' || row.deleted_at) throw forbidden('This business is not active', 'BUSINESS_SUSPENDED');
  await query(`UPDATE api_keys SET last_used_at=now() WHERE id=$1`, [row.id]);
  return { kind: 'api_key', userId: null, role: 'api', businessId: row.business_id, sessionId: null, perms: new Set(row.scopes), name: 'API key' };
}

export const authenticate = wrap(async (req: Request, _res: Response, next: NextFunction) => {
  const h = req.headers.authorization, k = req.headers['x-api-key'];
  if (h?.startsWith('Bearer ')) req.auth = await authFromBearer(h.slice(7));
  else if (typeof k === 'string' && k) req.auth = await authFromApiKey(k);
  else throw unauthorized();
  next();
});

/** Operational endpoints are tenant-scoped; the platform owner does not operate individual deliveries. */
export const requireTenant = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth?.businessId) return next(forbidden('The platform owner does not operate business deliveries', 'OWNER_NOT_OPERATIONAL'));
  next();
};
export const requireRole = (...roles: (Role | 'api')[]) => (req: Request, _res: Response, next: NextFunction) =>
  roles.includes(req.auth!.role) ? next() : next(forbidden());
export const requirePerm = (...perms: string[]) => (req: Request, _res: Response, next: NextFunction) => {
  const a = req.auth!;
  const ok = perms.every(p => a.perms.has(p));
  ok ? next() : next(forbidden(`Missing permission: ${perms.filter(p => !a.perms.has(p)).join(', ')}`, 'PERMISSION_DENIED'));
};
/** Business staff (admin/manager) or an API key; partners are excluded from management endpoints. */
export const notPartner = (req: Request, _res: Response, next: NextFunction) =>
  req.auth!.role === 'delivery_partner' ? next(forbidden()) : next();
export const biz = (req: Request) => req.auth!.businessId!;
