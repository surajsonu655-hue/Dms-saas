import type { PoolClient } from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { one, query } from '../db.js';
import type { Auth } from '../auth.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { assertTransition, type OrderStatus } from './lifecycle.js';
import { emit, STATUS_EVENT } from './events.js';
import { notify, notifyCustomer, notifyRole } from './notifications.js';
import { round2 } from '../validate.js';

type C = PoolClient;
export interface Geo { latitude?: number; longitude?: number }

export async function getSettings(c: C, businessId: string) {
  const s = await one<any>(`SELECT * FROM business_settings WHERE business_id=$1`, [businessId], c);
  if (!s) throw notFound('Business settings not found');
  return s;
}
export async function lockOrder(c: C, businessId: string, id: string) {
  const o = await one<any>(`SELECT * FROM orders WHERE id=$1 AND business_id=$2 AND deleted_at IS NULL FOR UPDATE`, [id, businessId], c);
  if (!o) throw notFound('Order not found');           // same answer whether it does not exist or belongs to another tenant
  return o;
}
async function patchOrder(c: C, id: string, f: Record<string, any>) {
  const keys = Object.keys(f);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(',');
  return (await one<any>(`UPDATE orders SET ${sets} WHERE id=$1 RETURNING *`, [id, ...keys.map(k => f[k])], c))!;
}
export async function logEvent(c: C, o: any, prev: string | null, next: string, auth: Auth, x: { deliveryId?: string | null; notes?: string | null; metadata?: any; geo?: Geo } = {}) {
  await query(`INSERT INTO delivery_events(business_id,order_id,delivery_id,previous_status,new_status,changed_by,user_role,latitude,longitude,notes,metadata)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [o.business_id, o.id, x.deliveryId ?? null, prev, next, auth.userId, auth.role, x.geo?.latitude ?? null, x.geo?.longitude ?? null, x.notes ?? null, JSON.stringify(x.metadata ?? {})], c);
}
const latestDelivery = (c: C, orderId: string) => one<any>(`SELECT * FROM deliveries WHERE order_id=$1 ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`, [orderId], c);

/** Orders a partner still has to close out: in-flight, or finished but not yet verified by a manager. */
export async function unresolvedFor(c: C, businessId: string, partnerId: string, excludeOrderId?: string) {
  const r = await one<{ n: number; inflight: number }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE status IN ('out_for_delivery','arrived'))::int AS inflight FROM orders
      WHERE business_id=$1 AND current_partner_id=$2 AND deleted_at IS NULL AND ($3::uuid IS NULL OR id<>$3)
        AND (status IN ('out_for_delivery','arrived') OR (status IN ('delivered','partial','failed','full_return') AND final_status IN ('pending','incomplete')))`,
    [businessId, partnerId, excludeOrderId ?? null], c);
  return r!;
}
export async function activeAssignedCount(c: C, businessId: string, partnerId: string) {
  const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE business_id=$1 AND current_partner_id=$2 AND deleted_at IS NULL
      AND (status IN ('assigned','accepted','picked_up','out_for_delivery','arrived') OR (status IN ('delivered','partial','failed','full_return') AND final_status IN ('pending','incomplete')))`, [businessId, partnerId], c);
  return r!.n;
}

// ---------------------------------------------------------------- create / edit
export interface NewOrder {
  invoiceNumber?: string; customerName: string; customerMobile: string; customerAddress: string; area?: string; city?: string; pincode?: string;
  billAmount: number; changeAmount: number; paymentMode: string; deliveryDate?: string; priority?: string; notes?: string;
  items?: { sku?: string; name: string; quantity: number; unitPrice: number }[]; partnerId?: string;
}
export async function createOrder(c: C, auth: Auth, input: NewOrder) {
  const biz = auth.businessId!, s = await getSettings(c, biz);
  if (!s.payment_modes.includes(input.paymentMode)) throw badRequest(`Payment mode "${input.paymentMode}" is not enabled for this business`);
  if (input.paymentMode === 'cod' && !s.cod_enabled) throw badRequest('Cash on delivery is disabled for this business');
  const receivable = input.paymentMode === 'prepaid' ? 0 : round2(input.billAmount + input.changeAmount);   // server-side: Receivable = Bill + Change
  const invoice = input.invoiceNumber?.trim() || `${s.order_prefix}-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${crypto.randomInt(10000, 99999)}`;
  const cust = (await one<any>(`INSERT INTO customers(business_id,name,mobile,address,area,city,pincode) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (business_id,mobile) DO UPDATE SET name=EXCLUDED.name, address=EXCLUDED.address, area=COALESCE(EXCLUDED.area,customers.area), deleted_at=NULL RETURNING id`,
    [biz, input.customerName, input.customerMobile, input.customerAddress, input.area ?? null, input.city ?? null, input.pincode ?? null], c))!;
  const otp = s.otp_required ? String(crypto.randomInt(100000, 999999)) : null;
  const mgr = auth.role === 'manager' || auth.role === 'business_admin' ? auth.userId : null;
  let o: any;
  try {
    o = (await one<any>(`INSERT INTO orders(business_id,invoice_number,customer_id,customer_name,customer_mobile,customer_address,area,bill_amount,change_amount,receivable_amount,payment_mode,priority,delivery_date,notes,assigned_manager_id,otp_hash,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [biz, invoice, cust.id, input.customerName, input.customerMobile, input.customerAddress, input.area ?? null, input.billAmount, input.changeAmount, receivable, input.paymentMode,
       input.priority ?? 'normal', input.deliveryDate ?? null, input.notes ?? null, mgr, otp ? await bcrypt.hash(otp, 4) : null, auth.userId], c))!;
  } catch (e: any) { if (e.code === '23505') throw conflict(`Invoice number "${invoice}" already exists`, 'DUPLICATE_INVOICE'); throw e; }
  for (const it of input.items ?? [])
    await query(`INSERT INTO order_items(business_id,order_id,sku,name,quantity,unit_price,total) VALUES($1,$2,$3,$4,$5,$6,$7)`, [biz, o.id, it.sku ?? null, it.name, it.quantity, it.unitPrice, round2(it.quantity * it.unitPrice)], c);
  await logEvent(c, o, null, 'created', auth, { metadata: { bill_amount: o.bill_amount, change_amount: o.change_amount, receivable_amount: o.receivable_amount } });
  await emit(c, biz, 'order.created', o);
  await notifyRole(c, biz, ['manager'], { type: 'order.created', title: 'New order', body: `Order ${o.invoice_number} created`, data: { orderId: o.id } });
  if (otp) await notifyCustomer(c, biz, o.customer_mobile, { type: 'delivery.otp', title: 'Delivery OTP', body: `Your delivery OTP is ${otp}`, data: { orderId: o.id } });
  if (input.partnerId) { o = await setReady(c, auth, o.id); o = await assignOrder(c, auth, o.id, input.partnerId, 'Assigned at creation'); }
  return { order: o, debugOtp: !s.otp_required || process.env.NODE_ENV === 'production' ? undefined : otp };
}

export async function updateOrder(c: C, auth: Auth, id: string, patch: Partial<NewOrder> & { remarks?: string }) {
  const o = await lockOrder(c, auth.businessId!, id);
  if (!['created', 'ready'].includes(o.status)) throw conflict('Only orders that are not yet assigned can be edited', 'ORDER_LOCKED');
  const f: Record<string, any> = {};
  if (patch.customerName) f.customer_name = patch.customerName;
  if (patch.customerMobile) f.customer_mobile = patch.customerMobile;
  if (patch.customerAddress) f.customer_address = patch.customerAddress;
  if (patch.area !== undefined) f.area = patch.area;
  if (patch.priority) f.priority = patch.priority;
  if (patch.deliveryDate !== undefined) f.delivery_date = patch.deliveryDate;
  if (patch.notes !== undefined) f.notes = patch.notes;
  if (patch.remarks !== undefined) f.remarks = patch.remarks;
  if (patch.paymentMode) { const s = await getSettings(c, o.business_id); if (!s.payment_modes.includes(patch.paymentMode)) throw badRequest('Payment mode not enabled'); f.payment_mode = patch.paymentMode; }
  const bill = patch.billAmount ?? o.bill_amount, chg = patch.changeAmount ?? o.change_amount, mode = f.payment_mode ?? o.payment_mode;
  if (patch.billAmount !== undefined || patch.changeAmount !== undefined || patch.paymentMode) { f.bill_amount = bill; f.change_amount = chg; f.receivable_amount = mode === 'prepaid' ? 0 : round2(bill + chg); }
  if (!Object.keys(f).length) return o;
  const n = await patchOrder(c, id, f);
  await logEvent(c, n, o.status, n.status, auth, { notes: 'Order edited', metadata: { edited: Object.keys(f) } });
  await emit(c, o.business_id, 'order.updated', n);
  return n;
}

export async function softDeleteOrder(c: C, auth: Auth, id: string) {
  const o = await lockOrder(c, auth.businessId!, id);
  if (!['created', 'ready', 'cancelled'].includes(o.status)) throw conflict('Orders with delivery history cannot be deleted. Cancel them instead.', 'ORDER_HAS_HISTORY');
  await query(`UPDATE orders SET deleted_at=now() WHERE id=$1`, [id], c);
  return o;
}

// ---------------------------------------------------------------- lifecycle (staff)
export async function setReady(c: C, auth: Auth, id: string) {
  const o = await lockOrder(c, auth.businessId!, id);
  assertTransition(o.status, 'ready');
  const n = await patchOrder(c, id, { status: 'ready' });
  await logEvent(c, n, o.status, 'ready', auth);
  await emit(c, o.business_id, 'order.updated', n);
  return n;
}

export async function assignOrder(c: C, auth: Auth, id: string, partnerId: string, reason?: string) {
  const biz = auth.businessId!;
  const o = await lockOrder(c, biz, id);
  const reassign = !!o.current_partner_id && ['assigned', 'accepted', 'picked_up'].includes(o.status);
  const need = reassign ? 'deliveries.reassign' : 'deliveries.assign';
  if (!auth.perms.has(need)) throw forbidden(`Missing permission: ${need}`, 'PERMISSION_DENIED');
  assertTransition(o.status, 'assigned');
  const p = await one<any>(`SELECT id,name,duty_on FROM users WHERE id=$1 AND business_id=$2 AND role='delivery_partner' AND status='active' AND deleted_at IS NULL`, [partnerId, biz], c);
  if (!p) throw notFound('Delivery partner not found');
  if (o.current_partner_id === partnerId && o.status === 'assigned') throw conflict('This partner is already assigned to the order', 'ALREADY_ASSIGNED');
  if (!p.duty_on) throw conflict(`${p.name} is off duty and cannot receive new deliveries`, 'PARTNER_OFF_DUTY');
  const u = await unresolvedFor(c, biz, partnerId, id);
  if (u.n > 0) throw conflict(`${p.name} has an unresolved delivery. It must be completed and verified first.`, 'PARTNER_BUSY');

  let d: any;
  if (reassign) {
    d = await latestDelivery(c, id);
    await query(`UPDATE delivery_assignments SET ended_at=now(), end_reason='reassigned' WHERE order_id=$1 AND ended_at IS NULL`, [id], c);
    d = (await one<any>(`UPDATE deliveries SET partner_id=$2,status='assigned',accepted_at=NULL,picked_up_at=NULL WHERE id=$1 RETURNING *`, [d.id, partnerId], c))!;
  } else {
    const att = (await one<any>(`SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM deliveries WHERE order_id=$1`, [id], c))!.n;
    d = (await one<any>(`INSERT INTO deliveries(business_id,order_id,attempt_no,partner_id,status) VALUES($1,$2,$3,$4,'assigned') RETURNING *`, [biz, id, att, partnerId], c))!;
  }
  await query(`INSERT INTO delivery_assignments(business_id,order_id,delivery_id,partner_id,previous_partner_id,assigned_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [biz, id, d.id, partnerId, o.current_partner_id, auth.userId, reason ?? null], c);
  const n = await patchOrder(c, id, { status: 'assigned', current_partner_id: partnerId, final_status: 'pending', completed_at: null, ...(auth.userId && auth.role !== 'api' ? { assigned_manager_id: auth.userId } : {}) });
  if (n.payment_mode === 'cod')
    await query(`INSERT INTO cod_transactions(business_id,order_id,partner_id,expected_amount,status) VALUES($1,$2,$3,$4,'expected')
                 ON CONFLICT (order_id) DO UPDATE SET partner_id=EXCLUDED.partner_id, expected_amount=EXCLUDED.expected_amount, status=CASE WHEN cod_transactions.status='void' THEN 'expected' ELSE cod_transactions.status END`, [biz, id, partnerId, n.receivable_amount], c);
  await logEvent(c, n, o.status, 'assigned', auth, { deliveryId: d.id, notes: reason ?? null, metadata: { partner_id: partnerId, previous_partner_id: o.current_partner_id, reassigned: reassign } });
  await emit(c, biz, 'order.assigned', n, { partner: { id: p.id, name: p.name } });
  await notify(c, { businessId: biz, userId: partnerId, type: reassign ? 'delivery.reassigned' : 'delivery.assigned', title: reassign ? 'Delivery reassigned' : 'New delivery', body: `Order ${n.invoice_number}`, data: { orderId: id } });
  if (reassign && o.current_partner_id) await notify(c, { businessId: biz, userId: o.current_partner_id, type: 'delivery.unassigned', title: 'Delivery reassigned away', body: `Order ${n.invoice_number}`, data: { orderId: id } });
  await notifyCustomer(c, biz, n.customer_mobile, { type: 'order.assigned', title: 'Order assigned', body: `Your order ${n.invoice_number} has been assigned to a delivery partner`, data: { orderId: id } });
  return n;
}

export async function cancelOrder(c: C, auth: Auth, id: string, reason?: string) {
  const o = await lockOrder(c, auth.businessId!, id);
  assertTransition(o.status, 'cancelled');
  const n = await patchOrder(c, id, { status: 'cancelled', final_status: 'complete', completed_at: new Date(), current_partner_id: o.current_partner_id });
  await query(`UPDATE delivery_assignments SET ended_at=now(), end_reason='cancelled' WHERE order_id=$1 AND ended_at IS NULL`, [id], c);
  await query(`UPDATE deliveries SET status='cancelled', completed_at=now() WHERE order_id=$1 AND completed_at IS NULL`, [id], c);
  await query(`UPDATE cod_transactions SET status='void' WHERE order_id=$1 AND collected_amount=0`, [id], c);
  await logEvent(c, n, o.status, 'cancelled', auth, { notes: reason ?? null });
  await emit(c, o.business_id, 'order.updated', n);
  if (o.current_partner_id) await notify(c, { businessId: o.business_id, userId: o.current_partner_id, type: 'delivery.cancelled', title: 'Delivery cancelled', body: `Order ${o.invoice_number}`, data: { orderId: id } });
  return n;
}

export async function retryOrder(c: C, auth: Auth, id: string, notes?: string) {
  const o = await lockOrder(c, auth.businessId!, id);
  if (o.status !== 'failed') throw conflict('Only failed deliveries can be retried', 'INVALID_TRANSITION');
  assertTransition('failed', 'ready');
  const n = await patchOrder(c, id, { status: 'ready', current_partner_id: null, final_status: 'pending', completed_at: null });
  await logEvent(c, n, 'failed', 'ready', auth, { notes: notes ?? 'Retry scheduled' });
  await emit(c, o.business_id, 'order.updated', n);
  return n;
}

// ---------------------------------------------------------------- partner actions
export type Action = 'accept' | 'reject' | 'pickup' | 'start' | 'arrive' | 'deliver' | 'partial' | 'fail' | 'full_return';
const TARGET: Record<Action, OrderStatus> = { accept: 'accepted', reject: 'ready', pickup: 'picked_up', start: 'out_for_delivery', arrive: 'arrived', deliver: 'delivered', partial: 'partial', fail: 'failed', full_return: 'full_return' };

async function assertFiles(c: C, businessId: string, ids: (string | undefined | null)[], orderId: string, label: string, required: boolean) {
  const list = ids.filter(Boolean) as string[];
  if (!list.length) { if (required) throw new AppError(422, 'PROOF_REQUIRED', `${label} is required`); return; }
  const r = await query<any>(`SELECT id FROM files WHERE business_id=$1 AND id = ANY($2) AND (order_id IS NULL OR order_id=$3)`, [businessId, list, orderId], c);
  if (r.length !== new Set(list).size) throw new AppError(422, 'PROOF_INVALID', `${label} is invalid`);
}

function money(o: any, returned: number, body: any, s: any) {
  const expected = round2(o.receivable_amount - returned);
  const mode: string = body.paymentMode ?? o.payment_mode;
  if (!s.payment_modes.includes(mode)) throw badRequest(`Payment mode "${mode}" is not enabled`);
  if (mode === 'prepaid' && expected > 0) throw badRequest('A prepaid payment mode cannot be used for an order with an amount to collect');
  const paid = round2(body.customerPaid ?? (mode === 'prepaid' ? 0 : expected));
  if (mode !== 'cod' && mode !== 'prepaid' && paid > expected + 0.004) throw new AppError(422, 'INVALID_AMOUNT', 'Non-cash payments cannot exceed the amount due');
  const collected = round2(Math.min(paid, expected)), changeGiven = round2(Math.max(0, paid - expected)), shortfall = round2(expected - collected);
  if (shortfall > 0.004 && !body.confirmMismatch)
    throw new AppError(422, 'PAYMENT_MISMATCH', `Payment mismatch: ${shortfall} short of the ${expected} due. Resubmit with confirmMismatch to continue.`, [{ expected, collected, shortfall }]);
  return { expected, mode, collected, changeGiven, mismatch: shortfall > 0.004 };
}

export async function partnerAction(c: C, auth: Auth, id: string, action: Action, body: any = {}) {
  const biz = auth.businessId!;
  const o = await lockOrder(c, biz, id);
  const isPartner = auth.role === 'delivery_partner';
  if (isPartner) { if (o.current_partner_id !== auth.userId) throw forbidden('This delivery is not assigned to you'); }
  else if (!auth.perms.has('deliveries.update') || action === 'accept' || action === 'reject') throw forbidden('Missing permission: deliveries.update', 'PERMISSION_DENIED');
  const to = TARGET[action];
  assertTransition(o.status, to);
  const d = await latestDelivery(c, id);
  const geo: Geo = { latitude: body.latitude, longitude: body.longitude };
  const s = await getSettings(c, biz);
  const now = new Date();
  let patch: Record<string, any> = { status: to }, dpatch: Record<string, any> = { status: to }, extra: any = {};

  if (action === 'reject') {
    await query(`UPDATE delivery_assignments SET ended_at=now(), end_reason='rejected' WHERE order_id=$1 AND ended_at IS NULL`, [id], c);
    await query(`UPDATE deliveries SET status='rejected', completed_at=now() WHERE id=$1`, [d.id], c);
    await query(`UPDATE cod_transactions SET partner_id=NULL WHERE order_id=$1`, [id], c);
    patch = { status: 'ready', current_partner_id: null };
    extra = { rejected_by: auth.userId };
  } else if (action === 'accept') dpatch.accepted_at = now;
  else if (action === 'pickup') dpatch.picked_up_at = now;
  else if (action === 'start') {
    const u = await unresolvedFor(c, biz, o.current_partner_id, id);
    if (u.inflight > 0) throw conflict('Only one order can be Out For Delivery at a time. Finish the current delivery first.', 'DELIVERY_IN_PROGRESS');
    if (u.n > 0) throw conflict('You have a delivery waiting for manager verification. It must be completed before starting another.', 'VERIFICATION_PENDING');
    dpatch.out_for_delivery_at = now; patch.attempts = o.attempts + 1;
    if (s.gps_required && (body.latitude == null || body.longitude == null)) throw new AppError(422, 'PROOF_REQUIRED', 'Location is required');
  } else if (action === 'arrive') dpatch.arrived_at = now;
  else {
    // ---- outcomes -------------------------------------------------------------
    if (s.gps_required && (body.latitude == null || body.longitude == null)) throw new AppError(422, 'PROOF_REQUIRED', 'Location (GPS) is required');
    const files = { payment: body.paymentProofFileId, photo: body.photoFileId, signature: body.signatureFileId, ret: body.returnPhotoFileId };
    patch.completed_at = now; dpatch.completed_at = now;
    if (action === 'deliver') {
      if (s.otp_required && !(body.otp && o.otp_hash && await bcrypt.compare(String(body.otp), o.otp_hash))) throw new AppError(422, 'OTP_INVALID', 'A valid customer OTP is required');
      const m = money(o, 0, body, s);
      await assertFiles(c, biz, [files.payment], id, 'Payment proof', s.payment_proof_required && m.expected > 0);
      await assertFiles(c, biz, [files.photo], id, 'Delivery photo', s.photo_required);
      await assertFiles(c, biz, [files.signature], id, 'Customer signature', s.signature_required);
      Object.assign(patch, { delivered_amount: o.bill_amount, returned_amount: 0, collected_amount: m.collected, change_given: m.changeGiven, payment_mismatch: m.mismatch, final_amount: m.expected, payment_mode: m.mode, final_status: 'pending' });
      await recordPayment(c, o, d, m, auth, files.payment);
      extra = { collected: m.collected, change_given: m.changeGiven, mismatch: m.mismatch };
    } else if (action === 'partial') {
      if (!s.partial_delivery_enabled || !s.returns_enabled) throw forbidden('Partial delivery is disabled for this business', 'FEATURE_DISABLED');
      const returned = round2(body.returnedAmount);
      if (!(returned > 0) || returned >= o.bill_amount) throw new AppError(422, 'INVALID_AMOUNT', `Returned amount must be above 0 and below the bill amount (${o.bill_amount})`);
      const items: any[] = body.returnItems ?? [];
      if (items.length) {
        const sum = round2(items.reduce((a, i) => a + i.quantity * i.unitPrice, 0));
        if (Math.abs(sum - returned) > 0.005) throw new AppError(422, 'RETURN_MISMATCH', `Returned items total ${sum} but returned amount is ${returned}`);
      }
      if (!body.reason) throw badRequest('A return reason is required');
      const m = money(o, returned, body, s);
      await assertFiles(c, biz, [files.payment], id, 'Payment proof', s.payment_proof_required && m.expected > 0);
      await assertFiles(c, biz, [files.ret], id, 'Return item photo', s.return_photo_required);
      await assertFiles(c, biz, [files.signature], id, 'Customer signature', s.signature_required);
      const delivered = round2(o.bill_amount - returned);   // Delivered = Original - Returned (original bill amount is never overwritten)
      Object.assign(patch, { delivered_amount: delivered, returned_amount: returned, collected_amount: m.collected, change_given: m.changeGiven, payment_mismatch: m.mismatch, final_amount: m.expected, payment_mode: m.mode, final_status: 'pending' });
      await recordPayment(c, o, d, m, auth, files.payment);
      await createReturn(c, o, d, 'partial', returned, delivered, body.reason, body.notes, items, files.ret, auth);
      extra = { original_amount: o.bill_amount, returned_amount: returned, delivered_amount: delivered, collected: m.collected };
    } else if (action === 'full_return') {
      if (!s.returns_enabled) throw forbidden('Returns are disabled for this business', 'FEATURE_DISABLED');
      if (!body.reason) throw badRequest('A return reason is required');
      await assertFiles(c, biz, [files.ret], id, 'Return item photo', s.return_photo_required);
      Object.assign(patch, { delivered_amount: 0, returned_amount: o.bill_amount, collected_amount: 0, change_given: 0, final_amount: 0, final_status: 'pending' });
      await createReturn(c, o, d, 'full', o.bill_amount, 0, body.reason, body.notes, body.returnItems ?? [], files.ret, auth);
      await query(`UPDATE cod_transactions SET status='void' WHERE order_id=$1`, [id], c);
      extra = { returned_amount: o.bill_amount };
    } else if (action === 'fail') {
      if (!body.reason) throw badRequest('A failure reason is required');
      Object.assign(patch, { collected_amount: 0, final_status: 'pending', final_amount: 0 });
      Object.assign(dpatch, { failure_reason: body.reason, failure_notes: body.notes ?? null });
      await query(`UPDATE cod_transactions SET status='void' WHERE order_id=$1 AND collected_amount=0`, [id], c);
      extra = { reason: body.reason, attempt: d.attempt_no };
    }
    dpatch.proof = JSON.stringify({ ...files, otp_verified: action === 'deliver' && s.otp_required });
    if (action !== 'fail' || true) await query(`UPDATE delivery_assignments SET ended_at=now(), end_reason='completed' WHERE order_id=$1 AND ended_at IS NULL`, [id], c);
  }

  const n = await patchOrder(c, id, patch);
  const dk = Object.keys(dpatch);
  if (dk.length) await query(`UPDATE deliveries SET ${dk.map((k, i) => `${k}=$${i + 2}${k === 'proof' ? '::jsonb' : ''}`).join(',')} WHERE id=$1`, [d.id, ...dk.map(k => dpatch[k])], c);
  await logEvent(c, n, o.status, n.status, auth, { deliveryId: d.id, notes: body.notes ?? body.reason ?? null, geo, metadata: extra });
  await emit(c, biz, STATUS_EVENT[n.status] ?? 'order.updated', n, { delivery: { id: d.id, attempt_no: d.attempt_no }, ...extra });
  await afterTransition(c, n, o, action);
  return n;
}

async function afterTransition(c: C, n: any, prev: any, action: Action) {
  const biz = n.business_id;
  if (action === 'start') await notifyCustomer(c, biz, n.customer_mobile, { type: 'delivery.out_for_delivery', title: 'Out for delivery', body: `Your order ${n.invoice_number} is out for delivery`, data: { orderId: n.id } });
  if (['deliver', 'partial'].includes(action)) {
    await notifyCustomer(c, biz, n.customer_mobile, { type: 'delivery.completed', title: 'Delivered', body: `Your order ${n.invoice_number} was delivered`, data: { orderId: n.id } });
    await notifyRole(c, biz, ['manager'], { type: action === 'partial' ? 'delivery.partial' : 'delivery.delivered', title: 'Verification needed', body: `Order ${n.invoice_number} ${action === 'partial' ? 'partially delivered' : 'delivered'}`, data: { orderId: n.id } });
    if (n.payment_mismatch) await notifyRole(c, biz, ['manager', 'business_admin'], { type: 'cod.mismatch', title: 'Payment mismatch', body: `Order ${n.invoice_number}`, data: { orderId: n.id } });
  }
  if (action === 'fail') await notifyRole(c, biz, ['manager'], { type: 'delivery.failed', title: 'Delivery failed', body: `Order ${n.invoice_number}`, data: { orderId: n.id } });
  if (action === 'full_return') await notifyRole(c, biz, ['manager'], { type: 'delivery.returned', title: 'Order returned', body: `Order ${n.invoice_number}`, data: { orderId: n.id } });
  if (action === 'reject') await notifyRole(c, biz, ['manager'], { type: 'delivery.rejected', title: 'Delivery rejected by partner', body: `Order ${n.invoice_number} needs reassignment`, data: { orderId: n.id } });
}

async function recordPayment(c: C, o: any, d: any, m: any, auth: Auth, proofId?: string) {
  await query(`INSERT INTO payments(business_id,order_id,delivery_id,mode,amount,expected_amount,change_given,status,proof_file_id,collected_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [o.business_id, o.id, d.id, m.mode, m.collected, m.expected, m.changeGiven, m.mismatch ? 'mismatch' : 'received', proofId ?? null, auth.userId], c);
  if (m.mode === 'cod')
    await query(`INSERT INTO cod_transactions(business_id,order_id,partner_id,expected_amount,collected_amount,change_given,status) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (order_id) DO UPDATE SET expected_amount=EXCLUDED.expected_amount, collected_amount=EXCLUDED.collected_amount, change_given=EXCLUDED.change_given, status=EXCLUDED.status`,
      [o.business_id, o.id, o.current_partner_id, m.expected, m.collected, m.changeGiven, m.collected > 0 ? 'collected' : 'void'], c);
  else await query(`UPDATE cod_transactions SET status='void' WHERE order_id=$1 AND collected_amount=0`, [o.id], c);
}

async function createReturn(c: C, o: any, d: any, type: 'partial' | 'full', returned: number, delivered: number, reason: string, notes: string | undefined, items: any[], photo: string | undefined, auth: Auth) {
  const r = (await one<any>(`INSERT INTO returns(business_id,order_id,delivery_id,return_type,original_amount,returned_amount,delivered_amount,reason,notes,photo_file_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [o.business_id, o.id, d.id, type, o.bill_amount, returned, delivered, reason, notes ?? null, photo ?? null, auth.userId], c))!;
  for (const i of items)
    await query(`INSERT INTO return_items(business_id,return_id,order_item_id,sku,name,quantity,unit_price,amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [o.business_id, r.id, i.orderItemId ?? null, i.sku ?? null, i.name, i.quantity, i.unitPrice, round2(i.quantity * i.unitPrice)], c);
  return r;
}

// ---------------------------------------------------------------- manager verification
export async function verifyOrder(c: C, auth: Auth, id: string, b: { result: 'complete' | 'incomplete'; finalAmount?: number; remarks?: string }) {
  const o = await lockOrder(c, auth.businessId!, id);
  if (!['delivered', 'partial', 'failed', 'full_return'].includes(o.status)) throw conflict('Only orders with a delivery outcome can be verified', 'INVALID_TRANSITION');
  const finalAmount = round2(b.finalAmount ?? o.final_amount ?? 0);
  if (finalAmount < 0 || finalAmount > o.receivable_amount + 0.004) throw new AppError(422, 'INVALID_AMOUNT', `Final amount must be between 0 and ${o.receivable_amount}`);
  if (b.result === 'complete' && Math.abs(finalAmount - o.collected_amount) > 0.004 && !b.remarks?.trim())
    throw new AppError(422, 'REMARKS_REQUIRED', `Collected amount (${o.collected_amount}) differs from the final amount (${finalAmount}); add remarks to complete`);
  const n = await patchOrder(c, id, { final_status: b.result, final_amount: finalAmount, verified_by: auth.userId, verified_at: new Date(), manager_remarks: b.remarks ?? null });
  await logEvent(c, n, o.status, `verified_${b.result}`, auth, { notes: b.remarks ?? null, metadata: { final_amount: finalAmount, collected_amount: o.collected_amount } });
  await emit(c, o.business_id, 'order.updated', n);
  if (o.current_partner_id) await notify(c, { businessId: o.business_id, userId: o.current_partner_id, type: 'delivery.verified', title: `Order marked ${b.result}`, body: `Order ${o.invoice_number}`, data: { orderId: id } });
  return n;
}
