import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { one, query } from '../src/db.js';
import { api, as, buildWorld, closeDb, login, newOrder, png, type World } from './helpers.js';
import { openApp, until, sleep } from './uiHelper.js';

let W: World, base = '', server: any;
beforeAll(async () => {
  W = await buildWorld(); server = createApp().listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server?.close(); await closeDb(); });

/** One COD order delivered by a partner and verified by the manager, entirely through the API. */
async function codOrder(X: World['A'], who: 'p1' | 'p2', inv: string, bill: number, change: number, paid: number) {
  const P = who === 'p1' ? X.partner : X.partner2, email = `${who}@${X === W.A ? 'alpha' : 'beta'}.test`, tok = (await login(email)).token;
  const o = (await X.manager.post('/api/orders', newOrder({ invoiceNumber: inv, billAmount: bill, changeAmount: change, paymentMode: 'cod' }))).body.data;
  await X.manager.post(`/api/orders/${o.id}/ready`);
  expect((await X.manager.post(`/api/orders/${o.id}/assign`, { partnerId: who === 'p1' ? X.partnerId : X.partner2Id })).status).toBe(200);
  for (const a of ['accept', 'pickup', 'start', 'arrive']) await P.post(`/api/deliveries/${o.id}/${a}`, {});
  const pay = (await api().post('/api/files').set('Authorization', `Bearer ${tok}`).field('kind', 'payment_proof').field('orderId', o.id).attach('file', png, { filename: 'p.png', contentType: 'image/png' })).body.data.id;
  const r = await P.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: paid, paymentProofFileId: pay }); expect(r.status, JSON.stringify(r.body)).toBe(200);
  await X.manager.post(`/api/orders/${o.id}/verify`, { result: 'complete' });
  return o.id as string;
}

describe('COD module (UI <-> backend)', () => {
  beforeAll(async () => {
    await codOrder(W.A, 'p1', 'COD-A1', 950, 50, 1000);     // collected 1000
    await codOrder(W.A, 'p1', 'COD-A2', 500, 0, 600);       // collected 500, change 100
    await codOrder(W.A, 'p2', 'COD-A3', 300, 0, 300);       // collected 300
    await codOrder(W.B, 'p1', 'COD-B1', 700, 0, 700);       // other tenant: 700
  });

  it('shows the real cash position for the signed-in business only', async () => {
    const ui = await openApp(base); await ui.signIn('admin@alpha.test'); expect(ui.nav()).toContain('COD'); ui.go('cod');
    await until(() => ui.$('#axck .kpi') && ui.$('#axcl table'), 'cod page');
    const k = [...ui.d.querySelectorAll('#axck .kpi')].map((x: any) => x.textContent.replace(/\s+/g, ' ').trim());
    expect(k[0]).toMatch(/Expected/); expect(k[1]).toMatch(/Collected.*₹1,800/); expect(k[2]).toMatch(/Change given.*₹100/); expect(k[3]).toMatch(/Pending with partners.*₹1,800/);
    const t = ui.view(); expect(t).toContain('COD-A1'); expect(t).toContain('COD-A3'); expect(t).not.toContain('COD-B1');
    expect(ui.$('#axcp').textContent).toMatch(/P1.*₹1,500/); expect(ui.$('#axcp').textContent).toMatch(/P2.*₹300/);
    const sm = (await W.A.admin.get('/api/cod/summary')).body.data; expect(sm.totals.collected).toBe(1800);      // same numbers the server computes
    ui.select(ui.$('#axcpf'), W.A.partner2Id); await until(() => /COD-A3/.test(ui.$('#axcl').textContent) && !/COD-A1/.test(ui.$('#axcl').textContent), 'partner filter');
    ui.select(ui.$('#axcpf'), ''); ui.select(ui.$('#axcst'), 'settled'); await until(() => /No COD transactions/.test(ui.$('#axcl').textContent), 'status filter');
    ui.close();
  });
  it('settlement: over-settling is refused with a message; a valid one is recorded FIFO and the screen updates', async () => {
    const ui = await openApp(base); await ui.signIn('admin@alpha.test'); ui.go('cod'); await until(() => ui.$('[data-x2="settle"]'), 'settle button');
    const btn = [...ui.d.querySelectorAll('[data-x2="settle"]')].find((b: any) => b.dataset.pn === 'P1') as any; expect(btn.dataset.out).toBe('1500');
    ui.click(btn); await until(() => ui.$('#axcsa'), 'dialog'); ui.type('#axcsa', '9999'); ui.click('#axok');
    await until(() => /exceeds outstanding/i.test(ui.$('#axerr').textContent), 'over-settle error');
    expect(await one<any>(`SELECT count(*)::int n FROM cod_settlements`)).toMatchObject({ n: 0 });
    ui.type('#axcsa', '1000'); ui.type('#axcsr', 'UI-REF-1'); ui.click('#axok');
    await until(() => /UI-REF-1/.test(ui.view()), 'history shows settlement');
    expect(await one<any>(`SELECT amount,reference_no,partner_id,business_id FROM cod_settlements`)).toMatchObject({ amount: 1000, reference_no: 'UI-REF-1', partner_id: W.A.partnerId, business_id: W.A.id });
    const t = await query<any>(`SELECT t.status,t.settled_amount FROM cod_transactions t JOIN orders o ON o.id=t.order_id WHERE o.invoice_number IN ('COD-A1','COD-A2') ORDER BY o.created_at`);
    expect(t[0]).toMatchObject({ status: 'settled', settled_amount: 1000 }); expect(t[1].settled_amount).toBe(0);          // oldest cash settled first
    expect(ui.$('#axcp').textContent).toMatch(/P1.*₹500/);
    ui.close();
  });
  it('a manager without cod.settle sees the numbers but no Settle button, and a forced call is refused by the server', async () => {
    const ui = await openApp(base); await ui.signIn('mgr@alpha.test'); expect(ui.nav()).toContain('COD'); ui.go('cod'); await until(() => ui.$('#axcp table'), 'page');
    expect(ui.$('[data-x2="settle"]')).toBeNull();
    await expect(ui.w.__dms.api('/cod/settlements', { method: 'POST', body: { partnerId: W.A.partnerId, amount: 10 } })).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    ui.close();
  });
  it('a manager without cod.view has no COD menu, a blocked page, and the server refuses the data', async () => {
    const perms = (await W.A.admin.get(`/api/users/${W.A.managerId}/permissions`)).body.data.permissions as string[];
    await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: perms.filter(p => p !== 'cod.view') });
    const ui = await openApp(base); await ui.signIn('mgr@alpha.test'); expect(ui.nav()).not.toContain('COD'); ui.go('cod');
    expect(ui.view()).toMatch(/Unauthorized/);
    await expect(ui.w.__dms.api('/cod/summary')).rejects.toMatchObject({ status: 403 });
    await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: perms }); ui.close();
  });
  it('Business A cannot see or settle Business B\'s cash', async () => {
    const ui = await openApp(base); await ui.signIn('admin@alpha.test');
    await expect(ui.w.__dms.api('/cod/settlements', { method: 'POST', body: { partnerId: W.B.partnerId, amount: 10 } })).rejects.toMatchObject({ status: 404 });
    const tx = (await ui.w.__dms.api('/cod/transactions?limit=100')).data; expect(tx.every((x: any) => !String(x.invoice_number).startsWith('COD-B'))).toBe(true);
    expect((await W.B.admin.get('/api/cod/summary')).body.data.totals.collected).toBe(700);
    ui.close();
  });
  it('partner: sees only their own cash on Home, can submit it, and the manager then sees it as submitted', async () => {
    const ui = await openApp(base); await ui.signIn('p2@alpha.test'); await until(() => ui.$('#axcash'), 'cash card');
    expect(ui.$('#axcash').textContent).toMatch(/Collected.*₹300/); expect(ui.$('#axcash').textContent).not.toMatch(/₹1,800/);
    ui.click('[data-x2="csubmit"]'); await until(() => /Submitted, awaiting settlement\s*₹300/.test(ui.$('#axcash')?.textContent ?? ''), 'submitted');
    expect((await one<any>(`SELECT t.status FROM cod_transactions t JOIN orders o ON o.id=t.order_id WHERE o.invoice_number='COD-A3'`)).status).toBe('submitted');
    expect(ui.$('[data-x2="csubmit"]')).toBeNull();
    await expect(ui.w.__dms.api('/cod/settlements', { method: 'POST', body: { partnerId: W.A.partner2Id, amount: 10 } })).rejects.toMatchObject({ status: 403 });
    ui.close();
  });
  it('the login screen no longer advertises demo credentials, and no UI errors occurred', async () => {
    const ui = await openApp(base); expect(ui.text()).not.toMatch(/demo@dms\.com|Demo@123/); expect(ui.text()).toMatch(/Sign in with your DMS account/);
    expect(ui.errors.filter((e: string) => !/Could not load|Not implemented|getContext/i.test(e))).toEqual([]); ui.close(); await sleep(1);
  });
});
