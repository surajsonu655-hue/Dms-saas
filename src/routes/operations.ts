import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { z } from 'zod';
import { authenticate, biz, notPartner, requirePerm, requireRole, requireTenant } from '../auth.js';
import { one, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, wrap, AppError } from '../errors.js';
import { created, ok } from '../http.js';
import { isoDate, lat, lng, likePattern, mobile, modeKey, money, positiveMoney, uuid } from '../validate.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { assertOrderQuota, assertWritable } from '../services/plan.js';
import * as orders from '../services/orders.js';
import { settleCod, submitCod, codSummary } from '../services/cod.js';
import { FILE_KINDS, newKey, sniffMime, storage } from '../services/storage.js';
import { REPORT_TYPES, runReport, toCsv, toHtmlTable, type ReportType } from '../services/reports.js';
import { meta, paging, sortBy } from './util.js';

export const opsRouter = Router();
opsRouter.use(authenticate, requireTenant);

const COLS = `o.id,o.business_id,o.invoice_number,o.customer_id,o.customer_name,o.customer_mobile,o.customer_address,o.area,o.bill_amount,o.change_amount,o.receivable_amount,o.payment_mode,o.status,o.priority,o.delivery_date,o.notes,o.remarks,
  o.assigned_manager_id,o.current_partner_id,o.attempts,o.returned_amount,o.delivered_amount,o.collected_amount,o.change_given,o.payment_mismatch,o.final_amount,o.final_status,o.verified_by,o.verified_at,o.manager_remarks,o.completed_at,o.created_by,o.created_at,o.updated_at`;

// ---- orders -------------------------------------------------------------------
const item = z.object({ sku: z.string().max(60).optional(), name: z.string().trim().min(1).max(200), quantity: z.coerce.number().positive().max(100000), unitPrice: money });
const orderBody = z.object({
  invoiceNumber: z.string().trim().min(1).max(40).optional(), customerName: z.string().trim().min(1).max(120), customerMobile: mobile, customerAddress: z.string().trim().min(3).max(300),
  area: z.string().max(80).optional(), city: z.string().max(80).optional(), pincode: z.string().max(12).optional(),
  billAmount: positiveMoney, changeAmount: money.default(0), paymentMode: modeKey, deliveryDate: isoDate.optional(), priority: z.enum(['low', 'normal', 'high']).optional(),
  notes: z.string().max(500).optional(), items: z.array(item).max(200).optional(), partnerId: uuid.optional(),
});

opsRouter.get('/orders', requirePerm('orders.view'), notPartner, wrap(async (req, res) => {
  const p = paging(req);
  const STATUSES = ['created', 'ready', 'assigned', 'accepted', 'picked_up', 'out_for_delivery', 'arrived', 'delivered', 'partial', 'failed', 'full_return', 'cancelled'] as const;
  const q = z.object({ q: z.string().max(80).optional(), status: z.string().max(200).transform(v => v.split(',').map(x => x.trim()).filter(Boolean)).pipe(z.array(z.enum(STATUSES)).min(1)).optional(),
    partnerId: uuid.optional(), managerId: uuid.optional(), paymentMode: modeKey.optional(), finalStatus: z.enum(['pending', 'complete', 'incomplete']).optional(), from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
  const where = `o.business_id=$1 AND o.deleted_at IS NULL AND ($2::text[] IS NULL OR o.status = ANY($2)) AND ($3::uuid IS NULL OR o.current_partner_id=$3) AND ($4::uuid IS NULL OR o.assigned_manager_id=$4)
     AND ($5::text IS NULL OR o.payment_mode=$5) AND ($6::text IS NULL OR o.final_status=$6)
     AND ($7::date IS NULL OR o.created_at >= ($7::date)::timestamp AT TIME ZONE (SELECT timezone FROM businesses WHERE id=$1)) AND ($8::date IS NULL OR o.created_at < ($8::date+1)::timestamp AT TIME ZONE (SELECT timezone FROM businesses WHERE id=$1))
     AND ($9::text IS NULL OR o.invoice_number ILIKE $9 OR o.customer_name ILIKE $9 OR o.customer_mobile ILIKE $9)`;
  const args = [biz(req), q.status ?? null, q.partnerId ?? null, q.managerId ?? null, q.paymentMode ?? null, q.finalStatus ?? null, q.from ?? null, q.to ?? null, q.q ? likePattern(q.q) : null];
  const total = (await one<any>(`SELECT count(*)::int n FROM orders o WHERE ${where}`, args))!.n;
  const rows = await query(`SELECT ${COLS}, u.name AS partner_name FROM orders o LEFT JOIN users u ON u.id=o.current_partner_id WHERE ${where}
      ORDER BY ${sortBy(req, { created_at: 'o.created_at', bill_amount: 'o.bill_amount', status: 'o.status', invoice_number: 'o.invoice_number' }, 'o.created_at')}, o.id LIMIT $10 OFFSET $11`, [...args, p.limit, p.offset]);
  ok(res, rows, 'OK', 200, meta(p, total));
}));

opsRouter.post('/orders', requirePerm('orders.create'), notPartner, wrap(async (req, res) => {
  const b = orderBody.parse(req.body);
  const r = await tx(async c => {
    await assertOrderQuota(biz(req), c);
    if (b.partnerId && !req.auth!.perms.has('deliveries.assign')) throw forbidden('Missing permission: deliveries.assign', 'PERMISSION_DENIED');
    const out = await orders.createOrder(c, req.auth!, b);
    return out;
  });
  const { otp_hash, ...order } = r.order;
  created(res, { ...order, otp_for_testing: r.debugOtp }, 'Order created successfully');
}));

// Dashboard counters in ONE query (replaces N list calls from the UI). Tenant comes from the session.
opsRouter.get('/orders/summary', requirePerm('orders.view'), notPartner, wrap(async (req, res) => {
  const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
  const r = (await one<any>(`SELECT count(*)::int total,
      count(*) FILTER (WHERE status IN ('assigned','accepted','picked_up'))::int assigned,
      count(*) FILTER (WHERE status IN ('out_for_delivery','arrived'))::int out_for_delivery,
      count(*) FILTER (WHERE status='delivered')::int delivered, count(*) FILTER (WHERE status='partial')::int partial,
      count(*) FILTER (WHERE status='full_return')::int full_return, count(*) FILTER (WHERE status='cancelled')::int cancelled,
      count(*) FILTER (WHERE status='failed')::int failed, count(*) FILTER (WHERE status IN ('created','ready'))::int unassigned,
      count(*) FILTER (WHERE status IN ('delivered','partial','failed','full_return') AND final_status='pending')::int pending_verification,
      COALESCE(sum(collected_amount),0) AS total_collection
    FROM orders o WHERE business_id=$1 AND deleted_at IS NULL
      AND ($2::date IS NULL OR created_at >= ($2::date)::timestamp AT TIME ZONE (SELECT timezone FROM businesses WHERE id=$1))
      AND ($3::date IS NULL OR created_at < ($3::date+1)::timestamp AT TIME ZONE (SELECT timezone FROM businesses WHERE id=$1))`, [biz(req), q.from ?? null, q.to ?? null]))!;
  ok(res, r);
}));

// Partners the caller may assign work to (Managers do not hold users.view, so they cannot use /users for this).
opsRouter.get('/delivery-partners', notPartner, wrap(async (req, res) => {
  const a = req.auth!;
  if (!['deliveries.assign', 'deliveries.reassign', 'deliveries.view'].some(p => a.perms.has(p))) throw forbidden('Missing permission: deliveries.assign', 'PERMISSION_DENIED');
  ok(res, await query(`SELECT u.id,u.name,u.mobile,u.duty_on,
      (SELECT count(*)::int FROM orders o WHERE o.business_id=u.business_id AND o.current_partner_id=u.id AND o.deleted_at IS NULL
         AND (o.status IN ('out_for_delivery','arrived') OR (o.status IN ('delivered','partial','failed','full_return') AND o.final_status IN ('pending','incomplete')))) AS unresolved,
      (SELECT count(*)::int FROM orders o WHERE o.business_id=u.business_id AND o.current_partner_id=u.id AND o.deleted_at IS NULL AND o.status IN ('assigned','accepted','picked_up')) AS queued
    FROM users u WHERE u.business_id=$1 AND u.role='delivery_partner' AND u.status='active' AND u.deleted_at IS NULL ORDER BY u.name`, [biz(req)]));
}));

opsRouter.get('/orders/:id', requirePerm('orders.view'), notPartner, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id), b = biz(req);
  const o = await one<any>(`SELECT ${COLS}, u.name AS partner_name FROM orders o LEFT JOIN users u ON u.id=o.current_partner_id WHERE o.id=$1 AND o.business_id=$2 AND o.deleted_at IS NULL`, [id, b]);
  if (!o) throw notFound('Order not found');
  const [items, events, assignments, deliveries, payments, returns, cod, files] = await Promise.all([
    query(`SELECT * FROM order_items WHERE order_id=$1 AND business_id=$2 ORDER BY created_at`, [id, b]),
    query(`SELECT e.*, u.name AS changed_by_name FROM delivery_events e LEFT JOIN users u ON u.id=e.changed_by WHERE e.order_id=$1 AND e.business_id=$2 ORDER BY e.created_at, e.id`, [id, b]),
    query(`SELECT a.*, p.name AS partner_name, pp.name AS previous_partner_name, ab.name AS assigned_by_name FROM delivery_assignments a JOIN users p ON p.id=a.partner_id LEFT JOIN users pp ON pp.id=a.previous_partner_id LEFT JOIN users ab ON ab.id=a.assigned_by WHERE a.order_id=$1 AND a.business_id=$2 ORDER BY a.assigned_at`, [id, b]),
    query(`SELECT * FROM deliveries WHERE order_id=$1 AND business_id=$2 ORDER BY attempt_no`, [id, b]),
    query(`SELECT * FROM payments WHERE order_id=$1 AND business_id=$2 ORDER BY created_at`, [id, b]),
    query(`SELECT r.*, COALESCE((SELECT json_agg(i) FROM return_items i WHERE i.return_id=r.id),'[]') AS items FROM returns r WHERE r.order_id=$1 AND r.business_id=$2`, [id, b]),
    one(`SELECT * FROM cod_transactions WHERE order_id=$1 AND business_id=$2`, [id, b]),
    query(`SELECT id,kind,mime_type,size_bytes,uploaded_by,created_at FROM files WHERE order_id=$1 AND business_id=$2`, [id, b]),
  ]);
  ok(res, { order: o, items, events, assignments, deliveries, payments, returns, cod, files });
}));

opsRouter.patch('/orders/:id', requirePerm('orders.edit'), notPartner, wrap(async (req, res) => {
  const b = orderBody.omit({ items: true, partnerId: true, invoiceNumber: true }).partial().extend({ remarks: z.string().max(500).optional() }).parse(req.body);
  const o = await tx(c => orders.updateOrder(c, req.auth!, uuid.parse(req.params.id), b));
  const { otp_hash, ...pub } = o; ok(res, pub, 'Order updated');
}));
opsRouter.delete('/orders/:id', requirePerm('orders.delete'), notPartner, wrap(async (req, res) => {
  const o = await tx(async c => { const r = await orders.softDeleteOrder(c, req.auth!, uuid.parse(req.params.id)); await audit(c, { auth: req.auth, action: 'order.deleted', entity: 'order', entityId: r.id, oldValue: { invoice: r.invoice_number }, req }); return r; });
  ok(res, { id: o.id }, 'Order deleted');
}));
opsRouter.post('/orders/:id/ready', requirePerm('orders.edit'), notPartner, wrap(async (req, res) => ok(res, strip(await tx(c => orders.setReady(c, req.auth!, uuid.parse(req.params.id)))), 'Order is ready for delivery')));
const strip = ({ otp_hash, ...o }: any) => o;
// assign / reassign: the specific permission (assign vs reassign) is checked inside the transaction once we know which one it is
opsRouter.post('/orders/:id/assign', notPartner, wrap(async (req, res) => {
  // authorise BEFORE parsing the body, so callers without the right never learn anything about validation rules
  if (!req.auth!.perms.has('deliveries.assign') && !req.auth!.perms.has('deliveries.reassign')) throw forbidden('Missing permission: deliveries.assign', 'PERMISSION_DENIED');
  const b = z.object({ partnerId: uuid, reason: z.string().max(300).optional() }).parse(req.body);
  await assertWritable(biz(req));
  ok(res, strip(await tx(c => orders.assignOrder(c, req.auth!, uuid.parse(req.params.id), b.partnerId, b.reason))), 'Delivery partner assigned');
}));
opsRouter.post('/orders/:id/cancel', requirePerm('orders.edit'), notPartner, wrap(async (req, res) => {
  const b = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {});
  ok(res, strip(await tx(c => orders.cancelOrder(c, req.auth!, uuid.parse(req.params.id), b.reason))), 'Order cancelled');
}));
opsRouter.post('/orders/:id/retry', requirePerm('deliveries.assign'), notPartner, wrap(async (req, res) => ok(res, strip(await tx(c => orders.retryOrder(c, req.auth!, uuid.parse(req.params.id), req.body?.notes))), 'Order is ready to be reassigned')));
opsRouter.post('/orders/:id/verify', requirePerm('deliveries.verify'), notPartner, wrap(async (req, res) => {
  const b = z.object({ result: z.enum(['complete', 'incomplete']), finalAmount: money.optional(), remarks: z.string().max(500).optional() }).parse(req.body);
  ok(res, strip(await tx(c => orders.verifyOrder(c, req.auth!, uuid.parse(req.params.id), b))), `Order marked ${b.result}`);
}));
opsRouter.get('/orders/:id/events', requirePerm('orders.view'), notPartner, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  if (!await one(`SELECT 1 FROM orders WHERE id=$1 AND business_id=$2`, [id, biz(req)])) throw notFound('Order not found');
  ok(res, await query(`SELECT e.*, u.name AS changed_by_name FROM delivery_events e LEFT JOIN users u ON u.id=e.changed_by WHERE e.order_id=$1 AND e.business_id=$2 ORDER BY e.created_at, e.id`, [id, biz(req)]));
}));

// ---- deliveries ------------------------------------------------------------------------
const DCOLS = `o.id,o.invoice_number,o.customer_name,o.customer_mobile,o.customer_address,o.area,o.bill_amount,o.change_amount,o.receivable_amount,o.payment_mode,o.status,o.priority,o.final_status,o.collected_amount,o.returned_amount,o.final_amount,o.completed_at,o.created_at,o.updated_at,o.current_partner_id`;
opsRouter.get('/deliveries', wrap(async (req, res) => {
  const a = req.auth!, p = paging(req), q = z.object({ scope: z.enum(['active', 'history', 'all']).default('active'), status: z.string().max(30).optional(), partnerId: uuid.optional() }).parse(req.query);
  if (a.role === 'delivery_partner') {
    const where = `o.business_id=$1 AND o.current_partner_id=$2 AND o.deleted_at IS NULL AND ($3='all' OR ($3='active' AND (o.status IN ('assigned','accepted','picked_up','out_for_delivery','arrived') OR (o.status IN ('delivered','partial','failed','full_return') AND o.final_status IN ('pending','incomplete'))))
         OR ($3='history' AND o.status IN ('delivered','partial','full_return','failed','cancelled') AND o.final_status='complete'))`;
    const total = (await one<any>(`SELECT count(*)::int n FROM orders o WHERE ${where}`, [biz(req), a.userId, q.scope]))!.n;
    return ok(res, await query(`SELECT ${DCOLS} FROM orders o WHERE ${where} ORDER BY CASE o.status WHEN 'out_for_delivery' THEN 0 WHEN 'arrived' THEN 0 WHEN 'accepted' THEN 1 WHEN 'picked_up' THEN 1 WHEN 'assigned' THEN 2 ELSE 3 END, o.created_at LIMIT $4 OFFSET $5`, [biz(req), a.userId, q.scope, p.limit, p.offset]), 'OK', 200, meta(p, total));
  }
  if (!a.perms.has('deliveries.view')) throw forbidden('Missing permission: deliveries.view', 'PERMISSION_DENIED');
  const where = `o.business_id=$1 AND o.deleted_at IS NULL AND o.current_partner_id IS NOT NULL AND ($2::text IS NULL OR o.status=$2) AND ($3::uuid IS NULL OR o.current_partner_id=$3)`;
  const total = (await one<any>(`SELECT count(*)::int n FROM orders o WHERE ${where}`, [biz(req), q.status ?? null, q.partnerId ?? null]))!.n;
  ok(res, await query(`SELECT ${DCOLS}, u.name AS partner_name FROM orders o JOIN users u ON u.id=o.current_partner_id WHERE ${where} ORDER BY o.updated_at DESC LIMIT $4 OFFSET $5`, [biz(req), q.status ?? null, q.partnerId ?? null, p.limit, p.offset]), 'OK', 200, meta(p, total));
}));
opsRouter.get('/deliveries/:orderId', requireRole('delivery_partner'), wrap(async (req, res) => {
  const o = await one<any>(`SELECT ${DCOLS} FROM orders o WHERE o.id=$1 AND o.business_id=$2 AND o.current_partner_id=$3 AND o.deleted_at IS NULL`, [uuid.parse(req.params.orderId), biz(req), req.auth!.userId]);
  if (!o) throw forbidden('This delivery is not assigned to you');
  ok(res, { order: o, items: await query(`SELECT sku,name,quantity,unit_price,total FROM order_items WHERE order_id=$1 AND business_id=$2`, [o.id, biz(req)]) });
}));

const returnItem = z.object({ orderItemId: uuid.optional(), sku: z.string().max(60).optional(), name: z.string().trim().min(1).max(200), quantity: z.coerce.number().positive().max(100000), unitPrice: money });
const actionBody = z.object({
  notes: z.string().max(500).optional(), reason: z.string().trim().min(2).max(200).optional(), latitude: lat.optional(), longitude: lng.optional(), otp: z.string().regex(/^\d{4,8}$/).optional(),
  paymentMode: modeKey.optional(), customerPaid: money.optional(), confirmMismatch: z.boolean().optional(), returnedAmount: positiveMoney.optional(), returnItems: z.array(returnItem).max(200).optional(),
  paymentProofFileId: uuid.optional(), photoFileId: uuid.optional(), signatureFileId: uuid.optional(), returnPhotoFileId: uuid.optional(),
}).partial();
const ACTIONS: Record<string, orders.Action> = { accept: 'accept', reject: 'reject', pickup: 'pickup', start: 'start', arrive: 'arrive', deliver: 'deliver', partial: 'partial', fail: 'fail', 'full-return': 'full_return', full_return: 'full_return' };   // both spellings: the API docs and the UI use the underscore form
opsRouter.post('/deliveries/:orderId/:action', wrap(async (req, res) => {
  const act = ACTIONS[req.params.action]; if (!act) throw notFound('Unknown delivery action');
  if (req.auth!.kind === 'api_key') throw forbidden('API keys cannot perform delivery actions');
  const b = actionBody.parse(req.body ?? {});
  const o = await tx(c => orders.partnerAction(c, req.auth!, uuid.parse(req.params.orderId), act, b));
  ok(res, strip(o), `Order ${o.status.replace(/_/g, ' ')}`);
}));

// ---- files -------------------------------------------------------------------------------------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.storage.maxBytes, files: 1, fields: 10 } });
opsRouter.post('/files', upload.single('file'), wrap(async (req, res) => {
  const a = req.auth!; if (!a.userId) throw forbidden('API keys cannot upload files');
  const b = z.object({ kind: z.enum(FILE_KINDS as [string, ...string[]]), orderId: uuid.optional() }).parse(req.body);
  if (!req.file) throw badRequest('A file is required (multipart field "file")');
  const mime = sniffMime(req.file.buffer);
  if (!mime || (mime === 'application/pdf' && !['document', 'payment_proof'].includes(b.kind))) throw new AppError(415, 'UNSUPPORTED_FILE', 'Only JPEG, PNG, WebP images (and PDF documents) are accepted');
  if (a.role === 'delivery_partner') {
    if (!b.orderId || b.kind === 'logo') throw forbidden('Delivery partners can only upload proofs for their own deliveries');
    if (!await one(`SELECT 1 FROM orders WHERE id=$1 AND business_id=$2 AND current_partner_id=$3`, [b.orderId, biz(req), a.userId])) throw forbidden('This delivery is not assigned to you');
  } else {
    if (!a.perms.has(b.kind === 'logo' ? 'settings.manage' : 'orders.view')) throw forbidden('Missing permission', 'PERMISSION_DENIED');
    if (b.orderId && !await one(`SELECT 1 FROM orders WHERE id=$1 AND business_id=$2`, [b.orderId, biz(req)])) throw notFound('Order not found');
  }
  const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' } as any)[mime];
  const key = newKey(biz(req), ext);
  await storage().put(key, req.file.buffer, mime);
  const f = await one<any>(`INSERT INTO files(business_id,storage_key,kind,mime_type,size_bytes,order_id,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,kind,mime_type,size_bytes,order_id,created_at`, [biz(req), key, b.kind, mime, req.file.size, b.orderId ?? null, a.userId]);
  created(res, f, 'File uploaded');
}));
opsRouter.get('/files/:id', wrap(async (req, res) => {
  const a = req.auth!, f = await one<any>(`SELECT * FROM files WHERE id=$1 AND business_id=$2`, [uuid.parse(req.params.id), biz(req)]); if (!f) throw notFound('File not found');
  if (a.role === 'delivery_partner') {
    const ok1 = f.uploaded_by === a.userId || (f.order_id && await one(`SELECT 1 FROM orders WHERE id=$1 AND current_partner_id=$2`, [f.order_id, a.userId]));
    if (!ok1) throw forbidden();
  } else if (!a.perms.has('orders.view') && !a.perms.has('deliveries.view') && f.kind !== 'logo') throw forbidden('Missing permission', 'PERMISSION_DENIED');
  const buf = await storage().get(f.storage_key);
  res.setHeader('content-type', f.mime_type); res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('cache-control', 'private, max-age=300');
  res.setHeader('content-disposition', `${f.mime_type === 'application/pdf' ? 'attachment' : 'inline'}; filename="${path.basename(f.storage_key)}"`);
  res.send(buf);
}));

// ---- COD -------------------------------------------------------------------------------------------
opsRouter.get('/cod/summary', wrap(async (req, res) => {
  const a = req.auth!;
  if (a.role === 'delivery_partner') return ok(res, await codSummary(biz(req), a.userId!));
  if (!a.perms.has('cod.view')) throw forbidden('Missing permission: cod.view', 'PERMISSION_DENIED');
  const rows = await codSummary(biz(req));
  const sum = (k: string) => Math.round(rows.reduce((s: number, r: any) => s + Number(r[k]), 0) * 100) / 100;
  ok(res, { partners: rows, totals: { expected: sum('expected'), collected: sum('collected'), changeGiven: sum('change_given'), settled: sum('settled'), pending: sum('pending'), submitted: sum('submitted') } });
}));
opsRouter.get('/cod/transactions', wrap(async (req, res) => {
  const a = req.auth!, p = paging(req), q = z.object({ status: z.enum(['expected', 'collected', 'submitted', 'settled', 'void']).optional(), partnerId: uuid.optional() }).parse(req.query);
  if (a.role !== 'delivery_partner' && !a.perms.has('cod.view')) throw forbidden('Missing permission: cod.view', 'PERMISSION_DENIED');
  const partner = a.role === 'delivery_partner' ? a.userId : q.partnerId ?? null;
  const where = `t.business_id=$1 AND ($2::uuid IS NULL OR t.partner_id=$2) AND ($3::text IS NULL OR t.status=$3)`;
  const total = (await one<any>(`SELECT count(*)::int n FROM cod_transactions t WHERE ${where}`, [biz(req), partner, q.status ?? null]))!.n;
  ok(res, await query(`SELECT t.*, o.invoice_number, u.name AS partner_name FROM cod_transactions t JOIN orders o ON o.id=t.order_id LEFT JOIN users u ON u.id=t.partner_id WHERE ${where} ORDER BY t.created_at DESC LIMIT $4 OFFSET $5`, [biz(req), partner, q.status ?? null, p.limit, p.offset]), 'OK', 200, meta(p, total));
}));
opsRouter.post('/cod/submit', requireRole('delivery_partner'), wrap(async (req, res) => {
  const n = await tx(c => submitCod(c, biz(req), req.auth!.userId!));
  ok(res, { submitted: n }, n ? 'Cash submitted for settlement' : 'No collected cash to submit');
}));
opsRouter.post('/cod/settlements', requirePerm('cod.settle'), notPartner, wrap(async (req, res) => {
  const b = z.object({ partnerId: uuid, amount: positiveMoney, referenceNo: z.string().max(80).optional(), notes: z.string().max(300).optional() }).parse(req.body);
  const r = await tx(async c => { const out = await settleCod(c, biz(req), b.partnerId, b.amount, req.auth!.userId!, b.referenceNo, b.notes); await audit(c, { auth: req.auth, action: 'cod.settled', entity: 'cod_settlement', entityId: out.settlement.id, newValue: { partnerId: b.partnerId, amount: b.amount }, req }); return out; });
  created(res, r, 'COD settled');
}));
opsRouter.get('/cod/settlements', requirePerm('cod.view'), notPartner, wrap(async (req, res) => {
  const p = paging(req);
  const total = (await one<any>(`SELECT count(*)::int n FROM cod_settlements WHERE business_id=$1`, [biz(req)]))!.n;
  ok(res, await query(`SELECT s.*, u.name AS partner_name, sb.name AS settled_by_name FROM cod_settlements s JOIN users u ON u.id=s.partner_id LEFT JOIN users sb ON sb.id=s.settled_by WHERE s.business_id=$1 ORDER BY s.settled_at DESC LIMIT $2 OFFSET $3`, [biz(req), p.limit, p.offset]), 'OK', 200, meta(p, total));
}));

// ---- returns -----------------------------------------------------------------------------------------------
const RETURN_FLOW = ['created', 'assigned', 'picked_up', 'received', 'verified', 'closed'];
opsRouter.get('/returns', requirePerm('returns.view'), notPartner, wrap(async (req, res) => {
  const p = paging(req), q = z.object({ status: z.enum(RETURN_FLOW as [string, ...string[]]).optional(), type: z.enum(['partial', 'full']).optional(), from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
  const where = `r.business_id=$1 AND ($2::text IS NULL OR r.status=$2) AND ($3::text IS NULL OR r.return_type=$3) AND ($4::date IS NULL OR r.created_at >= $4::date) AND ($5::date IS NULL OR r.created_at < $5::date+1)`;
  const args = [biz(req), q.status ?? null, q.type ?? null, q.from ?? null, q.to ?? null];
  const total = (await one<any>(`SELECT count(*)::int n FROM returns r WHERE ${where}`, args))!.n;
  const totals = await one<any>(`SELECT count(*)::int count, COALESCE(sum(returned_amount),0) value, count(*) FILTER (WHERE return_type='full')::int full_count, count(*) FILTER (WHERE return_type='partial')::int partial_count FROM returns r WHERE ${where}`, args);
  const rows = await query(`SELECT r.*, o.invoice_number, o.customer_name, u.name AS partner_name FROM returns r JOIN orders o ON o.id=r.order_id LEFT JOIN users u ON u.id=r.created_by WHERE ${where} ORDER BY r.created_at DESC LIMIT $6 OFFSET $7`, [...args, p.limit, p.offset]);
  ok(res, { returns: rows, totals }, 'OK', 200, meta(p, total));
}));
opsRouter.patch('/returns/:id/status', requirePerm('returns.manage'), notPartner, wrap(async (req, res) => {
  const b = z.object({ status: z.enum(RETURN_FLOW as [string, ...string[]]) }).parse(req.body), id = uuid.parse(req.params.id);
  const r = await tx(async c => {
    const cur = await one<any>(`SELECT * FROM returns WHERE id=$1 AND business_id=$2 FOR UPDATE`, [id, biz(req)], c); if (!cur) throw notFound('Return not found');
    if (RETURN_FLOW.indexOf(b.status) !== RETURN_FLOW.indexOf(cur.status) + 1) throw new AppError(409, 'INVALID_TRANSITION', `A return in "${cur.status}" can only move to "${RETURN_FLOW[RETURN_FLOW.indexOf(cur.status) + 1] ?? 'nothing (it is closed)'}"`);
    return (await one<any>(`UPDATE returns SET status=$2 WHERE id=$1 RETURNING *`, [id, b.status], c))!;
  });
  ok(res, r, 'Return updated');
}));

// ---- reports -----------------------------------------------------------------------------------------------
opsRouter.get('/reports', requirePerm('reports.view'), notPartner, wrap(async (_q, res) => ok(res, REPORT_TYPES)));
opsRouter.get('/reports/:type', requirePerm('reports.view'), notPartner, wrap(async (req, res) => {
  const type = z.enum(REPORT_TYPES).parse(req.params.type) as ReportType;
  const q = z.object({ from: isoDate.optional(), to: isoDate.optional(), status: z.string().max(30).optional(), partnerId: uuid.optional(), managerId: uuid.optional(), format: z.enum(['json', 'csv', 'excel', 'html']).default('json') }).parse(req.query);
  if (q.format !== 'json' && !req.auth!.perms.has('reports.export')) throw forbidden('Missing permission: reports.export', 'PERMISSION_DENIED');
  const f = { from: q.from, to: q.to, status: q.status, partnerId: q.partnerId, managerId: q.managerId };
  if (q.format === 'json') { const p = paging(req); const r = await runReport(biz(req), req.auth!, type, f, p); return ok(res, { columns: r.columns, rows: r.rows, range: r.range }, 'OK', 200, meta(p, r.total)); }
  const r = await runReport(biz(req), req.auth!, type, f);
  await audit(undefined, { auth: req.auth, action: 'report.exported', entity: 'report', entityId: type, newValue: { format: q.format, rows: r.rows.length, range: r.range }, req });
  if (q.format === 'csv') { res.setHeader('content-type', 'text/csv; charset=utf-8'); res.setHeader('content-disposition', `attachment; filename="${type}.csv"`); return void res.send(toCsv(r.columns, r.rows)); }
  res.setHeader('content-type', q.format === 'excel' ? 'application/vnd.ms-excel' : 'text/html; charset=utf-8');
  if (q.format === 'excel') res.setHeader('content-disposition', `attachment; filename="${type}.xls"`);
  res.send(toHtmlTable(`${type.replace(/_/g, ' ')} report`, r.columns, r.rows));
}));
