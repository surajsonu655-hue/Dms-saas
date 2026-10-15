import { Router } from 'express';
import { z } from 'zod';
import { authenticate, biz, hashPassword, notPartner, requirePerm, requireRole, requireTenant } from '../auth.js';
import { one, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, wrap } from '../errors.js';
import { created, ok } from '../http.js';
import { email, likePattern, mobile, modeKey, password, uuid } from '../validate.js';
import { audit } from '../audit.js';
import { createUserRecord, publicUser } from '../services/users.js';
import { assertCanGrant, loadPermissions, setUserPermissions, ROLE_RANK, type Role } from '../permissions.js';
import { assertCanAddUser, assertWritable, entitlements } from '../services/plan.js';
import { activeAssignedCount } from '../services/orders.js';
import { meta, paging, sortBy } from './util.js';

export const businessRouter = Router();
businessRouter.use(authenticate, requireTenant);

// ---- own business -------------------------------------------------------------
businessRouter.get('/business', wrap(async (req, res) => {
  const b = await one<any>(`SELECT id,name,business_type,status,phone,email,whatsapp_number,address,city,state,pincode,logo_key,timezone FROM businesses WHERE id=$1`, [biz(req)]);
  ok(res, { ...b, subscription: await entitlements(biz(req)) });
}));
businessRouter.patch('/business', requirePerm('settings.manage'), notPartner, wrap(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(120), phone: mobile, email, whatsappNumber: mobile, address: z.string().max(300), city: z.string().max(80), state: z.string().max(80), pincode: z.string().max(12), logoFileId: uuid }).partial().parse(req.body);
  const map: Record<string, string> = { name: 'name', phone: 'phone', email: 'email', whatsappNumber: 'whatsapp_number', address: 'address', city: 'city', state: 'state', pincode: 'pincode' };
  const old = await one<any>(`SELECT * FROM businesses WHERE id=$1`, [biz(req)]);
  const sets: string[] = [], vals: any[] = [];
  for (const k of Object.keys(map)) if ((b as any)[k] !== undefined) { vals.push((b as any)[k]); sets.push(`${map[k]}=$${vals.length + 1}`); }
  if (b.logoFileId) {
    const f = await one<any>(`SELECT storage_key FROM files WHERE id=$1 AND business_id=$2 AND kind='logo'`, [b.logoFileId, biz(req)]); if (!f) throw badRequest('Logo file not found');
    vals.push(f.storage_key); sets.push(`logo_key=$${vals.length + 1}`);
  }
  if (!sets.length) return ok(res, old);
  const n = await one(`UPDATE businesses SET ${sets.join(',')} WHERE id=$1 RETURNING id,name,phone,email,whatsapp_number,address,city,state,pincode,logo_key`, [biz(req), ...vals]);
  await audit(undefined, { auth: req.auth, action: 'business.settings_changed', entity: 'business', entityId: biz(req), oldValue: old, newValue: n, req });
  ok(res, n, 'Business updated');
}));

const settingsSchema = z.object({
  codEnabled: z.boolean(), returnsEnabled: z.boolean(), partialDeliveryEnabled: z.boolean(), otpRequired: z.boolean(), photoRequired: z.boolean(), signatureRequired: z.boolean(),
  paymentProofRequired: z.boolean(), returnPhotoRequired: z.boolean(), gpsRequired: z.boolean(), paymentModes: z.array(modeKey).min(1).max(20), orderPrefix: z.string().trim().regex(/^[A-Za-z0-9]{1,8}$/),
  managerReportScope: z.enum(['same_day', 'weekly', 'monthly', 'yearly', 'complete']),
  notificationPrefs: z.object({ in_app: z.boolean(), email: z.boolean(), whatsapp: z.boolean() }).partial(), deliverySettings: z.record(z.string(), z.any()),
}).partial();
const settingsMap: Record<string, string> = { codEnabled: 'cod_enabled', returnsEnabled: 'returns_enabled', partialDeliveryEnabled: 'partial_delivery_enabled', otpRequired: 'otp_required', photoRequired: 'photo_required', signatureRequired: 'signature_required', paymentProofRequired: 'payment_proof_required', returnPhotoRequired: 'return_photo_required', gpsRequired: 'gps_required', paymentModes: 'payment_modes', orderPrefix: 'order_prefix', managerReportScope: 'manager_report_scope', notificationPrefs: 'notification_prefs', deliverySettings: 'delivery_settings' };
const camel = (r: any) => Object.fromEntries(Object.entries(settingsMap).map(([c, s]) => [c, r[s]]));
businessRouter.get('/business/settings', requirePerm('settings.view'), notPartner, wrap(async (req, res) => ok(res, camel((await one<any>(`SELECT * FROM business_settings WHERE business_id=$1`, [biz(req)]))!))));
businessRouter.put('/business/settings', requirePerm('settings.manage'), notPartner, wrap(async (req, res) => {
  const b = settingsSchema.parse(req.body), keys = Object.keys(b).filter(k => (b as any)[k] !== undefined);
  if (!keys.length) throw badRequest('Nothing to update');
  const old = await one<any>(`SELECT * FROM business_settings WHERE business_id=$1`, [biz(req)]);
  const merged: Record<string, any> = { ...b };
  if (b.notificationPrefs) merged.notificationPrefs = { ...old.notification_prefs, ...b.notificationPrefs };
  const n = await one<any>(`UPDATE business_settings SET ${keys.map((k, i) => `${settingsMap[k]}=$${i + 2}${['notificationPrefs', 'deliverySettings'].includes(k) ? '::jsonb' : ''}`).join(',')} WHERE business_id=$1 RETURNING *`,
    [biz(req), ...keys.map(k => ['notificationPrefs', 'deliverySettings'].includes(k) ? JSON.stringify(merged[k]) : merged[k])]);
  await audit(undefined, { auth: req.auth, action: 'business.settings_changed', entity: 'business_settings', entityId: biz(req), oldValue: old, newValue: n, req });
  ok(res, camel(n), 'Settings saved');
}));
businessRouter.get('/business/subscription', requirePerm('settings.view'), notPartner, wrap(async (req, res) => ok(res, await entitlements(biz(req)))));

// ---- users --------------------------------------------------------------------------
const MANAGEABLE: Record<string, Role[]> = { business_admin: ['manager', 'delivery_partner'], manager: ['delivery_partner'] };

businessRouter.get('/users', requirePerm('users.view'), notPartner, wrap(async (req, res) => {
  const p = paging(req), q = z.object({ role: z.enum(['business_admin', 'manager', 'delivery_partner']).optional(), status: z.enum(['active', 'inactive']).optional(), search: z.string().max(80).optional() }).parse(req.query);
  const where = `u.business_id=$1 AND u.deleted_at IS NULL AND ($2::text IS NULL OR u.role=$2) AND ($3::text IS NULL OR u.status=$3) AND ($4::text IS NULL OR u.name ILIKE $4 OR u.email::text ILIKE $4)`;
  const args = [biz(req), q.role ?? null, q.status ?? null, q.search ? likePattern(q.search) : null];
  const total = (await one<any>(`SELECT count(*)::int n FROM users u WHERE ${where}`, args))!.n;
  const rows = await query(`SELECT u.id,u.name,u.email,u.mobile,u.designation,u.role,u.status,u.duty_on,u.created_at,
       count(o.id)::int AS orders, count(*) FILTER (WHERE o.status='delivered')::int delivered, count(*) FILTER (WHERE o.status='partial')::int partial, count(*) FILTER (WHERE o.status='full_return')::int returned,
       COALESCE(SUM(o.collected_amount),0) AS collection
      FROM users u LEFT JOIN orders o ON o.business_id=u.business_id AND o.deleted_at IS NULL AND (o.current_partner_id=u.id OR o.assigned_manager_id=u.id)
      WHERE ${where} GROUP BY u.id ORDER BY ${sortBy(req, { name: 'u.name', created_at: 'u.created_at', role: 'u.role' }, 'u.name')} LIMIT $5 OFFSET $6`, [...args, p.limit, p.offset]);
  ok(res, rows, 'OK', 200, meta(p, total));
}));

businessRouter.post('/users', requirePerm('users.create'), notPartner, wrap(async (req, res) => {
  const b = z.object({ role: z.enum(['manager', 'delivery_partner']), name: z.string().trim().min(2).max(100), email, mobile: mobile.optional(), designation: z.string().trim().max(60).optional(), password, status: z.enum(['active', 'inactive']).default('active') }).parse(req.body);
  if (!(MANAGEABLE[req.auth!.role] ?? []).includes(b.role)) throw forbidden(`You cannot create a ${b.role.replace('_', ' ')}`);
  const u = await tx(async c => {
    await assertCanAddUser(biz(req), b.role, c);
    const r = await createUserRecord(c, { businessId: biz(req), role: b.role, name: b.name, email: b.email, mobile: b.mobile, designation: b.designation, password: b.password, status: b.status, createdBy: req.auth!.userId, creatorPerms: req.auth!.perms });
    await audit(c, { auth: req.auth, action: 'user.created', entity: 'user', entityId: r.id, newValue: { role: b.role, email: b.email }, req });
    return r;
  });
  created(res, publicUser(u), 'User created');
}));

async function targetUser(req: any, id: string, c?: any) {
  const u = await one<any>(`SELECT * FROM users WHERE id=$1 AND business_id=$2 AND deleted_at IS NULL`, [id, biz(req)], c);
  if (!u) throw notFound('User not found');                                 // other tenants' users are indistinguishable from missing ones
  if (!(MANAGEABLE[req.auth.role] ?? []).includes(u.role)) throw forbidden('You cannot modify this user');
  return u;
}
businessRouter.get('/users/:id', requirePerm('users.view'), notPartner, wrap(async (req, res) => {
  const u = await one<any>(`SELECT * FROM users WHERE id=$1 AND business_id=$2 AND deleted_at IS NULL`, [uuid.parse(req.params.id), biz(req)]); if (!u) throw notFound('User not found');
  ok(res, publicUser(u));
}));
businessRouter.patch('/users/:id', requirePerm('users.edit'), notPartner, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id), b = z.object({ name: z.string().trim().min(2).max(100), mobile, designation: z.string().trim().max(60), status: z.enum(['active', 'inactive']) }).partial().parse(req.body);
  const old = await targetUser(req, id);
  const keys = Object.keys(b).filter(k => (b as any)[k] !== undefined); if (!keys.length) return ok(res, publicUser(old));
  const n = await tx(async c => {
    const r = await one<any>(`UPDATE users SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1 RETURNING *`, [id, ...keys.map(k => (b as any)[k])], c);
    if (b.status === 'inactive') { await query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [id], c); await query(`UPDATE users SET duty_on=false WHERE id=$1`, [id], c); }
    await audit(c, { auth: req.auth, action: 'user.updated', entity: 'user', entityId: id, oldValue: { name: old.name, status: old.status, designation: old.designation }, newValue: b, req });
    return r;
  });
  ok(res, publicUser(n), 'User updated');
}));
businessRouter.delete('/users/:id', requirePerm('users.delete'), notPartner, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const u = await targetUser(req, id);
  await tx(async c => {
    if (u.role === 'delivery_partner' && await activeAssignedCount(c as any, biz(req), id) > 0) throw conflict('This partner still has unresolved deliveries', 'PARTNER_BUSY');
    await query(`UPDATE users SET deleted_at=now(), status='inactive', duty_on=false WHERE id=$1`, [id], c);    // soft delete keeps history intact
    await query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [id], c);
    await audit(c, { auth: req.auth, action: 'user.deleted', entity: 'user', entityId: id, oldValue: { email: u.email, role: u.role }, req });
  });
  ok(res, null, 'User deleted');
}));
businessRouter.post('/users/:id/reset-password', requirePerm('users.edit'), notPartner, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id), b = z.object({ newPassword: password }).parse(req.body); await targetUser(req, id);
  await query(`UPDATE users SET password_hash=$2 WHERE id=$1`, [id, await hashPassword(b.newPassword)]);
  await query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [id]);
  await audit(undefined, { auth: req.auth, action: 'user.password_reset', entity: 'user', entityId: id, req });
  ok(res, null, 'Password reset. The user was signed out everywhere.');
}));

businessRouter.get('/users/:id/permissions', requirePerm('users.view'), notPartner, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id), u = await one<any>(`SELECT id,role FROM users WHERE id=$1 AND business_id=$2 AND deleted_at IS NULL`, [id, biz(req)]); if (!u) throw notFound('User not found');
  ok(res, { userId: id, role: u.role, permissions: [...await loadPermissions(id)].sort(), grantable: [...req.auth!.perms].sort() });
}));
businessRouter.put('/users/:id/permissions', requirePerm('permissions.manage'), requireRole('business_admin'), wrap(async (req, res) => {
  const id = uuid.parse(req.params.id), b = z.object({ permissions: z.array(z.string().max(60)).max(100) }).parse(req.body);
  const u = await targetUser(req, id);
  const keys = [...new Set(b.permissions)];
  assertCanGrant({ role: req.auth!.role as Role, perms: req.auth!.perms }, u.role, keys);    // a Manager can never exceed the Admin
  const before = [...await loadPermissions(id)].sort();
  await setUserPermissions(id, biz(req), u.role, keys, req.auth!.userId!);
  await audit(undefined, { auth: req.auth, action: 'permissions.changed', entity: 'user', entityId: id, oldValue: before, newValue: keys.sort(), req });
  ok(res, { userId: id, permissions: keys.sort() }, 'Permissions updated');
}));

businessRouter.post('/me/duty', requireRole('delivery_partner'), wrap(async (req, res) => {
  const { on } = z.object({ on: z.boolean() }).parse(req.body);
  await tx(async c => {
    if (!on && await activeAssignedCount(c as any, biz(req), req.auth!.userId!) > 0)
      throw conflict('You cannot go OFF DUTY until all assigned orders are completed by the Manager.', 'DUTY_OFF_BLOCKED');
    if (on) await assertWritable(biz(req), c);
    await query(`UPDATE users SET duty_on=$2 WHERE id=$1`, [req.auth!.userId, on], c);
  });
  ok(res, { dutyOn: on }, on ? 'You are ON DUTY' : 'You are OFF DUTY');
}));

// ---- customers ----------------------------------------------------------------------
const custBody = z.object({ name: z.string().trim().min(1).max(120), mobile, address: z.string().max(300).optional(), area: z.string().max(80).optional(), city: z.string().max(80).optional(), pincode: z.string().max(12).optional() });
businessRouter.get('/customers', requirePerm('customers.view'), notPartner, wrap(async (req, res) => {
  const p = paging(req), s = req.query.search ? likePattern(String(req.query.search).slice(0, 80)) : null;
  const where = `c.business_id=$1 AND c.deleted_at IS NULL AND ($2::text IS NULL OR c.name ILIKE $2 OR c.mobile ILIKE $2)`;
  const total = (await one<any>(`SELECT count(*)::int n FROM customers c WHERE ${where}`, [biz(req), s]))!.n;
  const rows = await query(`SELECT c.*, count(o.id)::int AS total_orders, count(*) FILTER (WHERE o.status='delivered')::int delivered, count(*) FILTER (WHERE o.status='full_return')::int returned, count(*) FILTER (WHERE o.status='partial')::int partial,
       COALESCE(SUM(o.delivered_amount) FILTER (WHERE o.status IN ('delivered','partial')),0) AS total_value, max(o.created_at) AS last_order
     FROM customers c LEFT JOIN orders o ON o.customer_id=c.id AND o.deleted_at IS NULL WHERE ${where} GROUP BY c.id ORDER BY ${sortBy(req, { name: 'c.name', created_at: 'c.created_at' }, 'c.created_at')} LIMIT $3 OFFSET $4`, [biz(req), s, p.limit, p.offset]);
  ok(res, rows, 'OK', 200, meta(p, total));
}));
businessRouter.post('/customers', requirePerm('customers.create'), notPartner, wrap(async (req, res) => {
  const b = custBody.parse(req.body); await assertWritable(biz(req));
  const c = await one(`INSERT INTO customers(business_id,name,mobile,address,area,city,pincode) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [biz(req), b.name, b.mobile, b.address ?? null, b.area ?? null, b.city ?? null, b.pincode ?? null]);
  created(res, c, 'Customer created');
}));
businessRouter.get('/customers/:id', requirePerm('customers.view'), notPartner, wrap(async (req, res) => {
  const c = await one<any>(`SELECT * FROM customers WHERE id=$1 AND business_id=$2 AND deleted_at IS NULL`, [uuid.parse(req.params.id), biz(req)]); if (!c) throw notFound('Customer not found');
  const orders = await query(`SELECT id,invoice_number,status,bill_amount,receivable_amount,returned_amount,final_amount,payment_mode,created_at FROM orders WHERE customer_id=$1 AND business_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50`, [c.id, biz(req)]);
  ok(res, { ...c, orders });
}));
businessRouter.patch('/customers/:id', requirePerm('customers.edit'), notPartner, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id), b = custBody.partial().parse(req.body), keys = Object.keys(b).filter(k => (b as any)[k] !== undefined);
  if (!keys.length) throw badRequest('Nothing to update');
  const n = await one(`UPDATE customers SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE id=$1 AND business_id=$2 AND deleted_at IS NULL RETURNING *`, [id, biz(req), ...keys.map(k => (b as any)[k])]);
  if (!n) throw notFound('Customer not found');
  ok(res, n, 'Customer updated');
}));

// ---- notifications ----------------------------------------------------------------------
businessRouter.get('/notifications', wrap(async (req, res) => {
  if (!req.auth!.userId) throw forbidden();
  const p = paging(req), unread = req.query.unread === 'true';
  const total = (await one<any>(`SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND business_id=$2 AND channel='in_app' AND ($3::boolean=false OR status='unread')`, [req.auth!.userId, biz(req), unread]))!.n;
  ok(res, await query(`SELECT id,type,title,body,data,status,created_at FROM notifications WHERE user_id=$1 AND business_id=$2 AND channel='in_app' AND ($3::boolean=false OR status='unread') ORDER BY created_at DESC LIMIT $4 OFFSET $5`, [req.auth!.userId, biz(req), unread, p.limit, p.offset]), 'OK', 200, meta(p, total));
}));
businessRouter.post('/notifications/read-all', wrap(async (req, res) => { await query(`UPDATE notifications SET status='read', read_at=now() WHERE user_id=$1 AND status='unread'`, [req.auth!.userId]); ok(res, null, 'All notifications marked read'); }));
businessRouter.post('/notifications/:id/read', wrap(async (req, res) => {
  const n = await one(`UPDATE notifications SET status='read', read_at=now() WHERE id=$1 AND user_id=$2 RETURNING id`, [uuid.parse(req.params.id), req.auth!.userId]); if (!n) throw notFound('Notification not found');
  ok(res, null, 'Marked read');
}));
