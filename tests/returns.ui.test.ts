import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { one } from '../src/db.js';
import { api, as, buildWorld, closeDb, login, newOrder, png, type World } from './helpers.js';
import { openApp, until, sleep } from './uiHelper.js';

let W: World, base = '', server: any;
beforeAll(async () => {
  W = await buildWorld(); server = createApp().listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server?.close(); await closeDb(); });

/** Drives one order to a verified partial / full return entirely through the API. */
async function makeReturn(X: World['A'], email: string, inv: string, kind: 'partial' | 'full_return') {
  const o = (await X.manager.post('/api/orders', newOrder({ invoiceNumber: inv, billAmount: 1000, changeAmount: 0 }))).body.data;
  await X.manager.post(`/api/orders/${o.id}/ready`); await X.manager.post(`/api/orders/${o.id}/assign`, { partnerId: email.startsWith('p2') ? X.partner2Id : X.partnerId });
  const P = email.startsWith("p2") ? X.partner2 : X.partner; const tok = (await login(email)).token;
  const up = async (k: string) => (await api().post('/api/files').set('Authorization', `Bearer ${tok}`).field('kind', k).field('orderId', o.id).attach('file', png, { filename: 'p.png', contentType: 'image/png' })).body.data.id;
  for (const a of ['accept', 'pickup', 'start', 'arrive']) await P.post(`/api/deliveries/${o.id}/${a}`, {});
  const r = kind === 'partial' ? await P.post(`/api/deliveries/${o.id}/partial`, { returnedAmount: 300, reason: 'Damaged', customerPaid: 700, paymentProofFileId: await up('payment_proof'), returnPhotoFileId: await up('return_photo') })
    : await P.post(`/api/deliveries/${o.id}/full_return`, { reason: 'Customer rejected', returnPhotoFileId: await up('return_photo') });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await X.manager.post(`/api/orders/${o.id}/verify`, { result: 'complete' });
  return o.id as string;
}

describe('Returns module (UI <-> backend)', () => {
  beforeAll(async () => {
    await makeReturn(W.A, 'p1@alpha.test', 'RT-A1', 'partial'); await makeReturn(W.A, 'p2@alpha.test', 'RT-A2', 'full_return'); await makeReturn(W.A, 'p1@alpha.test', 'RT-A3', 'partial');
    await makeReturn(W.B, 'p1@beta.test', 'RT-B1', 'full_return');
  });
  it('shows real totals and rows for the signed-in business only; filters and paging go to the server', async () => {
    const ui = await openApp(base); await ui.signIn('admin@alpha.test'); ui.go('returns');
    await until(() => ui.$('#axrl table') && ui.$('#axrk .kpi'), 'returns table');
    const t = ui.view(); expect(t).toContain('RT-A1'); expect(t).toContain('RT-A2'); expect(t).not.toContain('RT-B1');
    const kp = [...ui.d.querySelectorAll('#axrk .kpi')].map((k: any) => k.textContent.replace(/\s+/g, ' ').trim());
    expect(kp[0]).toMatch(/Total returns\s*3/); expect(kp[1]).toMatch(/₹1,600/); expect(kp[2]).toMatch(/Full returns\s*1/); expect(kp[3]).toMatch(/Partial returns\s*2/);   // 300 + 1000 + 300
    ui.select(ui.$('#axrt'), 'full'); await until(() => /RT-A2/.test(ui.$('#axrl').textContent) && !/RT-A1/.test(ui.$('#axrl').textContent), 'full filter');
    ui.select(ui.$('#axrt'), ''); await until(() => /RT-A1/.test(ui.$('#axrl').textContent), 'cleared');
    ui.select(ui.$('#axrs'), 'closed'); await until(() => /No returns match/.test(ui.$('#axrl').textContent), 'status filter');
    ui.close();
  });
  it('advances a return one step at a time through the UI; the server rejects skipped steps', async () => {
    const ui = await openApp(base); await ui.signIn('mgr@alpha.test'); ui.go('returns'); await until(() => ui.$('#axrl table'), 'table');
    const row = () => [...ui.d.querySelectorAll('#axrl tr')].find((r: any) => r.textContent.includes('RT-A1')) as any;
    ui.click(row().querySelector('[data-x2="radv"]')); await until(() => /Return assigned/.test(row().textContent), 'assigned');
    expect(await one<any>(`SELECT r.status FROM returns r JOIN orders o ON o.id=r.order_id WHERE o.invoice_number='RT-A1'`)).toMatchObject({ status: 'assigned' });
    const rid = (await one<any>(`SELECT r.id FROM returns r JOIN orders o ON o.id=r.order_id WHERE o.invoice_number='RT-A1'`)).id;
    await expect(ui.w.__dms.api(`/returns/${rid}/status`, { method: 'PATCH', body: { status: 'closed' } })).rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
    for (const n of ['picked_up', 'received', 'verified', 'closed']) { ui.click(row().querySelector('[data-x2="radv"]')); await until(() => new RegExp(n === 'closed' ? 'Return closed' : 'Return ' + n.replace('_', ' ')).test(row().textContent), n); }
    expect(row().querySelector('[data-x2="radv"]')).toBeNull();                                  // closed: nothing further to do
    ui.close();
  });
  it('permissions: read-only managers cannot advance; managers without returns.view cannot open it; B cannot touch A\'s returns', async () => {
    await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: ['orders.view', 'returns.view'] });
    const ro = await openApp(base); await ro.signIn('mgr@alpha.test'); ro.go('returns'); await until(() => ro.$('#axrl table'), 'table');
    expect(ro.$('[data-x2="radv"]')).toBeNull();
    const rid = (await one<any>(`SELECT r.id FROM returns r JOIN orders o ON o.id=r.order_id WHERE o.invoice_number='RT-A2'`)).id;
    await expect(ro.w.__dms.api(`/returns/${rid}/status`, { method: 'PATCH', body: { status: 'assigned' } })).rejects.toMatchObject({ status: 403 });
    await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: ['orders.view'] });
    const none = await openApp(base); await none.signIn('mgr@alpha.test'); expect(none.nav()).not.toContain('Returns'); none.go('returns'); expect(none.view()).toMatch(/Unauthorized/);
    expect((await W.A.manager.get('/api/returns')).status).toBe(403);
    expect((await W.B.admin.patch(`/api/returns/${rid}/status`, { status: 'assigned' })).status).toBe(404);
    expect((await one<any>(`SELECT status FROM returns WHERE id=$1`, [rid])).status).toBe('created');
    expect((await W.A.partner.get('/api/returns')).status).toBe(403);
    ro.close(); none.close();
  });
  it('failures are shown with Retry instead of an empty or stale screen', async () => {
    const ui = await openApp(base); await ui.signIn('admin@alpha.test'); const f = ui.w.fetch; let down = true;
    ui.w.fetch = (u: string, o: any) => down ? Promise.reject(new TypeError('offline')) : f(u, o);
    ui.go('returns'); await until(() => /Cannot reach the server/.test(ui.$('#axrl').textContent), 'error'); down = false;
    ui.click('[data-x2="retry-returns"]'); await until(() => ui.$('#axrl table'), 'recovered'); await sleep(10); ui.close();
  });
});
