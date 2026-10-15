/**
 * Demo data: 1 platform owner, 3 generic businesses (each 1 admin, 2 managers, 5 delivery partners),
 * 20 customers and 50 orders created through the real order services so every status, event,
 * assignment, return and COD record is consistent. Safe to re-run: skips if the owner already exists.
 * "Store 2 Door" is only demo data - nothing in the application code refers to it.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, one, query, tx } from './db.js';
import { migrate } from './migrate.js';
import { createUserRecord } from './services/users.js';
import { BUSINESS_PERMISSIONS, loadPermissions } from './permissions.js';
import * as orders from './services/orders.js';
import { settleCod } from './services/cod.js';
import { storage } from './services/storage.js';
import type { Auth } from './auth.js';

export const DEMO_PASSWORD = 'Demo@1234';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const BUSINESSES = [
  { name: 'Store 2 Door', type: 'Grocery', slug: 'store2door', city: 'Gurugram', plan: 'Professional' },
  { name: 'Apex Pharmacy', type: 'Pharmacy', slug: 'apexpharmacy', city: 'Pune', plan: 'Basic' },
  { name: 'Crumb & Co Bakery', type: 'Bakery', slug: 'crumbco', city: 'Bengaluru', plan: 'Basic' },
];
const PARTNERS = ['Rahul', 'Amit', 'Sana', 'Vikram', 'Neha', 'Arjun', 'Priya', 'Kabir', 'Meera', 'Ravi', 'Isha', 'Dev', 'Anya', 'Karan', 'Zoya'];
const MANAGERS = ['Suresh', 'Anita', 'Farhan', 'Leela', 'Ganesh', 'Tara'];
const CUSTOMERS = ['A. Sharma', 'R. Gupta', 'S. Khan', 'M. Verma', 'P. Singh', 'N. Joshi', 'K. Mehta', 'D. Rao', 'L. Iyer', 'T. Bose'];
const AREAS = ['Sector 14', 'Phase 2', 'Main Road', 'Lake View', 'Market Street'];

async function ctxFor(userId: string): Promise<Auth> {
  const u = (await one<any>(`SELECT id,role,business_id,name FROM users WHERE id=$1`, [userId]))!;
  return { kind: 'user', userId: u.id, role: u.role, businessId: u.business_id, sessionId: null, perms: await loadPermissions(u.id), name: u.name };
}

export async function seedDemo(log = console.log) {
  await migrate(false);
  if (await one(`SELECT 1 FROM users WHERE role='owner'`)) { log('Demo data already present - skipping'); return; }

  const plans: Record<string, string> = {};
  for (const p of [
    ['Free', 0, 5, 3, 100, false, false, false], ['Basic', 999, 15, 8, 1000, false, true, false],
    ['Professional', 2999, 50, 25, 10000, true, true, true], ['Enterprise', 9999, null, null, null, true, true, true]] as const)
    plans[p[0]] = (await one<any>(`INSERT INTO plans(name,price,max_users,max_delivery_partners,max_orders_per_month,api_access,google_sheets,whatsapp) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, p as any))!.id;

  await tx(c => createUserRecord(c, { businessId: null, role: 'owner', name: 'Platform Owner', email: 'owner@dms.demo', password: DEMO_PASSWORD, createdBy: null }));

  const bizIds: string[] = [], adminIds: string[] = [], mgrIds: string[][] = [], partnerIds: string[][] = [];
  let pn = 0, mn = 0;
  for (const [bi, b] of BUSINESSES.entries()) {
    await tx(async c => {
      const biz = (await one<any>(`INSERT INTO businesses(name,business_type,city,phone,email) VALUES($1,$2,$3,$4,$5) RETURNING id`, [b.name, b.type, b.city, `98100000${bi}0`, `hello@${b.slug}.demo`], c))!;
      await query(`INSERT INTO business_settings(business_id,otp_required) VALUES($1,false)`, [biz.id], c);
      await query(`INSERT INTO subscriptions(business_id,plan_id,status,renewal_date) VALUES($1,$2,'active',current_date+30)`, [biz.id, plans[b.plan]], c);
      const a = await createUserRecord(c, { businessId: biz.id, role: 'business_admin', name: `Admin ${b.name.split(' ')[0]}`, email: `admin1@${b.slug}.demo`, mobile: `98200000${bi}1`, designation: 'Administrator', password: DEMO_PASSWORD, createdBy: null });
      const adminPerms = new Set(BUSINESS_PERMISSIONS);
      const ms: string[] = [], ps: string[] = [];
      for (let i = 0; i < 2; i++) ms.push((await createUserRecord(c, { businessId: biz.id, role: 'manager', name: MANAGERS[mn++], email: `manager${i + 1}@${b.slug}.demo`, mobile: `98300000${bi}${i}`, designation: 'Operations Executive', password: DEMO_PASSWORD, createdBy: a.id, creatorPerms: adminPerms })).id);
      for (let i = 0; i < 5; i++) ps.push((await createUserRecord(c, { businessId: biz.id, role: 'delivery_partner', name: PARTNERS[pn++], email: `partner${i + 1}@${b.slug}.demo`, mobile: `97400${bi}000${i}`, designation: 'Delivery Executive', password: DEMO_PASSWORD, createdBy: a.id, creatorPerms: adminPerms })).id);
      await query(`UPDATE users SET duty_on=true WHERE id = ANY($1)`, [ps], c);
      bizIds.push(biz.id); adminIds.push(a.id); mgrIds.push(ms); partnerIds.push(ps);
    });
  }

  // ---- 20 customers + 50 orders through the real services -------------------------------------
  let n = 0;
    for (const [bi, bid] of bizIds.entries()) {
    const mgr = await ctxFor(mgrIds[bi][0]);
    const mgr2 = await ctxFor(mgrIds[bi][1]);
    const proof = async (kind: string, orderId: string) => {
      const key = `${bid}/seed-${kind}-${orderId}.png`; await storage().put(key, PNG, 'image/png');
      return (await one<any>(`INSERT INTO files(business_id,storage_key,kind,mime_type,size_bytes,order_id) VALUES($1,$2,$3,'image/png',$4,$5) RETURNING id`, [bid, key, kind, PNG.length, orderId]))!.id as string;
    };
    // outcome script per order slot: [finalState, partnerSlot]
    // closed orders first (partners are free again after manager verification), then the open ones - one open order per partner
    const script: string[] = ['created', 'created', 'ready', 'ready', 'delivered', 'delivered', 'delivered', 'delivered', 'partial', 'partial', 'failed', 'full_return', 'cancelled',
      'assigned', 'accepted', 'out_for_delivery', 'delivered_pending', 'partial_pending'];
    if (bi === 0) script.splice(1, 1); else if (bi === 1) script.splice(script.indexOf('cancelled'), 1); else { script.splice(script.indexOf('cancelled'), 1); script.splice(1, 1); }
    let openSlot = 0;
    for (const [si, st] of script.entries()) {
      const cust = CUSTOMERS[(n + bi) % 10], bill = 300 + ((n * 137) % 2100), change = [0, 0, 20, 50][n % 4];
      const mode = ['cod', 'cod', 'upi', 'card'][n % 4];
      const { order } = await tx(c => orders.createOrder(c, mgr, {
        invoiceNumber: `INV-${bi + 1}${String(1000 + si)}`, customerName: `${cust} ${bi + 1}`, customerMobile: `98${bi}${String(1000000 + (n % 10) * 7919).slice(0, 7)}`.slice(0, 10),
        customerAddress: `${10 + n} ${AREAS[n % 5]}`, area: AREAS[n % 5], billAmount: bill, changeAmount: change, paymentMode: mode, priority: n % 7 === 0 ? 'high' : 'normal',
        items: [{ sku: 'SKU-1', name: 'Item A', quantity: 2, unitPrice: Math.floor(bill / 4) }, { sku: 'SKU-2', name: 'Item B', quantity: 1, unitPrice: bill - 2 * Math.floor(bill / 4) }],
      }));
      n++;
      if (st === 'created') continue;
      await tx(c => orders.setReady(c, mgr, order.id));
      if (st === 'ready') continue;
      if (st === 'cancelled') { await tx(c => orders.cancelOrder(c, mgr, order.id, 'Customer cancelled')); continue; }
      const closed = !['assigned', 'accepted', 'out_for_delivery', 'delivered_pending', 'partial_pending'].includes(st);
      const slot = closed ? (si % 5) : openSlot++ % 5;     // open orders each get their own partner
      const pid = partnerIds[bi][slot];
      const partner = await ctxFor(pid);
      await tx(c => orders.assignOrder(c, mgr, order.id, pid, 'Seed assignment'));
      if (st === 'assigned') continue;
      await tx(c => orders.partnerAction(c, partner, order.id, 'accept'));
      if (st === 'accepted') continue;
      await tx(c => orders.partnerAction(c, partner, order.id, 'pickup'));
      await tx(c => orders.partnerAction(c, partner, order.id, 'start', { latitude: 28.45, longitude: 77.02 }));
      if (st === 'out_for_delivery') continue;
      await tx(c => orders.partnerAction(c, partner, order.id, 'arrive'));
      const recv = order.receivable_amount;
      if (st.startsWith('delivered')) await tx(async c => orders.partnerAction(c, partner, order.id, 'deliver', { customerPaid: recv + (n % 3 === 0 && order.payment_mode === 'cod' ? 20 : 0), paymentProofFileId: await proof('payment_proof', order.id), paymentMode: order.payment_mode }));
      else if (st.startsWith('partial')) await tx(async c => orders.partnerAction(c, partner, order.id, 'partial', { returnedAmount: Math.round(bill * 0.2), reason: 'Damaged', returnItems: [], customerPaid: recv - Math.round(bill * 0.2), paymentProofFileId: await proof('payment_proof', order.id), returnPhotoFileId: await proof('return_photo', order.id), paymentMode: order.payment_mode }));
      else if (st === 'failed') await tx(c => orders.partnerAction(c, partner, order.id, 'fail', { reason: 'Customer unavailable', notes: 'Phone switched off' }));
      else if (st === 'full_return') await tx(async c => orders.partnerAction(c, partner, order.id, 'full_return', { reason: 'Customer rejected', returnPhotoFileId: await proof('return_photo', order.id) }));
      if (st.endsWith('_pending')) continue;
      await tx(c => orders.verifyOrder(c, (si % 2 ? mgr : mgr2), order.id, { result: 'complete', remarks: 'Verified (seed)' }));
    }
    // settle part of the cash one partner is holding, to show COD settlements
    const cash = await one<any>(`SELECT partner_id, sum(collected_amount - settled_amount) AS due FROM cod_transactions WHERE business_id=$1 AND status='collected' GROUP BY partner_id ORDER BY 2 DESC LIMIT 1`, [bid]);
    if (cash && cash.due > 0) await tx(c => settleCod(c, bid, cash.partner_id, Math.floor(cash.due / 2) || 1, adminIds[bi], `SETTLE-${bi + 1}001`, 'Seed settlement'));
  }
  // spread order dates across the last 7 days so period filters have data
  await query(`UPDATE orders SET created_at = now() - ((row_number_mod) || ' hours')::interval FROM (SELECT id, ((abs(hashtext(id::text)) % 160)) AS row_number_mod FROM orders) s WHERE orders.id = s.id`);
  const stats = await one<any>(`SELECT (SELECT count(*) FROM businesses)::int b,(SELECT count(*) FROM users)::int u,(SELECT count(*) FROM customers)::int c,(SELECT count(*) FROM orders)::int o`);
  log(`Seeded: ${stats.b} businesses, ${stats.u} users, ${stats.c} customers, ${stats.o} orders. Password for every demo account: ${DEMO_PASSWORD}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  seedDemo().then(() => pool.end()).catch(e => { console.error(e); process.exit(1); });
