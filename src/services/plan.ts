import { one } from '../db.js';
import type { Db } from '../db.js';
import { AppError } from '../errors.js';

export async function entitlements(businessId: string, db?: Db) {
  const r = await one<any>(`SELECT s.status, s.renewal_date, s.limits, p.name AS plan, p.max_users, p.max_delivery_partners, p.max_orders_per_month, p.api_access, p.google_sheets, p.whatsapp
                              FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.business_id=$1`, [businessId], db);
  if (!r) return null;
  const lim = r.limits ?? {};
  const pick = (k: string, planVal: any) => (k in lim ? lim[k] : planVal);
  return { status: r.status as string, plan: r.plan as string, renewalDate: r.renewal_date,
    maxUsers: pick('max_users', r.max_users) as number | null, maxPartners: pick('max_delivery_partners', r.max_delivery_partners) as number | null, maxOrdersPerMonth: pick('max_orders_per_month', r.max_orders_per_month) as number | null,
    apiAccess: pick('api_access', r.api_access) as boolean, googleSheets: pick('google_sheets', r.google_sheets) as boolean, whatsapp: pick('whatsapp', r.whatsapp) as boolean };
}
const blocked = (s: string) => s === 'expired' || s === 'cancelled';
const limitErr = (m: string) => new AppError(402, 'PLAN_LIMIT', m);

export async function assertWritable(businessId: string, db?: Db) {
  const e = await entitlements(businessId, db);
  if (e && blocked(e.status)) throw new AppError(402, 'SUBSCRIPTION_INACTIVE', `Your subscription is ${e.status}. Renew to continue creating data.`);
  return e;
}
export async function assertCanAddUser(businessId: string, role: string, db?: Db) {
  const e = await assertWritable(businessId, db); if (!e) return;
  const total = (await one<any>(`SELECT count(*)::int n FROM users WHERE business_id=$1 AND deleted_at IS NULL`, [businessId], db))!.n;
  if (e.maxUsers != null && total >= e.maxUsers) throw limitErr(`User limit (${e.maxUsers}) reached for the ${e.plan} plan`);
  if (role === 'delivery_partner' && e.maxPartners != null) {
    const n = (await one<any>(`SELECT count(*)::int n FROM users WHERE business_id=$1 AND role='delivery_partner' AND deleted_at IS NULL`, [businessId], db))!.n;
    if (n >= e.maxPartners) throw limitErr(`Delivery partner limit (${e.maxPartners}) reached for the ${e.plan} plan`);
  }
}
export async function assertOrderQuota(businessId: string, db?: Db) {
  const e = await assertWritable(businessId, db); if (!e || e.maxOrdersPerMonth == null) return;
  const n = (await one<any>(`SELECT count(*)::int n FROM orders WHERE business_id=$1 AND created_at >= date_trunc('month', now())`, [businessId], db))!.n;
  if (n >= e.maxOrdersPerMonth) throw limitErr(`Monthly order limit (${e.maxOrdersPerMonth}) reached for the ${e.plan} plan`);
}
export async function assertFeature(businessId: string, f: 'apiAccess' | 'googleSheets' | 'whatsapp') {
  const e = await entitlements(businessId);
  if (!e || !e[f]) throw limitErr(`This feature is not included in your plan`);
}
