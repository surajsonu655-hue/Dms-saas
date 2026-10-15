import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { one, query, tx } from '../db.js';
import { authenticate, createSession, hashPassword, verifyPassword } from '../auth.js';
import { AppError, forbidden, unauthorized, wrap } from '../errors.js';
import { ok } from '../http.js';
import { email, password } from '../validate.js';
import { sha256 } from '../crypto.js';
import { audit } from '../audit.js';
import { loadPermissions, BUSINESS_PERMISSIONS, PLATFORM_PERMISSIONS } from '../permissions.js';

export const authRouter = Router();
const limiter = config.rateLimitEnabled ? rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many attempts. Try again in a minute.', code: 'RATE_LIMITED', error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a minute.', details: [] } } }) : (_q: any, _s: any, n: any) => n();
const DUMMY = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8.3Jb5zJ0Y1n8g9m1Zk0yq6hQ0xV8W';

export async function userProfile(userId: string) {
  const u = await one<any>(`SELECT u.id,u.name,u.email,u.mobile,u.designation,u.role,u.business_id,u.duty_on,u.last_login_at, b.name AS business_name, b.business_type, b.logo_key
                              FROM users u LEFT JOIN businesses b ON b.id=u.business_id WHERE u.id=$1`, [userId]);
  if (!u) return null;
  const perms = u.role === 'owner' ? [...BUSINESS_PERMISSIONS, ...PLATFORM_PERMISSIONS] : [...await loadPermissions(userId)];
  return { id: u.id, name: u.name, email: u.email, mobile: u.mobile, designation: u.designation, role: u.role, dutyOn: u.duty_on, lastLoginAt: u.last_login_at, permissions: perms.sort(),
    business: u.business_id ? { id: u.business_id, name: u.business_name, type: u.business_type } : null };
}

authRouter.post('/login', limiter, wrap(async (req, res) => {
  const b = z.object({ email, password: z.string().min(1).max(128) }).parse(req.body);
  const u = await one<any>(`SELECT u.*, bz.status AS bstatus, bz.deleted_at AS bdeleted FROM users u LEFT JOIN businesses bz ON bz.id=u.business_id WHERE u.email=$1 AND u.deleted_at IS NULL`, [b.email]);
  const good = await verifyPassword(b.password, u?.password_hash ?? DUMMY);   // constant-ish time whether or not the account exists
  if (!u || !good) { await audit(undefined, { action: 'auth.login_failed', entity: 'user', entityId: u?.id, businessId: u?.business_id, newValue: { email: b.email }, req }); throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS'); }
  if (u.status !== 'active') throw forbidden('Your account is deactivated', 'ACCOUNT_INACTIVE');
  if (u.role !== 'owner' && (u.bstatus !== 'active' || u.bdeleted)) throw forbidden('Your business is not active. Contact the platform owner.', 'BUSINESS_SUSPENDED');
  const s = await createSession(u.id, req.ip, req.headers['user-agent']);
  await query(`UPDATE users SET last_login_at=now() WHERE id=$1`, [u.id]);
  await audit(undefined, { auth: { userId: u.id, role: u.role, businessId: u.business_id } as any, action: 'auth.login', entity: 'user', entityId: u.id, req });
  ok(res, { accessToken: s.accessToken, refreshToken: s.refreshToken, expiresIn: s.expiresIn, user: await userProfile(u.id) }, 'Signed in');
}));

authRouter.post('/refresh', limiter, wrap(async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(20).max(200) }).parse(req.body);
  const out = await tx(async c => {
    const s = await one<any>(`SELECT * FROM sessions WHERE refresh_hash=$1 FOR UPDATE`, [sha256(refreshToken)], c);
    if (!s) throw unauthorized('Invalid refresh token', 'TOKEN_INVALID');
    if (s.revoked_at) { await query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [s.user_id], c); throw unauthorized('Refresh token reuse detected. All sessions were ended.', 'TOKEN_REUSED'); }
    if (new Date(s.expires_at) < new Date()) throw unauthorized('Session expired', 'SESSION_ENDED');
    const u = await one<any>(`SELECT u.status,u.deleted_at,b.status AS bstatus FROM users u LEFT JOIN businesses b ON b.id=u.business_id WHERE u.id=$1`, [s.user_id], c);
    if (!u || u.status !== 'active' || u.deleted_at || (u.bstatus && u.bstatus !== 'active')) throw forbidden('Account is not active', 'ACCOUNT_INACTIVE');
    await query(`UPDATE sessions SET revoked_at=now() WHERE id=$1`, [s.id], c);      // rotate
    return s.user_id as string;
  });
  const s = await createSession(out, req.ip, req.headers['user-agent']);
  ok(res, { accessToken: s.accessToken, refreshToken: s.refreshToken, expiresIn: s.expiresIn }, 'Token refreshed');
}));

authRouter.post('/logout', authenticate, wrap(async (req, res) => {
  if (req.auth!.sessionId) await query(`UPDATE sessions SET revoked_at=now() WHERE id=$1`, [req.auth!.sessionId]);
  await audit(undefined, { auth: req.auth, action: 'auth.logout', entity: 'user', entityId: req.auth!.userId ?? undefined, req });
  ok(res, null, 'Signed out');
}));

authRouter.get('/me', authenticate, wrap(async (req, res) => {
  if (!req.auth!.userId) throw forbidden('API keys have no user profile');
  ok(res, await userProfile(req.auth!.userId));
}));

authRouter.post('/change-password', authenticate, wrap(async (req, res) => {
  const b = z.object({ currentPassword: z.string().min(1), newPassword: password }).parse(req.body);
  if (!req.auth!.userId) throw forbidden();
  const u = await one<any>(`SELECT password_hash FROM users WHERE id=$1`, [req.auth!.userId]);
  if (!(await verifyPassword(b.currentPassword, u.password_hash))) throw new AppError(400, 'INVALID_CREDENTIALS', 'Current password is incorrect');
  await query(`UPDATE users SET password_hash=$2 WHERE id=$1`, [req.auth!.userId, await hashPassword(b.newPassword)]);
  await query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`, [req.auth!.userId, req.auth!.sessionId]);
  await audit(undefined, { auth: req.auth, action: 'auth.password_changed', entity: 'user', entityId: req.auth!.userId, req });
  ok(res, null, 'Password updated. Other sessions were signed out.');
}));
