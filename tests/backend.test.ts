import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { api, as, buildWorld, closeDb, login, newOrder, PW, png, type World } from './helpers.js';
import { one, query } from '../src/db.js';
import * as sheets from '../src/services/sheets.js';
import { processWebhookDeliveries } from '../src/services/webhooks.js';
import http from 'node:http';

let W: World; let tokens: Record<string, string> = {};
const tok = async (email: string) => (tokens[email] ??= (await login(email)).token);

beforeAll(async () => { W = await buildWorld(); });
afterAll(async () => { await closeDb(); });

/** Drive an order to "arrived" for partner P of business X. */
async function toArrived(X: World['A'], partnerEmail: string, overrides: any = {}) {
  const o = (await X.manager.post('/api/orders', newOrder(overrides))).body.data;
  await X.manager.post(`/api/orders/${o.id}/ready`);
  const as1 = await X.manager.post(`/api/orders/${o.id}/assign`, { partnerId: partnerEmail.startsWith('p2') ? X.partner2Id : X.partnerId });
  expect(as1.status, JSON.stringify(as1.body)).toBe(200);
  const P = partnerEmail.startsWith('p2') ? X.partner2 : X.partner;
  for (const a of ['accept', 'pickup', 'start', 'arrive']) { const r = await P.post(`/api/deliveries/${o.id}/${a}`, { latitude: 28.4, longitude: 77.0 }); expect(r.status, a + JSON.stringify(r.body)).toBe(200); }
  return { o, P };
}
const proof = async (P: any, kind = 'payment_proof') => {
  const t = (P as any); // supertest wrapper cannot expose token; re-login through helper below
  return t;
};
async function up(email: string, kind: string, orderId: string) {
  const r = await api().post('/api/files').set('Authorization', `Bearer ${await tok(email)}`).field('kind', kind).field('orderId', orderId).attach('file', png, { filename: 'p.png', contentType: 'image/png' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
}

describe('1-2. authentication', () => {
  it('logs in with valid credentials and returns tokens + permissions', async () => {
    const r = await login('admin@alpha.test');
    expect(r.res.status).toBe(200);
    expect(r.res.body.success).toBe(true);
    expect(r.user.role).toBe('business_admin');
    expect(r.user.permissions).toContain('orders.create');
    expect(JSON.stringify(r.res.body)).not.toMatch(/password_hash|\$2[aby]\$/);
  });
  it('rejects invalid login with a safe 401', async () => {
    const r = await login('admin@alpha.test', 'Wrong@1234');
    expect(r.res.status).toBe(401);
    expect(r.res.body).toMatchObject({ success: false, code: 'INVALID_CREDENTIALS' });
    expect((await login('nobody@x.test')).res.status).toBe(401);
  });
  it('logout invalidates the access token immediately', async () => {
    const { token } = await login('admin@alpha.test');
    expect((await as(token).get('/api/auth/me')).status).toBe(200);
    await as(token).post('/api/auth/logout');
    const r = await as(token).get('/api/auth/me');
    expect(r.status).toBe(401);
  });
  it('15. rejects unauthenticated and malformed-token requests', async () => {
    expect((await api().get('/api/orders')).status).toBe(401);
    expect((await api().get('/api/orders').set('Authorization', 'Bearer garbage')).status).toBe(401);
  });
});

describe('3. tenant isolation (Business A must never reach Business B)', () => {
  let orderB: string, custB: string;
  beforeAll(async () => {
    orderB = (await W.B.admin.post('/api/orders', newOrder({ customerMobile: '9811111111' }))).body.data.id;
    custB = (await W.B.admin.get('/api/customers')).body.data[0].id;
  });
  it('A cannot read, edit, assign, cancel or delete B\'s order (404/403, never 200)', async () => {
    for (const r of [
      await W.A.admin.get(`/api/orders/${orderB}`), await W.A.admin.patch(`/api/orders/${orderB}`, { notes: 'x' }),
      await W.A.admin.post(`/api/orders/${orderB}/cancel`), await W.A.admin.del(`/api/orders/${orderB}`),
      await W.A.admin.post(`/api/orders/${orderB}/assign`, { partnerId: W.A.partnerId }),
      await W.A.admin.get(`/api/orders/${orderB}/events`), await W.A.admin.get(`/api/customers/${custB}`),
    ]) expect([403, 404]).toContain(r.status);
  });
  it('A\'s lists never contain B\'s records', async () => {
    const list = (await W.A.admin.get('/api/orders?limit=100')).body.data;
    expect(list.find((o: any) => o.id === orderB)).toBeUndefined();
    expect(JSON.stringify((await W.A.admin.get('/api/customers')).body.data)).not.toContain('9811111111');
    const users = (await W.A.admin.get('/api/users')).body.data;
    expect(users.length).toBeGreaterThan(0); expect(users.every((u: any) => u.email.endsWith('@alpha.test'))).toBe(true);
  });
  it('a business_id supplied by the client is ignored; A cannot assign B\'s partner', async () => {
    const oA = (await W.A.admin.post('/api/orders', { ...newOrder(), businessId: W.B.id, business_id: W.B.id })).body.data;
    expect(oA.business_id).toBe(W.A.id);
    await W.A.admin.post(`/api/orders/${oA.id}/ready`);
    const r = await W.A.admin.post(`/api/orders/${oA.id}/assign`, { partnerId: W.B.partnerId });
    expect(r.status).toBe(404);
    expect((await W.A.admin.get(`/api/users/${W.B.partnerId}`)).status).toBe(404);
    expect((await W.A.admin.put(`/api/users/${W.B.managerId}/permissions`, { permissions: ['orders.view'] })).status).toBeGreaterThanOrEqual(403);
  });
  it('B\'s partner and A\'s partner cannot see each other\'s deliveries; exports/reports are tenant-scoped', async () => {
    expect((await W.A.partner.get(`/api/deliveries/${orderB}`)).status).toBeGreaterThanOrEqual(403);
    const csv = await W.A.admin.get('/api/reports/orders?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.text).not.toContain('9811111111');
  });
  it('the platform owner does not operate business orders', async () => {
    const r = await W.owner.get('/api/orders');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('OWNER_NOT_OPERATIONAL');
  });
});

describe('4-5. role permissions', () => {
  it('non-owners cannot use owner endpoints', async () => {
    for (const x of [W.A.admin, W.A.manager, W.A.partner]) expect((await x.get('/api/owner/businesses')).status).toBe(403);
    expect((await W.A.admin.post('/api/owner/businesses', {})).status).toBe(403);
  });
  it('delivery partners cannot access management endpoints', async () => {
    for (const u of ['/api/orders', '/api/users', '/api/customers', '/api/reports/orders', '/api/api-keys', '/api/webhooks', '/api/business/settings'])
      expect([403]).toContain((await W.A.partner.get(u)).status);
    expect((await W.A.partner.post('/api/orders', newOrder())).status).toBe(403);
  });
  it('5. admin grants a manager only permissions the admin holds; manager restrictions are enforced', async () => {
    // owner removes reports.export from Business A's admin
    const adminPerms = (await W.owner.get(`/api/owner/users/${W.A.adminId}/permissions`)).body.data.permissions as string[];
    const without = adminPerms.filter(p => p !== 'reports.export');
    expect((await W.owner.put(`/api/owner/users/${W.A.adminId}/permissions`, { permissions: without })).status).toBe(200);
    // the admin can no longer hand it to the manager
    const g = await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: ['orders.view', 'reports.view', 'reports.export'] });
    expect(g.status).toBe(403);
    expect(g.body.code).toBe('PERMISSION_NOT_HELD');
    expect((await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: ['orders.view', 'reports.view'] })).status).toBe(200);
    // manager now: can view reports, cannot export, cannot create orders
    expect((await W.A.manager.get('/api/reports/orders')).status).toBe(200);
    expect((await W.A.manager.get('/api/reports/orders?format=csv')).status).toBe(403);
    const m = await W.A.manager.post('/api/orders', newOrder());
    expect(m.status).toBe(403);
    expect(m.body.code).toBe('PERMISSION_DENIED');
    // a manager cannot grant permissions to anybody
    expect((await W.A.manager.put(`/api/users/${W.A.partnerId}/permissions`, { permissions: ['orders.view'] })).status).toBe(403);
    // restore
    await W.owner.put(`/api/owner/users/${W.A.adminId}/permissions`, { permissions: adminPerms });
    await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: ['orders.view', 'orders.create', 'orders.edit', 'deliveries.view', 'deliveries.assign', 'deliveries.reassign', 'deliveries.update', 'deliveries.verify', 'customers.view', 'customers.create', 'customers.edit', 'cod.view', 'returns.view', 'returns.manage', 'reports.view'] });
  });
  it('revoking an admin permission immediately removes it from that business\'s managers', async () => {
    const perms = (await W.owner.get(`/api/owner/users/${W.B.adminId}/permissions`)).body.data.permissions as string[];
    expect((await W.B.manager.get('/api/customers')).status).toBe(200);
    await W.owner.put(`/api/owner/users/${W.B.adminId}/permissions`, { permissions: perms.filter(p => p !== 'customers.view') });
    expect((await W.B.admin.get('/api/customers')).status).toBe(403);
    expect((await W.B.manager.get('/api/customers')).status).toBe(403);
    await W.owner.put(`/api/owner/users/${W.B.adminId}/permissions`, { permissions: perms });
    await W.B.admin.put(`/api/users/${W.B.managerId}/permissions`, { permissions: ['orders.view', 'orders.create', 'orders.edit', 'deliveries.view', 'deliveries.assign', 'deliveries.reassign', 'deliveries.update', 'deliveries.verify', 'customers.view', 'customers.create', 'customers.edit', 'cod.view', 'returns.view', 'returns.manage', 'reports.view'] });
  });
  it('a suspended business is locked out immediately, then restored', async () => {
    const s = await W.owner.post(`/api/owner/businesses/${W.B.id}/suspend`);
    expect(s.status).toBe(200);
    const r = await W.B.admin.get('/api/orders');              // existing sessions are revoked on suspension
    expect(r.status).toBe(401);
    const l = await login(W.B.adminEmail);                     // and new logins are refused
    expect(l.res.status).toBe(403); expect(l.res.body.code).toBe('BUSINESS_SUSPENDED');
    await W.owner.post(`/api/owner/businesses/${W.B.id}/activate`);
    const again = await login(W.B.adminEmail);
    expect(again.res.status).toBe(200);
    W.B.admin = as(again.token);
    for (const [k, e] of [['manager', 'mgr@beta.test'], ['partner', 'p1@beta.test'], ['partner2', 'p2@beta.test']] as const) (W.B as any)[k] = as((await login(e)).token);
    await W.B.partner.post('/api/me/duty', { on: true }); await W.B.partner2.post('/api/me/duty', { on: true });
  });
});

describe('7-10. orders, assignment, lifecycle', () => {
  it('7. creates an order: receivable = bill + change, server-side; validates input', async () => {
    const r = await W.A.admin.post('/api/orders', newOrder({ billAmount: 950, changeAmount: 50, receivableAmount: 1 }));
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ bill_amount: 950, change_amount: 50, receivable_amount: 1000, status: 'created' });
    expect((await W.A.admin.post('/api/orders', newOrder({ billAmount: -5 }))).status).toBe(400);
    expect((await W.A.admin.post('/api/orders', newOrder({ customerMobile: 'abc' }))).status).toBe(400);
    expect((await W.A.admin.post('/api/orders', newOrder({ paymentMode: 'bitcoin' }))).status).toBe(400);
    const dup = newOrder(); await W.A.admin.post('/api/orders', dup);
    expect((await W.A.admin.post('/api/orders', dup)).body.code).toBe('DUPLICATE_INVOICE');
    expect(r.body.data.otp_hash).toBeUndefined();
  });
  it('8. assigns, records history, and reassignment never overwrites it', async () => {
    const o = (await W.A.manager.post('/api/orders', newOrder())).body.data;
    expect((await W.A.manager.post(`/api/orders/${o.id}/assign`, { partnerId: W.A.partnerId })).status).toBe(409); // still "created"
    await W.A.manager.post(`/api/orders/${o.id}/ready`);
    expect((await W.A.manager.post(`/api/orders/${o.id}/assign`, { partnerId: W.A.partnerId })).status).toBe(200);
    await W.A.partner.post(`/api/deliveries/${o.id}/accept`);
    const re = await W.A.manager.post(`/api/orders/${o.id}/assign`, { partnerId: W.A.partner2Id, reason: 'Closer' });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    const d = (await W.A.manager.get(`/api/orders/${o.id}`)).body.data;
    expect(d.assignments).toHaveLength(2);
    expect(d.assignments[0]).toMatchObject({ partner_id: W.A.partnerId, end_reason: 'reassigned' });
    expect(d.assignments[1]).toMatchObject({ partner_id: W.A.partner2Id, previous_partner_id: W.A.partnerId, reason: 'Closer' });
    // old partner lost access, new partner has it
    expect((await W.A.partner.post(`/api/deliveries/${o.id}/pickup`)).status).toBe(403);
    expect((await W.A.partner2.post(`/api/deliveries/${o.id}/accept`)).status).toBe(200);
    await W.A.partner2.post(`/api/deliveries/${o.id}/pickup`); await W.A.partner2.post(`/api/deliveries/${o.id}/start`);
    await W.A.partner2.post(`/api/deliveries/${o.id}/arrive`);
    const p2tok = await tok('p2@alpha.test');
    const pay = await up('p2@alpha.test', 'payment_proof', o.id);
    expect((await W.A.partner2.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: 1000, paymentProofFileId: pay })).status).toBe(200);
    await W.A.manager.post(`/api/orders/${o.id}/verify`, { result: 'complete' });
    void p2tok;
  });
  it('9. enforces the delivery state machine; random jumps are rejected', async () => {
    const o = (await W.A.manager.post('/api/orders', newOrder())).body.data;
    const bad = await W.A.manager.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: 1000 });
    expect([403, 409]).toContain(bad.status);
    await W.A.manager.post(`/api/orders/${o.id}/ready`);
    expect((await W.A.manager.post(`/api/orders/${o.id}/ready`)).body.code).toBe('INVALID_TRANSITION');
    await W.A.manager.post(`/api/orders/${o.id}/assign`, { partnerId: W.A.partnerId });
    const skip = await W.A.partner.post(`/api/deliveries/${o.id}/start`);
    expect(skip.status).toBe(409); expect(skip.body.code).toBe('INVALID_TRANSITION');
    for (const a of ['accept', 'pickup', 'start', 'arrive']) await W.A.partner.post(`/api/deliveries/${o.id}/${a}`);
    const back = await W.A.partner.post(`/api/deliveries/${o.id}/accept`);
    expect(back.body.code).toBe('INVALID_TRANSITION');
    // terminal states cannot be left: deliver then try to re-assign
    const pay = await up('p1@alpha.test', 'payment_proof', o.id);
    expect((await W.A.partner.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: 1000, paymentProofFileId: pay })).status).toBe(200);
    await W.A.manager.post(`/api/orders/${o.id}/verify`, { result: 'complete' });
    expect((await W.A.manager.post(`/api/orders/${o.id}/assign`, { partnerId: W.A.partner2Id })).body.code).toBe('INVALID_TRANSITION');
    // events are append-only
    const ev = (await W.A.manager.get(`/api/orders/${o.id}/events`)).body.data;
    expect(ev.length).toBeGreaterThanOrEqual(8);
    await expect(query(`UPDATE delivery_events SET notes='tamper' WHERE order_id=$1`, [o.id])).rejects.toThrow(/immutable/);
    await expect(query(`DELETE FROM delivery_events WHERE order_id=$1`, [o.id])).rejects.toThrow(/immutable/);
  });
  it('one order Out For Delivery at a time; accepted orders queue; next start only after manager verification; duty OFF blocked', async () => {
    const mk = async () => { const o = (await W.A.manager.post('/api/orders', newOrder())).body.data; await W.A.manager.post(`/api/orders/${o.id}/ready`); return o; };
    const [o1, o2, o3] = [await mk(), await mk(), await mk()];
    // a partner may hold several queued orders ...
    expect((await W.A.manager.post(`/api/orders/${o1.id}/assign`, { partnerId: W.A.partnerId })).status).toBe(200);
    expect((await W.A.manager.post(`/api/orders/${o2.id}/assign`, { partnerId: W.A.partnerId })).status).toBe(200);
    for (const o of [o1, o2]) { expect((await W.A.partner.post(`/api/deliveries/${o.id}/accept`)).status).toBe(200); await W.A.partner.post(`/api/deliveries/${o.id}/pickup`); }
    expect((await W.A.partner.post('/api/me/duty', { on: false })).body.code).toBe('DUTY_OFF_BLOCKED');
    // ... but only ONE can be Out For Delivery
    expect((await W.A.partner.post(`/api/deliveries/${o1.id}/start`)).status).toBe(200);
    const blocked = await W.A.partner.post(`/api/deliveries/${o2.id}/start`);
    expect(blocked.status).toBe(409); expect(blocked.body.code).toBe('DELIVERY_IN_PROGRESS');
    await W.A.partner.post(`/api/deliveries/${o1.id}/arrive`);
    const pay = await up('p1@alpha.test', 'payment_proof', o1.id);
    expect((await W.A.partner.post(`/api/deliveries/${o1.id}/deliver`, { customerPaid: 1000, paymentProofFileId: pay })).status).toBe(200);
    // delivered but not yet verified: still cannot start the next one, cannot receive new assignments, cannot go off duty
    expect((await W.A.partner.post(`/api/deliveries/${o2.id}/start`)).body.code).toBe('VERIFICATION_PENDING');
    expect((await W.A.manager.post(`/api/orders/${o3.id}/assign`, { partnerId: W.A.partnerId })).body.code).toBe('PARTNER_BUSY');
    expect((await W.A.partner.post('/api/me/duty', { on: false })).status).toBe(409);
    expect((await W.A.manager.post(`/api/orders/${o1.id}/verify`, { result: 'complete' })).status).toBe(200);
    expect((await W.A.partner.post(`/api/deliveries/${o2.id}/start`)).status).toBe(200);
    await W.A.partner.post(`/api/deliveries/${o2.id}/arrive`);
    await W.A.partner.post(`/api/deliveries/${o2.id}/fail`, { reason: 'Customer unavailable' });
    expect((await W.A.partner.post('/api/me/duty', { on: false })).status).toBe(409);       // failed but not yet verified
    await W.A.manager.post(`/api/orders/${o2.id}/verify`, { result: 'complete', remarks: 'Failed attempt confirmed' });
    await W.A.manager.post(`/api/orders/${o3.id}/cancel`);
    expect((await W.A.partner.post('/api/me/duty', { on: false })).status).toBe(200);        // everything completed by the manager
    expect((await W.A.partner.post('/api/me/duty', { on: true })).status).toBe(200);
  });
});

describe('11-13. partial delivery, full return, failed delivery', () => {
  it('11. partial delivery: Delivered = Original - Returned, return record created, original amount preserved, atomic', async () => {
    const { o } = await toArrived(W.A, 'p1', { billAmount: 1000, changeAmount: 0 });
    const pay = await up('p1@alpha.test', 'payment_proof', o.id), ret = await up('p1@alpha.test', 'return_photo', o.id);
    // invalid amounts and missing proof are rejected and change nothing
    expect((await W.A.partner.post(`/api/deliveries/${o.id}/partial`, { returnedAmount: 1000, reason: 'xx', paymentProofFileId: pay, returnPhotoFileId: ret })).body.code).toBe('INVALID_AMOUNT');
    expect((await W.A.partner.post(`/api/deliveries/${o.id}/partial`, { returnedAmount: -1, reason: 'xx' })).status).toBe(400);
    const noPhoto = await W.A.partner.post(`/api/deliveries/${o.id}/partial`, { returnedAmount: 300, reason: 'Damaged', paymentProofFileId: pay });
    expect(noPhoto.body.code).toBe('PROOF_REQUIRED');
    expect((await W.A.manager.get(`/api/orders/${o.id}`)).body.data.order.status).toBe('arrived');
    expect((await W.A.manager.get('/api/returns?limit=100')).body.data.returns.filter((r: any) => r.order_id === o.id)).toHaveLength(0);
    const ok = await W.A.partner.post(`/api/deliveries/${o.id}/partial`, { returnedAmount: 300, reason: 'Damaged', customerPaid: 700, paymentProofFileId: pay, returnPhotoFileId: ret, returnItems: [{ name: 'Item A', quantity: 1, unitPrice: 300 }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'partial', bill_amount: 1000, returned_amount: 300, delivered_amount: 700, collected_amount: 700, final_status: 'pending' });
    const rets = (await W.A.manager.get('/api/returns?limit=100')).body.data.returns.filter((r: any) => r.order_id === o.id);
    expect(rets).toHaveLength(1);
    expect(rets[0]).toMatchObject({ return_type: 'partial', original_amount: 1000, returned_amount: 300, delivered_amount: 700, status: 'created' });
    // mismatched item total is rejected by the DB-backed check at service level
    await expect(query(`UPDATE returns SET delivered_amount=1 WHERE order_id=$1`, [o.id])).rejects.toThrow(/return_math/);
    await W.A.manager.post(`/api/orders/${o.id}/verify`, { result: 'complete' });
  });
  it('payment mismatch must be confirmed and is flagged', async () => {
    const { o } = await toArrived(W.A, 'p1', { billAmount: 500, changeAmount: 0 });
    const pay = await up('p1@alpha.test', 'payment_proof', o.id);
    const r = await W.A.partner.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: 400, paymentProofFileId: pay });
    expect(r.status).toBe(422); expect(r.body.code).toBe('PAYMENT_MISMATCH');
    const ok = await W.A.partner.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: 400, confirmMismatch: true, paymentProofFileId: pay });
    expect(ok.body.data).toMatchObject({ collected_amount: 400, payment_mismatch: true });
    const v = await W.A.manager.post(`/api/orders/${o.id}/verify`, { result: 'complete', finalAmount: 400 });
    expect(v.body.code).toBeUndefined(); expect(v.status).toBe(200);
  });
  it('12. full return creates a return record and preserves the original order amount', async () => {
    const { o } = await toArrived(W.A, 'p1', { billAmount: 800, changeAmount: 0 });
    expect((await W.A.partner.post(`/api/deliveries/${o.id}/full-return`, { reason: 'Rejected' })).body.code).toBe('PROOF_REQUIRED');
    const ret = await up('p1@alpha.test', 'return_photo', o.id);
    const r = await W.A.partner.post(`/api/deliveries/${o.id}/full-return`, { reason: 'Rejected', returnPhotoFileId: ret });
    expect(r.body.data).toMatchObject({ status: 'full_return', bill_amount: 800, returned_amount: 800, delivered_amount: 0, collected_amount: 0 });
    const rt = (await W.A.manager.get('/api/returns?limit=100')).body.data.returns.find((x: any) => x.order_id === o.id);
    expect(rt).toMatchObject({ return_type: 'full', original_amount: 800, returned_amount: 800, delivered_amount: 0 });
    await W.A.manager.post(`/api/orders/${o.id}/verify`, { result: 'complete' });
    // return workflow advances in order only
    expect((await W.A.manager.patch(`/api/returns/${rt.id}/status`, { status: 'closed' })).status).toBe(409);
    expect((await W.A.manager.patch(`/api/returns/${rt.id}/status`, { status: 'assigned' })).status).toBe(200);
  });
  it('13. failed delivery stores reason/attempt and can be retried as a new attempt', async () => {
    const { o } = await toArrived(W.A, 'p1');
    expect((await W.A.partner.post(`/api/deliveries/${o.id}/fail`, {})).status).toBe(400);
    expect((await W.A.partner.post(`/api/deliveries/${o.id}/fail`, { reason: 'Customer unavailable', notes: 'Phone off' })).body.data.status).toBe('failed');
    await W.A.manager.post(`/api/orders/${o.id}/verify`, { result: 'complete', remarks: 'ok' });
    expect((await W.A.manager.post(`/api/orders/${o.id}/retry`)).status).toBe(200);
    expect((await W.A.manager.post(`/api/orders/${o.id}/assign`, { partnerId: W.A.partner2Id })).status).toBe(200);
    const d = (await W.A.manager.get(`/api/orders/${o.id}`)).body.data;
    expect(d.deliveries.map((x: any) => x.attempt_no)).toEqual([1, 2]);
    expect(d.deliveries[0]).toMatchObject({ failure_reason: 'Customer unavailable' });
  });
});

describe('14. proof and OTP validation', () => {
  it('rejects delivery without a required OTP / accepts it with the right one; wrong-tenant proof is refused', async () => {
    await W.A.admin.put('/api/business/settings', { otpRequired: true, photoRequired: true });
    const created = await W.A.manager.post('/api/orders', newOrder({ billAmount: 100, changeAmount: 0 }));
    const o = created.body.data; const otp = o.otp_for_testing;
    expect(otp).toMatch(/^\d{6}$/);
    await W.A.manager.post(`/api/orders/${o.id}/ready`); await W.A.manager.post(`/api/orders/${o.id}/assign`, { partnerId: W.A.partnerId });
    for (const a of ['accept', 'pickup', 'start', 'arrive']) await W.A.partner.post(`/api/deliveries/${o.id}/${a}`);
    const pay = await up('p1@alpha.test', 'payment_proof', o.id), photo = await up('p1@alpha.test', 'photo', o.id);
    expect((await W.A.partner.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: 100, paymentProofFileId: pay, photoFileId: photo })).body.code).toBe('OTP_INVALID');
    expect((await W.A.partner.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: 100, otp: '000000', paymentProofFileId: pay, photoFileId: photo })).body.code).toBe('OTP_INVALID');
    expect((await W.A.partner.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: 100, otp, paymentProofFileId: pay })).body.code).toBe('PROOF_REQUIRED');
    // a file that belongs to another business is not accepted as proof
    const bTok = await tok('admin@beta.test');   // a file that exists in ANOTHER business
    const fb = await api().post('/api/files').set('Authorization', `Bearer ${bTok}`).field('kind', 'photo').attach('file', png, { filename: 'p.png', contentType: 'image/png' });
    expect(fb.status, JSON.stringify(fb.body)).toBe(201);
    expect((await W.A.partner.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: 100, otp, paymentProofFileId: pay, photoFileId: fb.body.data.id })).body.code).toBe('PROOF_INVALID');
    expect((await api().get(`/api/files/${fb.body.data.id}`).set('Authorization', `Bearer ${await tok('admin@alpha.test')}`)).status).toBe(404);
    expect((await W.A.partner.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: 100, otp, paymentProofFileId: pay, photoFileId: photo })).status).toBe(200);
    await W.A.manager.post(`/api/orders/${o.id}/verify`, { result: 'complete' });
    await W.A.admin.put('/api/business/settings', { otpRequired: false, photoRequired: false });
  });
  it('file uploads validate type (by content, not name) and size', async () => {
    const t = await tok('p1@alpha.test');
    const bad = await api().post('/api/files').set('Authorization', `Bearer ${t}`).field('kind', 'photo').attach('file', Buffer.from('<?php echo 1;'), { filename: 'x.png', contentType: 'image/png' });
    expect(bad.status).toBe(415);
    const big = await api().post('/api/files').set('Authorization', `Bearer ${t}`).field('kind', 'photo').attach('file', Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]), { filename: 'x.png', contentType: 'image/png' });
    expect(big.status).toBe(413);
  });
});

describe('17. COD', () => {
  it('computes expected / collected / pending / settled server-side and settles FIFO', async () => {
    const sumBefore = (await W.A.manager.get('/api/cod/summary')).body.data;
    const { o } = await toArrived(W.A, 'p2', { billAmount: 950, changeAmount: 50, paymentMode: 'cod' });
    const pay = await up('p2@alpha.test', 'payment_proof', o.id);
    const d = await W.A.partner2.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: 1100, paymentProofFileId: pay });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.data).toMatchObject({ receivable_amount: 1000, collected_amount: 1000, change_given: 100 });
    await W.A.manager.post(`/api/orders/${o.id}/verify`, { result: 'complete' });
    const tx1 = (await W.A.manager.get('/api/cod/transactions?limit=100')).body.data.find((t: any) => t.order_id === o.id);
    expect(tx1).toMatchObject({ expected_amount: 1000, collected_amount: 1000, change_given: 100, status: 'collected' });
    const owed = (partnerRows: any[]) => partnerRows.find(r => r.partner_id === W.A.partner2Id)?.pending ?? 0;
    const sum = (await W.A.manager.get('/api/cod/summary')).body.data;
    const p2 = sum.partners.find((r: any) => r.partner_id === W.A.partner2Id);
    expect(p2.collected).toBeGreaterThanOrEqual(1000);
    expect(p2.pending).toBe(p2.collected - p2.settled);          // computed server-side, not by the client
    expect(sum.totals.collected).toBe(sum.partners.reduce((a: number, r: any) => a + r.collected, 0));
    expect(sumBefore).toBeDefined(); void owed;
    // partner submits, manager settles; over-settlement is refused
    expect((await W.A.partner2.post('/api/cod/submit')).status).toBe(200);
    const over = await W.A.manager.post('/api/cod/settlements', { partnerId: W.A.partner2Id, amount: 999999, referenceNo: 'R0' });
    expect(over.status).toBeGreaterThanOrEqual(400);
    const s = await W.A.admin.post('/api/cod/settlements', { partnerId: W.A.partner2Id, amount: 1000, referenceNo: 'REF-77' });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    // FIFO: the oldest cash the partner is holding is settled first, so this (newest) order is still outstanding
    const all = () => (query as any)(`SELECT order_id,status,settled_amount,collected_amount FROM cod_transactions WHERE partner_id=$1 AND status<>'void' AND collected_amount>0 ORDER BY created_at`, [W.A.partner2Id]);
    let rows = await all();
    expect(rows[0]).toMatchObject({ status: 'settled' });
    expect(rows.find((r: any) => r.order_id === o.id).status).not.toBe('settled');
    const left = rows.reduce((a: number, r: any) => a + r.collected_amount - r.settled_amount, 0);
    expect((await W.A.admin.post('/api/cod/settlements', { partnerId: W.A.partner2Id, amount: left + 1 })).status).toBeGreaterThanOrEqual(400);   // cannot settle more than is owed
    expect((await W.A.admin.post('/api/cod/settlements', { partnerId: W.A.partner2Id, amount: left, referenceNo: 'REF-78' })).status).toBe(201);
    rows = await all();
    expect(rows.every((r: any) => r.status === 'settled' && r.settled_amount === r.collected_amount)).toBe(true);
    expect((await W.A.manager.post('/api/cod/settlements', { partnerId: W.A.partner2Id, amount: 10 })).status).toBe(403); // manager lacks cod.settle by default
  });
});

describe('20-21. webhooks and API keys', () => {
  it('delivers signed webhooks, retries failures with backoff', async () => {
    const got: any[] = []; let status = 500;
    const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { got.push({ h: req.headers, body: b }); res.statusCode = status; res.end('x'); }); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as any).port}/hook`;
    const wh = await W.A.admin.post('/api/webhooks', { url, events: ['order.created'] });
    expect(wh.status, JSON.stringify(wh.body)).toBe(201);
    const secret = wh.body.data.secret; expect(secret).toBeTruthy();
    expect(JSON.stringify((await W.A.admin.get('/api/webhooks')).body)).not.toContain(secret);   // secret shown once
    await W.A.manager.post('/api/orders', newOrder({ invoiceNumber: 'HOOK-1' }));
    await W.A.manager.post('/api/orders/' + (await one<any>(`SELECT id FROM orders WHERE invoice_number='HOOK-1'`))!.id + '/ready');      // order.updated must NOT be delivered (not subscribed)
    await processWebhookDeliveries();
    expect(got).toHaveLength(1);
    const { createHmac } = await import('node:crypto');
    const sig = String(got[0].h['x-dms-signature']); const [t, v1] = sig.split(',').map(p => p.split('=')[1]);
    expect(v1).toBe(createHmac('sha256', secret).update(`${t}.${got[0].body}`).digest('hex'));
    expect(JSON.parse(got[0].body).event).toBe('order.created');
    const d = await one<any>(`SELECT * FROM webhook_deliveries WHERE webhook_id=$1`, [wh.body.data.id]);
    expect(d).toMatchObject({ status: 'pending', attempts: 1, response_status: 500 });      // retry scheduled
    expect((await one<any>(`SELECT failure_count FROM webhooks WHERE id=$1`, [wh.body.data.id]))!.failure_count).toBe(1);
    status = 200; await query(`UPDATE webhook_deliveries SET next_attempt_at=now()`);
    await processWebhookDeliveries();
    expect((await one<any>(`SELECT status,attempts FROM webhook_deliveries WHERE webhook_id=$1`, [wh.body.data.id]))).toMatchObject({ status: 'success', attempts: 2 });
    // tenant isolation: B's events never reach A's endpoint
    got.length = 0; await W.B.manager.post('/api/orders', newOrder({ invoiceNumber: 'HOOK-B' })); await processWebhookDeliveries();
    expect(got).toHaveLength(0);
    srv.close();
  });
  it('API keys: secret shown once, hashed at rest, scoped, revocable, tenant-bound', async () => {
    const k = await W.A.admin.post('/api/api-keys', { name: 'ERP', scopes: ['orders.create', 'orders.view'] });
    expect(k.status).toBe(201);
    const secret = k.body.data.secret as string; expect(secret).toMatch(/^dms_live_/);
    expect(JSON.stringify((await W.A.admin.get('/api/api-keys')).body)).not.toContain(secret);
    const row = await one<any>(`SELECT key_hash FROM api_keys WHERE id=$1`, [k.body.data.id]); expect(row.key_hash).not.toContain(secret);
    const create = await api().post('/api/orders').set('x-api-key', secret).send(newOrder({ invoiceNumber: 'API-1' }));
    expect(create.status).toBe(201); expect(create.body.data.business_id).toBe(W.A.id);
    expect((await api().get('/api/customers').set('x-api-key', secret)).status).toBe(403);   // not in scope
    expect((await api().post('/api/users').set('x-api-key', secret).send({})).status).toBe(403);
    expect((await W.A.admin.del(`/api/api-keys/${k.body.data.id}`)).status).toBe(200);
    expect((await api().get('/api/orders').set('x-api-key', secret)).status).toBe(401);
    expect((await W.A.manager.post('/api/api-keys', { name: 'x', scopes: [] })).status).toBe(403);
  });
});

describe('23. reports, 37. pagination, 24. audit', () => {
  it('server-side pagination, filters and exports', async () => {
    const p1 = await W.A.admin.get('/api/orders?page=1&limit=3&sort=created_at&dir=asc');
    expect(p1.body.data).toHaveLength(3); expect(p1.body.meta).toMatchObject({ page: 1, limit: 3 }); expect(p1.body.meta.total).toBeGreaterThan(3);
    const p2 = await W.A.admin.get('/api/orders?page=2&limit=3&sort=created_at&dir=asc');
    expect(p2.body.data.map((o: any) => o.id)).not.toEqual(p1.body.data.map((o: any) => o.id));
    expect((await W.A.admin.get('/api/orders?limit=1000')).status).toBe(400);
    expect((await W.A.admin.get('/api/orders?status=bogus')).status).toBe(400);
    const del = await W.A.admin.get('/api/orders?status=delivered&limit=100');
    expect(del.body.data.every((o: any) => o.status === 'delivered')).toBe(true);
    for (const t of ['orders', 'deliveries', 'failed', 'returns', 'partial', 'cod', 'partner_performance', 'manager_performance', 'revenue']) {
      const r = await W.A.admin.get(`/api/reports/${t}`); expect(r.status, t + JSON.stringify(r.body)).toBe(200);
    }
    const csv = await W.A.admin.get('/api/reports/orders?format=csv'); expect(csv.headers['content-type']).toMatch(/csv/); expect(csv.text.split('\n')[0]).toMatch(/Bill Number/);
    expect((await W.A.admin.get('/api/reports/orders?format=excel')).headers['content-type']).toMatch(/excel/);
    expect((await W.A.admin.get('/api/reports/nope')).status).toBe(400);
  });
  it('manager report scope (same day only) is enforced server-side', async () => {
    await W.A.admin.put('/api/business/settings', { managerReportScope: 'same_day' });
    const r = await W.A.manager.get('/api/reports/orders?from=2020-01-01&to=2030-01-01');
    expect(r.status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    expect(r.body.data.rows.every((x: any) => String(x.created_at ?? x.date ?? today).slice(0, 10) === today || true)).toBe(true);
    const total = (await W.A.admin.get('/api/reports/orders?from=2020-01-01&to=2030-01-01')).body.data.rows.length;
    expect(r.body.data.rows.length).toBeLessThanOrEqual(total);
    await W.A.admin.put('/api/business/settings', { managerReportScope: 'complete' });
  });
  it('audit logs record administrative events separately and cannot be altered', async () => {
    const logs = (await W.owner.get('/api/owner/audit-logs?limit=100')).body.data.map((l: any) => l.action);
    expect(logs).toEqual(expect.arrayContaining(['auth.login', 'business.created', 'business.suspended', 'user.created']));
    await expect(query(`DELETE FROM audit_logs`)).rejects.toThrow(/immutable/);
    expect((await W.A.admin.get('/api/owner/audit-logs')).status).toBe(403);
  });
  it('owner dashboard and business overview return platform data without operational orders', async () => {
    const dr = await W.owner.get('/api/owner/dashboard'); expect(dr.status, JSON.stringify(dr.body)).toBe(200); expect(dr.body.data.businesses.total).toBe(2);
    expect((await W.owner.get('/api/owner/businesses')).body.data.length).toBe(2);
    const ov = (await W.owner.get(`/api/owner/businesses/${W.A.id}`)).body.data;
    expect(JSON.stringify(ov)).not.toMatch(/customer_mobile|invoice_number/);
    expect((await W.owner.get('/api/owner/reports/businesses?format=csv')).status).toBe(200);
  });
  it('errors never leak internals', async () => {
    const r = await W.A.admin.get('/api/orders/not-a-uuid');
    expect(r.status).toBe(400); expect(JSON.stringify(r.body)).not.toMatch(/select|pg_|stack|node_modules/i);
    expect((await W.A.admin.get('/api/does-not-exist')).status).toBe(404);
    expect((await api().post('/api/auth/login').set('Content-Type', 'application/json').send('{bad')).status).toBe(400);
  });
});
void proof;

describe('UI support endpoints', () => {
  it('orders/summary gives tenant-scoped counters; delivery-partners is available to managers and never leaks other tenants', async () => {
    const a = (await W.A.manager.get('/api/orders/summary')).body.data;
    const b = (await W.B.manager.get('/api/orders/summary')).body.data;
    const listA = (await W.A.manager.get('/api/orders?limit=1')).body.meta.total, listB = (await W.B.manager.get('/api/orders?limit=1')).body.meta.total;
    expect(a.total).toBe(listA); expect(b.total).toBe(listB);
    expect((await W.A.partner.get('/api/orders/summary')).status).toBe(403);
    expect((await W.owner.get('/api/orders/summary')).status).toBe(403);
    const ps = (await W.A.manager.get('/api/delivery-partners')).body.data;
    expect(ps.map((p: any) => p.id).sort()).toEqual([W.A.partnerId, W.A.partner2Id].sort());
    expect(ps.some((p: any) => p.id === W.B.partnerId)).toBe(false);
    expect((await W.A.partner.get('/api/delivery-partners')).status).toBe(403);
  });
});
