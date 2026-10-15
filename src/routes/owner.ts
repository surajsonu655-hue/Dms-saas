import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, requirePerm } from '../auth.js';
import { one, query, tx } from '../db.js';
import { conflict, notFound, wrap, badRequest } from '../errors.js';
import { created, ok } from '../http.js';
import { email, isoDate, mobile, password, uuid } from '../validate.js';
import { audit } from '../audit.js';
import { createUserRecord, publicUser } from '../services/users.js';
import { BUSINESS_PERMISSIONS, PERMISSION_CATALOG, assertCanGrant, loadPermissions, setUserPermissions } from '../permissions.js';
import { meta, paging } from './util.js';
import { toCsv, toHtmlTable } from '../services/reports.js';

export const ownerRouter = Router();
ownerRouter.use(authenticate, requireRole('owner'));

const REV = `COALESCE(SUM(o.delivered_amount) FILTER (WHERE o.status IN ('delivered','partial')),0)`;
const settingsDefault = `INSERT INTO business_settings(business_id) VALUES($1) ON CONFLICT DO NOTHING`;

ownerRouter.get('/permissions', requirePerm('platform.users.manage'), wrap(async (_q, res) => ok(res, PERMISSION_CATALOG.map(([key, category, description, scope]) => ({ key, category, description, scope: scope ?? 'business' })))));

ownerRouter.get('/dashboard', requirePerm('platform.reports.view'), wrap(async (_req, res) => {
  const b = (await one<any>(`SELECT count(*)::int total, count(*) FILTER (WHERE status='active')::int active, count(*) FILTER (WHERE status='inactive')::int inactive, count(*) FILTER (WHERE status='suspended')::int suspended FROM businesses WHERE deleted_at IS NULL`))!;
  const rev = (await one<any>(`SELECT ${REV} AS revenue FROM orders o WHERE o.deleted_at IS NULL`))!;
  const staff = (await one<any>(`SELECT count(*)::int total, count(*) FILTER (WHERE role='business_admin')::int admins, count(*) FILTER (WHERE role='manager')::int managers, count(*) FILTER (WHERE role='delivery_partner')::int partners FROM users WHERE business_id IS NOT NULL AND deleted_at IS NULL AND status='active'`))!;
  const subs = await query(`SELECT s.status, count(*)::int AS count FROM subscriptions s JOIN businesses b ON b.id=s.business_id WHERE b.deleted_at IS NULL GROUP BY s.status`);
  const mrr = (await one<any>(`SELECT COALESCE(SUM(p.price),0) AS mrr FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN businesses b ON b.id=s.business_id WHERE s.status='active' AND b.deleted_at IS NULL`))!;
  ok(res, { businesses: b, revenue: rev.revenue, subscriptionMrr: mrr.mrr, staff, subscriptions: subs });
}));

// ---- businesses ------------------------------------------------------------
ownerRouter.get('/businesses', requirePerm('platform.businesses.manage'), wrap(async (req, res) => {
  const p = paging(req), q = z.object({ status: z.enum(['active', 'inactive', 'suspended']).optional(), search: z.string().max(100).optional() }).parse(req.query);
  const where = `b.deleted_at IS NULL AND ($1::text IS NULL OR b.status=$1) AND ($2::text IS NULL OR b.name ILIKE '%'||$2||'%')`;
  const total = (await one<any>(`SELECT count(*)::int n FROM businesses b WHERE ${where}`, [q.status ?? null, q.search ?? null]))!.n;
  const rows = await query(`SELECT b.id,b.name,b.business_type,b.status,b.logo_key,b.created_at,
        (SELECT COALESCE(SUM(delivered_amount),0) FROM orders o WHERE o.business_id=b.id AND o.status IN ('delivered','partial') AND o.deleted_at IS NULL) AS revenue,
        (SELECT count(*)::int FROM orders o WHERE o.business_id=b.id AND o.deleted_at IS NULL) AS total_orders,
        (SELECT count(*)::int FROM users u WHERE u.business_id=b.id AND u.deleted_at IS NULL) AS staff,
        (SELECT name FROM users u WHERE u.business_id=b.id AND u.role='business_admin' AND u.deleted_at IS NULL ORDER BY created_at LIMIT 1) AS admin_name,
        s.status AS subscription_status, pl.name AS plan
      FROM businesses b LEFT JOIN subscriptions s ON s.business_id=b.id LEFT JOIN plans pl ON pl.id=s.plan_id
      WHERE ${where} ORDER BY b.created_at DESC LIMIT $3 OFFSET $4`, [q.status ?? null, q.search ?? null, p.limit, p.offset]);
  ok(res, rows, 'OK', 200, meta(p, total));
}));

const businessBody = z.object({
  name: z.string().trim().min(2).max(120), businessType: z.string().trim().min(2).max(60),
  phone: mobile.optional(), email: email.optional(), whatsappNumber: mobile.optional(), address: z.string().max(300).optional(), city: z.string().max(80).optional(), state: z.string().max(80).optional(), pincode: z.string().max(12).optional(),
  timezone: z.string().max(60).default('Asia/Kolkata'),
});
ownerRouter.post('/businesses', requirePerm('platform.businesses.manage'), wrap(async (req, res) => {
  const b = businessBody.extend({
    planId: uuid, status: z.enum(['active', 'inactive']).default('active'),
    subscriptionStatus: z.enum(['trial', 'active']).default('trial'), renewalDate: isoDate.optional(),
    admin: z.object({ name: z.string().trim().min(2).max(100), email, mobile: mobile.optional(), password }),
    adminPermissions: z.array(z.string()).optional(),
  }).parse(req.body);
  const out = await tx(async c => {
    const plan = await one(`SELECT id FROM plans WHERE id=$1 AND active`, [b.planId], c); if (!plan) throw badRequest('Plan not found or inactive');
    let biz: any;
    try {
      biz = await one<any>(`INSERT INTO businesses(name,business_type,status,phone,email,whatsapp_number,address,city,state,pincode,timezone) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [b.name, b.businessType, b.status, b.phone ?? null, b.email ?? null, b.whatsappNumber ?? null, b.address ?? null, b.city ?? null, b.state ?? null, b.pincode ?? null, b.timezone], c);
    } catch (e: any) { if (e.code === '23505') throw conflict('A business with this name already exists'); throw e; }
    await query(settingsDefault, [biz.id], c);
    await query(`INSERT INTO subscriptions(business_id,plan_id,status,renewal_date) VALUES($1,$2,$3,COALESCE($4::date, current_date + (CASE WHEN $3='trial' THEN 14 ELSE 30 END)))`, [biz.id, b.planId, b.subscriptionStatus, b.renewalDate ?? null], c);
    const admin = await createUserRecord(c, { businessId: biz.id, role: 'business_admin', ...b.admin, designation: 'Administrator', createdBy: req.auth!.userId });
    if (b.adminPermissions) {
      assertCanGrant({ role: 'owner', perms: new Set(BUSINESS_PERMISSIONS) }, 'business_admin', b.adminPermissions);
      await query(`DELETE FROM user_permissions WHERE user_id=$1`, [admin.id], c);
      for (const k of b.adminPermissions) await query(`INSERT INTO user_permissions(user_id,business_id,permission_key,granted_by) VALUES($1,$2,$3,$4)`, [admin.id, biz.id, k, req.auth!.userId], c);
    }
    await audit(c, { auth: req.auth, businessId: biz.id, action: 'business.created', entity: 'business', entityId: biz.id, newValue: { name: biz.name, planId: b.planId }, req });
    return { business: biz, admin: publicUser(admin) };
  });
  created(res, out, 'Business onboarded successfully');
}));

ownerRouter.get('/businesses/:id', requirePerm('platform.businesses.manage'), wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = await one<any>(`SELECT * FROM businesses WHERE id=$1 AND deleted_at IS NULL`, [id]); if (!b) throw notFound('Business not found');
  const stats = await one<any>(`SELECT ${REV} AS revenue, count(*)::int AS total_orders,
        count(*) FILTER (WHERE status='delivered')::int delivered, count(*) FILTER (WHERE status='partial')::int partial, count(*) FILTER (WHERE status='failed')::int failed,
        count(*) FILTER (WHERE status='full_return')::int returned, count(*) FILTER (WHERE status IN ('created','ready','assigned','accepted','picked_up','out_for_delivery','arrived'))::int pending,
        COALESCE(SUM(collected_amount),0) collected FROM orders o WHERE business_id=$1 AND deleted_at IS NULL`, [id]);
  const staff = await one<any>(`SELECT count(*)::int total, count(*) FILTER (WHERE role='business_admin')::int admins, count(*) FILTER (WHERE role='manager')::int managers, count(*) FILTER (WHERE role='delivery_partner')::int partners FROM users WHERE business_id=$1 AND deleted_at IS NULL`, [id]);
  const sub = await one<any>(`SELECT s.*, p.name AS plan_name, p.price FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.business_id=$1`, [id]);
  const admins = await query(`SELECT id,name,email,mobile,status FROM users WHERE business_id=$1 AND role='business_admin' AND deleted_at IS NULL`, [id]);
  ok(res, { business: b, stats, staff, subscription: sub, admins });
}));

ownerRouter.get('/businesses/:id/staff', requirePerm('platform.businesses.manage'), wrap(async (req, res) => {
  const id = uuid.parse(req.params.id), p = paging(req), role = z.enum(['business_admin', 'manager', 'delivery_partner']).optional().parse(req.query.role);
  const rows = await query(`SELECT u.id,u.name,u.email,u.mobile,u.designation,u.role,u.status,u.created_at,
        count(o.id)::int AS orders, count(*) FILTER (WHERE o.status='delivered')::int delivered, count(*) FILTER (WHERE o.status='partial')::int partial,
        count(*) FILTER (WHERE o.status='full_return')::int returned, count(*) FILTER (WHERE o.status='failed')::int failed, COALESCE(SUM(o.collected_amount),0) AS collection
      FROM users u LEFT JOIN orders o ON o.business_id=u.business_id AND o.deleted_at IS NULL AND (o.current_partner_id=u.id OR o.assigned_manager_id=u.id)
      WHERE u.business_id=$1 AND u.deleted_at IS NULL AND ($2::text IS NULL OR u.role=$2) GROUP BY u.id ORDER BY u.role, u.name LIMIT $3 OFFSET $4`, [id, role ?? null, p.limit, p.offset]);
  ok(res, rows);
}));

ownerRouter.patch('/businesses/:id', requirePerm('platform.businesses.manage'), wrap(async (req, res) => {
  const id = uuid.parse(req.params.id), b = businessBody.partial().parse(req.body);
  const old = await one<any>(`SELECT * FROM businesses WHERE id=$1 AND deleted_at IS NULL`, [id]); if (!old) throw notFound('Business not found');
  const map: Record<string, string> = { name: 'name', businessType: 'business_type', phone: 'phone', email: 'email', whatsappNumber: 'whatsapp_number', address: 'address', city: 'city', state: 'state', pincode: 'pincode', timezone: 'timezone' };
  const keys = Object.keys(b).filter(k => (b as any)[k] !== undefined);
  if (!keys.length) return ok(res, old);
  const n = await one<any>(`UPDATE businesses SET ${keys.map((k, i) => `${map[k]}=$${i + 2}`).join(',')} WHERE id=$1 RETURNING *`, [id, ...keys.map(k => (b as any)[k])]);
  await audit(undefined, { auth: req.auth, businessId: id, action: 'business.updated', entity: 'business', entityId: id, oldValue: old, newValue: n, req });
  ok(res, n, 'Business updated');
}));

const setStatus = (status: 'active' | 'suspended' | 'inactive', action: string) => wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const old = await one<any>(`SELECT status FROM businesses WHERE id=$1 AND deleted_at IS NULL`, [id]); if (!old) throw notFound('Business not found');
  const n = await tx(async c => {
    const r = await one<any>(`UPDATE businesses SET status=$2 WHERE id=$1 RETURNING *`, [id, status], c);
    if (status !== 'active') await query(`UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE business_id=$1)`, [id], c);
    await audit(c, { auth: req.auth, businessId: id, action, entity: 'business', entityId: id, oldValue: { status: old.status }, newValue: { status }, req });
    return r;
  });
  ok(res, n, `Business ${status}`);
});
ownerRouter.post('/businesses/:id/suspend', requirePerm('platform.businesses.manage'), setStatus('suspended', 'business.suspended'));
ownerRouter.post('/businesses/:id/activate', requirePerm('platform.businesses.manage'), setStatus('active', 'business.activated'));
ownerRouter.post('/businesses/:id/deactivate', requirePerm('platform.businesses.manage'), setStatus('inactive', 'business.deactivated'));
ownerRouter.delete('/businesses/:id', requirePerm('platform.businesses.manage'), wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  if (req.query.confirm !== 'true') throw badRequest('Deleting a business requires ?confirm=true');
  await tx(async c => {
    const b = await one<any>(`UPDATE businesses SET deleted_at=now(), status='suspended' WHERE id=$1 AND deleted_at IS NULL RETURNING name`, [id], c); if (!b) throw notFound('Business not found');
    await query(`UPDATE users SET deleted_at=now(), status='inactive' WHERE business_id=$1 AND deleted_at IS NULL`, [id], c);
    await query(`UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE business_id=$1)`, [id], c);
    await audit(c, { auth: req.auth, businessId: id, action: 'business.deleted', entity: 'business', entityId: id, oldValue: { name: b.name }, req });  // financial records are retained (soft delete)
  });
  ok(res, null, 'Business deleted. Historical and financial records are retained.');
}));

ownerRouter.put('/businesses/:id/subscription', requirePerm('platform.plans.manage'), wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ planId: uuid.optional(), status: z.enum(['trial', 'active', 'past_due', 'expired', 'cancelled']).optional(), renewalDate: isoDate.optional(), limits: z.record(z.string(), z.any()).optional() }).parse(req.body);
  const n = await one<any>(`UPDATE subscriptions SET plan_id=COALESCE($2,plan_id), status=COALESCE($3,status), renewal_date=COALESCE($4::date,renewal_date), limits=COALESCE($5::jsonb,limits) WHERE business_id=$1 RETURNING *`,
    [id, b.planId ?? null, b.status ?? null, b.renewalDate ?? null, b.limits ? JSON.stringify(b.limits) : null]);
  if (!n) throw notFound('Subscription not found');
  await audit(undefined, { auth: req.auth, businessId: id, action: 'subscription.updated', entity: 'subscription', entityId: n.id, newValue: b, req });
  ok(res, n, 'Subscription updated');
}));

// ---- Business Admin rights ----------------------------------------------
ownerRouter.get('/users/:userId/permissions', requirePerm('platform.users.manage'), wrap(async (req, res) => {
  const u = await one<any>(`SELECT id,role,business_id FROM users WHERE id=$1 AND deleted_at IS NULL`, [uuid.parse(req.params.userId)]); if (!u) throw notFound('User not found');
  ok(res, { userId: u.id, role: u.role, permissions: [...await loadPermissions(u.id)].sort() });
}));
ownerRouter.put('/users/:userId/permissions', requirePerm('platform.users.manage'), wrap(async (req, res) => {
  const id = uuid.parse(req.params.userId), b = z.object({ permissions: z.array(z.string().max(60)).max(100) }).parse(req.body);
  const u = await one<any>(`SELECT id,role,business_id FROM users WHERE id=$1 AND deleted_at IS NULL`, [id]); if (!u || !u.business_id) throw notFound('User not found');
  assertCanGrant({ role: 'owner', perms: new Set(BUSINESS_PERMISSIONS) }, u.role, b.permissions);
  const before = [...await loadPermissions(id)];
  await setUserPermissions(id, u.business_id, u.role, [...new Set(b.permissions)], req.auth!.userId!);
  await audit(undefined, { auth: req.auth, businessId: u.business_id, action: 'permissions.changed', entity: 'user', entityId: id, oldValue: before.sort(), newValue: [...new Set(b.permissions)].sort(), req });
  ok(res, { userId: id, permissions: [...new Set(b.permissions)].sort() }, 'Permissions updated. Access changes take effect immediately.');
}));

// ---- plans ---------------------------------------------------------------------
const planBody = z.object({ name: z.string().trim().min(2).max(60), price: z.coerce.number().min(0), billingCycle: z.enum(['monthly', 'quarterly', 'yearly']).default('monthly'),
  maxUsers: z.number().int().min(1).nullable().optional(), maxDeliveryPartners: z.number().int().min(0).nullable().optional(), maxOrdersPerMonth: z.number().int().min(0).nullable().optional(),
  apiAccess: z.boolean().default(false), googleSheets: z.boolean().default(false), whatsapp: z.boolean().default(false), features: z.record(z.string(), z.any()).default({}), active: z.boolean().default(true) });
ownerRouter.get('/plans', requirePerm('platform.plans.manage'), wrap(async (_q, res) => ok(res, await query(`SELECT p.*, (SELECT count(*)::int FROM subscriptions s WHERE s.plan_id=p.id) AS subscribers FROM plans p ORDER BY price`))));
ownerRouter.post('/plans', requirePerm('platform.plans.manage'), wrap(async (req, res) => {
  const b = planBody.parse(req.body);
  const p = await one(`INSERT INTO plans(name,price,billing_cycle,max_users,max_delivery_partners,max_orders_per_month,api_access,google_sheets,whatsapp,features,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [b.name, b.price, b.billingCycle, b.maxUsers ?? null, b.maxDeliveryPartners ?? null, b.maxOrdersPerMonth ?? null, b.apiAccess, b.googleSheets, b.whatsapp, JSON.stringify(b.features), b.active]);
  await audit(undefined, { auth: req.auth, action: 'plan.created', entity: 'plan', entityId: (p as any).id, newValue: b, req });
  created(res, p, 'Plan created');
}));
ownerRouter.patch('/plans/:id', requirePerm('platform.plans.manage'), wrap(async (req, res) => {
  const id = uuid.parse(req.params.id), b = planBody.partial().parse(req.body);
  const map: Record<string, string> = { name: 'name', price: 'price', billingCycle: 'billing_cycle', maxUsers: 'max_users', maxDeliveryPartners: 'max_delivery_partners', maxOrdersPerMonth: 'max_orders_per_month', apiAccess: 'api_access', googleSheets: 'google_sheets', whatsapp: 'whatsapp', features: 'features', active: 'active' };
  const keys = Object.keys(b).filter(k => (b as any)[k] !== undefined); if (!keys.length) throw badRequest('Nothing to update');
  const p = await one(`UPDATE plans SET ${keys.map((k, i) => `${map[k]}=$${i + 2}`).join(',')} WHERE id=$1 RETURNING *`, [id, ...keys.map(k => k === 'features' ? JSON.stringify((b as any)[k]) : (b as any)[k])]);
  if (!p) throw notFound('Plan not found');
  await audit(undefined, { auth: req.auth, action: 'plan.updated', entity: 'plan', entityId: id, newValue: b, req });
  ok(res, p, 'Plan updated');
}));

// ---- platform users, reports, audit ----------------------------------------------
ownerRouter.post('/users', requirePerm('platform.users.manage'), wrap(async (req, res) => {
  const b = z.object({ role: z.enum(['owner', 'business_admin']), businessId: uuid.optional(), name: z.string().trim().min(2).max(100), email, mobile: mobile.optional(), password }).parse(req.body);
  if (b.role === 'business_admin' && !b.businessId) throw badRequest('businessId is required for a Business Admin');
  const u = await tx(async c => {
    if (b.businessId && !(await one(`SELECT 1 FROM businesses WHERE id=$1 AND deleted_at IS NULL`, [b.businessId], c))) throw notFound('Business not found');
    const r = await createUserRecord(c, { businessId: b.role === 'owner' ? null : b.businessId!, role: b.role, name: b.name, email: b.email, mobile: b.mobile, password: b.password, createdBy: req.auth!.userId });
    await audit(c, { auth: req.auth, businessId: r.business_id, action: 'user.created', entity: 'user', entityId: r.id, newValue: { role: b.role, email: b.email }, req });
    return r;
  });
  created(res, publicUser(u), 'User created');
}));

ownerRouter.get('/reports/businesses', requirePerm('platform.reports.view'), wrap(async (req, res) => {
  const q = z.object({ from: isoDate.optional(), to: isoDate.optional(), format: z.enum(['json', 'csv', 'excel', 'html']).default('json'), search: z.string().max(100).optional(), businessId: uuid.optional() }).parse(req.query);
  const cols = ['Business', 'Type', 'Status', 'Orders', 'Gross Sales', 'Returns', 'Net Sales', 'Collected', 'Staff'];
  const rows = (await (await import('../db.js')).pool.query({ text: `SELECT b.name,b.business_type,b.status,count(o.id)::int,
        COALESCE(SUM(o.bill_amount) FILTER (WHERE o.status IN ('delivered','partial','full_return')),0), COALESCE(SUM(o.returned_amount) FILTER (WHERE o.status IN ('delivered','partial','full_return')),0),
        COALESCE(SUM(o.delivered_amount) FILTER (WHERE o.status IN ('delivered','partial')),0), COALESCE(SUM(o.collected_amount),0),
        (SELECT count(*)::int FROM users u WHERE u.business_id=b.id AND u.deleted_at IS NULL)
      FROM businesses b LEFT JOIN orders o ON o.business_id=b.id AND o.deleted_at IS NULL AND ($1::date IS NULL OR o.created_at >= $1::date) AND ($2::date IS NULL OR o.created_at < $2::date + 1)
      WHERE b.deleted_at IS NULL AND ($3::text IS NULL OR b.name ILIKE '%'||$3||'%') AND ($4::uuid IS NULL OR b.id=$4) GROUP BY b.id ORDER BY b.name`,
    values: [q.from ?? null, q.to ?? null, q.search ?? null, q.businessId ?? null], rowMode: 'array' })).rows as any[][];
  await audit(undefined, { auth: req.auth, action: 'report.platform_businesses', newValue: { format: q.format }, req });
  if (q.format === 'csv') { res.setHeader('content-type', 'text/csv; charset=utf-8'); res.setHeader('content-disposition', 'attachment; filename="businesses.csv"'); return void res.send(toCsv(cols, rows)); }
  if (q.format === 'excel' || q.format === 'html') { res.setHeader('content-type', q.format === 'excel' ? 'application/vnd.ms-excel' : 'text/html; charset=utf-8'); if (q.format === 'excel') res.setHeader('content-disposition', 'attachment; filename="businesses.xls"'); return void res.send(toHtmlTable('Business report', cols, rows)); }
  ok(res, { columns: cols, rows });
}));

ownerRouter.get('/audit-logs', requirePerm('platform.reports.view'), wrap(async (req, res) => {
  const p = paging(req), bid = req.query.businessId ? uuid.parse(req.query.businessId) : null;
  const total = (await one<any>(`SELECT count(*)::int n FROM audit_logs WHERE ($1::uuid IS NULL OR business_id=$1)`, [bid]))!.n;
  ok(res, await query(`SELECT a.*, u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE ($1::uuid IS NULL OR a.business_id=$1) ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`, [bid, p.limit, p.offset]), 'OK', 200, meta(p, total));
}));
