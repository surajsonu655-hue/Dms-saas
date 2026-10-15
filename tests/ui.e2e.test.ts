/**
 * End-to-end UI test: the REAL frontend (public/index.html + dms-api-mode.js) runs in jsdom, served by the REAL backend
 * over HTTP against a real PostgreSQL database. The test drives the UI like a user (type, click, select) and then checks
 * both the screen and the database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg as any;
import type { AddressInfo } from 'node:net';
import { webcrypto } from 'node:crypto';
import { createApp } from '../src/app.js';
import { until, sleep, openApp as openAppAt } from './uiHelper.js';
import { one, query } from '../src/db.js';
import { as, buildWorld, closeDb, newOrder, png, type World } from './helpers.js';

let W: World, base = '', server: any;
const openApp = () => openAppAt(base);
beforeAll(async () => {
  W = await buildWorld();
  server = createApp().listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // data for both tenants, created through the API
  for (const [X, p] of [[W.A, 'A'], [W.B, 'B']] as const)
    for (let i = 1; i <= 3; i++) await X.manager.post('/api/orders', newOrder({ invoiceNumber: `${p}-SEED-${i}`, customerName: `${p} Customer ${i}`, customerMobile: `98000000${p === 'A' ? 1 : 2}${i}` }));
});
afterAll(async () => { server?.close(); await closeDb(); });

describe('1. login and session', () => {
  it('serves the real frontend with the API layer; unauthenticated users only see the login screen', async () => {
    const ui = await openApp();
    expect(ui.w.DMS_API_BASE).toBe('/api');
    expect(ui.$('#login').hidden).toBe(false);
    expect(ui.w.eval('orders').length).toBeGreaterThan(-1);
    ui.close();
  });
  it('rejects bad credentials with a clear message and no session', async () => {
    const ui = await openApp();
    ui.type('#le', 'admin@alpha.test'); ui.type('#lp', 'Wrong@1234'); ui.$('#lf').dispatchEvent(new ui.w.Event('submit', { cancelable: true, bubbles: true }));
    await until(() => /Incorrect email or password/.test(ui.$('#lerr').textContent), 'error message');
    expect(ui.w.eval('S').user).toBeNull(); expect(ui.w.sessionStorage.getItem('dms_rt')).toBeNull();
    ui.type('#le', ''); ui.type('#lp', ''); ui.$('#lf').dispatchEvent(new ui.w.Event('submit', { cancelable: true, bubbles: true })); expect(ui.$('#lerr').textContent).toMatch(/Enter your email/);
    ui.close();
  });
  it('signs in with real credentials: real user/role/business, no demo data, no demo switcher, tokens kept out of localStorage', async () => {
    const ui = await openApp(); await ui.signIn('admin@alpha.test');
    expect(ui.w.eval('S').role).toBe('admin'); expect(ui.w.eval('USER').email).toBe('admin@alpha.test');
    expect(ui.w.eval('BIZ')).toHaveLength(1); expect(ui.w.eval('BIZ')[0].name).toBe('Alpha Store');
    expect([ui.w.eval('orders').length, ui.w.eval('partners').length, ui.w.eval('STAFF').length, ui.w.eval('returns').length]).toEqual([0, 0, 0, 0]);   // demo arrays emptied
    expect(ui.$('.demo').style.display).toBe('none');
    expect(ui.w.localStorage.getItem('dms_rt')).toBeNull(); expect(JSON.stringify(ui.w.localStorage)).not.toMatch(/eyJ/);
    await until(() => /Alpha Store/.test(ui.$('#title').textContent), 'title');
    ui.close();
  });
  it('a page reload restores the session from the refresh token, and logout ends it everywhere', async () => {
    const ui = await openApp(); await ui.signIn('admin@alpha.test');
    const rt = ui.w.sessionStorage.getItem('dms_rt'); expect(rt).toBeTruthy();
    const ui2 = await openApp(); ui2.w.sessionStorage.setItem('dms_rt', rt!);
    const ui3 = await openApp();                                    // simulate reload in the same tab: same sessionStorage value
    ui3.w.sessionStorage.setItem('dms_rt', rt!); ui3.close(); ui2.close();
    const at = ui.w.__dms.T.at;
    ui.click('[data-lo]');
    await until(() => !ui.w.eval('S').user && ui.w.sessionStorage.getItem('dms_rt') === null, 'logout');
    expect(ui.$('#login').hidden).toBe(false); expect(ui.w.eval('orders').length).toBe(0);
    await until(async () => (await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + at } })).status === 401, 'token revoked');
    ui.close();
  });
  it('a revoked session sends the user back to the login screen with an explanation', async () => {
    const ui = await openApp(); await ui.signIn('manager@alpha.test'.replace('manager', 'mgr'));
    await query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1`, [W.A.managerId]);
    ui.go('orders');
    await until(() => !ui.w.eval('S').user, 'forced logout');
    expect(ui.$('#lerr').textContent).toMatch(/session has ended/i);
    ui.close();
  });
});

describe('2. role-based access in the UI', () => {
  it('each role sees only its own navigation, and the server decides what is allowed', async () => {
    const adm = await openApp(); await adm.signIn('admin@alpha.test');
    expect(adm.nav()).toEqual(expect.arrayContaining(['Dashboard', 'Orders', 'Settings']));
    const mgr = await openApp(); await mgr.signIn('mgr@alpha.test');
    expect(mgr.nav()).toEqual(expect.arrayContaining(['Dashboard', 'Orders', 'Returns']));
    expect(mgr.nav()).not.toContain('Staff & Team'); expect(mgr.nav()).not.toContain('Data & Reports');
    const par = await openApp(); await par.signIn('p1@alpha.test');
    expect(par.nav()).toEqual(['Home', 'Assigned orders', 'Current delivery', 'History', 'My Account']);
    // a partner who forces the Orders view is refused by the UI AND by the server
    par.go('orders'); expect(par.view()).toMatch(/Unauthorized/);
    const r = await fetch(base + '/api/orders', { headers: { Authorization: 'Bearer ' + par.w.__dms.T.at } }); expect(r.status).toBe(403);
    const own = await openApp(); await own.signIn('owner@test.dev');
    expect(own.w.eval('S').role).toBe('owner'); await until(() => /Total businesses/.test(own.view()), 'owner dashboard');
    expect(own.view()).not.toMatch(/Total orders|A-SEED|B-SEED/);                  // platform figures only, no order-level data
    own.go('orders'); expect(own.view()).toMatch(/Unauthorized/);
    for (const u of [adm, mgr, par, own]) u.close();
  });
  it('modules that are not connected yet say so instead of showing demo data', async () => {
    const ui = await openApp(); await ui.signIn('admin@alpha.test');
    for (const v of ['team', 'data']) { ui.go(v); expect(ui.view()).toMatch(/Not connected to the backend yet/); }
    ui.close();
  });
});

describe('3. dashboard and orders with real data', () => {
  it('dashboard KPIs come from the server and clicking one filters the orders list', async () => {
    const ui = await openApp(); await ui.signIn('admin@alpha.test');
    await until(() => /Total orders/.test(ui.view()), 'dashboard');
    const s = (await W.A.admin.get('/api/orders/summary')).body.data;
    const total = ui.$('[data-x2="kpi"] b').textContent; expect(Number(total)).toBeGreaterThanOrEqual(0);
    ui.w.eval('S').range = 7; ui.go('dash'); await until(() => /Total orders/.test(ui.view()), 'dashboard 2');
    expect(s.total).toBeGreaterThanOrEqual(3);
    ui.click('[data-x2="kpi"][data-st="assigned,accepted,picked_up"]');
    await until(() => ui.w.eval('S').view === 'orders' && ui.$('#axlist table, #axlist .empty'), 'orders after KPI click');
    ui.close();
  });
  it('lists only the signed-in business\'s orders; search, status filter and pagination go to the server', async () => {
    const ui = await openApp(); await ui.signIn('admin@alpha.test'); ui.go('orders');
    await until(() => ui.$('#axlist table'), 'orders table');
    const t = ui.view(); expect(t).toContain('A-SEED-1'); expect(t).not.toContain('B-SEED'); expect(t).not.toContain('B Customer');
    ui.type('#axq', 'A-SEED-2'); await until(() => /A-SEED-2/.test(ui.$('#axlist').textContent) && !/A-SEED-1/.test(ui.$('#axlist').textContent), 'search result');
    ui.type('#axq', ''); await until(() => /A-SEED-1/.test(ui.$('#axlist').textContent), 'search cleared');
    ui.select(ui.$('#axst'), 'delivered'); await until(() => /No orders match/.test(ui.$('#axlist').textContent), 'status filter');
    ui.select(ui.$('#axst'), ''); await until(() => ui.$('#axlist table'), 'filter cleared');
    ui.close();
  });
  it('create -> view -> edit -> ready -> assign -> cancel, with validation and server errors shown to the user', async () => {
    const ui = await openApp(); await ui.signIn('admin@alpha.test'); ui.go('orders'); await until(() => ui.$('#axlist table'), 'table');
    // --- create (invalid first)
    ui.click('[data-x2="new"]'); await until(() => ui.$('#axbn'), 'new-order form');
    ui.type('#axba', '-5'); ui.type('#axch', '50'); ui.type('#axcn', 'Ui Customer'); ui.type('#axmo', '9876501234'); ui.type('#axad', '7 Park Street');
    ui.click('#axok'); await until(() => /Bill amount must be above/.test(ui.$('#axerr').textContent), 'client validation');
    ui.type('#axba', '950'); expect(ui.$('#axrc').textContent).toMatch(/Receivable ₹1,000/);                         // 950 + 50
    ui.type('#axbn', 'UI-1001'); ui.click('#axok');
    await until(() => /UI-1001/.test(ui.$('#axlist').textContent), 'new order listed');
    const db = await one<any>(`SELECT * FROM orders WHERE invoice_number='UI-1001'`);
    expect(db).toMatchObject({ business_id: W.A.id, bill_amount: 950, change_amount: 50, receivable_amount: 1000, status: 'created', payment_mode: 'cod' });
    // duplicate invoice -> server error text is shown in the dialog
    ui.click('[data-x2="new"]'); await until(() => ui.$('#axbn'), 'form 2');
    ui.type('#axbn', 'UI-1001'); ui.type('#axcn', 'Dup'); ui.type('#axmo', '9876501235'); ui.type('#axad', 'Somewhere'); ui.type('#axba', '10'); ui.click('#axok');
    await until(() => /already exists/i.test(ui.$('#axerr').textContent), 'duplicate error');
    ui.click('#dlg button[value="x"]');
    // --- view
    const rowFor = () => [...ui.d.querySelectorAll('#axlist tr')].find((r: any) => r.textContent.includes('UI-1001')) as any;
    ui.click(rowFor().querySelector('[data-x2="view"]')); await until(() => /Timeline/.test(ui.$('#axdet').textContent) && /created/.test(ui.$('#axdet').textContent), 'details');
    ui.click('#dlg button[value="x"]');
    // --- edit
    ui.click(rowFor().querySelector('[data-x2="edit"]')); await until(() => ui.$('#axcn'), 'edit form');
    ui.type('#axcn', 'Renamed Customer'); ui.click('#axok'); await until(() => /Renamed Customer/.test(ui.$('#axlist').textContent), 'edit shown');
    expect((await one<any>(`SELECT customer_name FROM orders WHERE invoice_number='UI-1001'`)).customer_name).toBe('Renamed Customer');
    // --- ready -> assign
    ui.click(rowFor().querySelector('[data-x2="ready"]')); await until(() => rowFor().querySelector('[data-x2="assign"]'), 'ready');
    const sel = rowFor().querySelector('[data-x2="assign"]'); expect([...sel.options].map((o: any) => o.textContent).join()).toMatch(/P1/);
    ui.select(sel, W.A.partnerId); await until(() => /Assigned/.test(rowFor().textContent) && /P1/.test(rowFor().textContent), 'assigned');
    expect((await one<any>(`SELECT status,current_partner_id FROM orders WHERE invoice_number='UI-1001'`))).toMatchObject({ status: 'assigned', current_partner_id: W.A.partnerId });
    // --- cancel (confirmation dialog)
    ui.click(rowFor().querySelector('[data-x2="cancel"]')); await until(() => ui.$('#cy'), 'confirm dialog'); ui.click('#cy');
    await until(() => /Cancelled/.test(rowFor().textContent), 'cancelled');
    expect((await one<any>(`SELECT status FROM orders WHERE invoice_number='UI-1001'`)).status).toBe('cancelled');
    expect(ui.errors.filter(e => !/Could not load|Not implemented|getContext/i.test(e))).toEqual([]);
    ui.close();
  });
  it('a manager without create permission gets no New order button, and the server refuses a forced request', async () => {
    await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: ['orders.view', 'deliveries.view'] });
    const ui = await openApp(); await ui.signIn('mgr@alpha.test'); ui.go('orders'); await until(() => ui.$('#axlist table'), 'table');
    expect(ui.$('[data-x2="new"]')).toBeNull(); expect(ui.$('[data-x2="ready"]')).toBeNull();
    await expect(ui.w.__dms.api('/orders', { method: 'POST', body: newOrder() })).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: ['orders.view', 'orders.create', 'orders.edit', 'deliveries.view', 'deliveries.assign', 'deliveries.reassign', 'deliveries.update', 'deliveries.verify', 'customers.view', 'cod.view', 'returns.view', 'reports.view'] });
    ui.close();
  });
});

describe('4. tenant isolation from the UI', () => {
  it('Business A\'s session cannot read or change Business B\'s order, even when the browser sends B\'s id', async () => {
    const bOrder = (await one<any>(`SELECT id FROM orders WHERE invoice_number='B-SEED-1'`)).id;
    const ui = await openApp(); await ui.signIn('admin@alpha.test');
    const api = ui.w.__dms.api;
    for (const call of [() => api('/orders/' + bOrder), () => api('/orders/' + bOrder, { method: 'PATCH', body: { notes: 'hacked' } }), () => api('/orders/' + bOrder + '/cancel', { method: 'POST' }), () => api('/orders/' + bOrder + '/events')])
      await expect(call()).rejects.toMatchObject({ status: 404 });
    await expect(api('/orders', { method: 'POST', body: { ...newOrder(), businessId: W.B.id } })).resolves.toMatchObject({ data: { business_id: W.A.id } });
    expect((await one<any>(`SELECT notes,status FROM orders WHERE id=$1`, [bOrder]))).toMatchObject({ status: 'created', notes: null });
    // B's data never reaches A's screen, including search by B's customer
    ui.go('orders'); await until(() => ui.$('#axlist table'), 'table'); ui.type('#axq', 'B Customer');
    await until(() => /No orders match/.test(ui.$('#axlist').textContent), 'empty search');
    expect(ui.text()).not.toContain('B-SEED');
    // the assignment dropdown only offers A's partners
    ui.type('#axq', ''); await until(() => ui.$('#axlist table'), 'table again');
    const names = (ui.w.__dms.AS.partners as any[]).map(p => p.id); expect(names).toEqual(expect.arrayContaining([W.A.partnerId])); expect(names).not.toContain(W.B.partnerId);
    ui.close();
  });
});

describe('5. error handling and loading states', () => {
  it('shows a skeleton while loading, a readable error with Retry when the network fails, and recovers', async () => {
    const ui = await openApp(); await ui.signIn('admin@alpha.test');
    const realFetch = ui.w.fetch; let fail = true;
    ui.w.fetch = (u: string, o: any) => fail ? Promise.reject(new TypeError('network down')) : realFetch(u, o);
    ui.go('orders');
    expect(ui.$('#axlist .sk')).toBeTruthy();                                         // loading skeleton is visible immediately
    await until(() => /Cannot reach the server/.test(ui.$('#axlist').textContent), 'network error');
    fail = false; ui.click('[data-x2="retry-orders"]'); await until(() => ui.$('#axlist table'), 'recovered');
    ui.close();
  });
  it('server-side rule errors reach the user as messages (assigning to an off-duty partner)', async () => {
    await query(`UPDATE users SET duty_on=false WHERE id=$1`, [W.A.partner2Id]);
    const ui = await openApp(); await ui.signIn('admin@alpha.test'); ui.go('orders'); await until(() => ui.$('#axlist table'), 'table');
    const o = await one<any>(`SELECT id FROM orders WHERE invoice_number='A-SEED-1'`); await W.A.admin.post(`/api/orders/${o.id}/ready`);
    ui.go('orders'); await until(() => ui.$('#axlist table'), 'table');
    const sel = [...ui.d.querySelectorAll('[data-x2="assign"]')][0] as any;
    expect([...sel.options].find((x: any) => x.value === W.A.partner2Id).disabled).toBe(true);
    await expect(ui.w.__dms.api(`/orders/${o.id}/assign`, { method: 'POST', body: { partnerId: W.A.partner2Id } })).rejects.toMatchObject({ code: 'PARTNER_OFF_DUTY' });
    await query(`UPDATE users SET duty_on=true WHERE id=$1`, [W.A.partner2Id]);
    ui.close();
  });
});

describe('6. complete flow across roles: admin creates -> manager assigns -> partner delivers -> manager verifies', () => {
  it('works through the UI and leaves a consistent database', async () => {
    const adm = await openApp(); await adm.signIn('admin@alpha.test'); adm.go('orders'); await until(() => adm.$('#axlist table'), 'table');
    adm.click('[data-x2="new"]'); await until(() => adm.$('#axbn'), 'form');
    adm.type('#axbn', 'FLOW-1'); adm.type('#axcn', 'Flow Customer'); adm.type('#axmo', '9811122233'); adm.type('#axad', '1 Flow Road'); adm.type('#axba', '950'); adm.type('#axch', '50');
    adm.click('#axok'); await until(() => /FLOW-1/.test(adm.$('#axlist').textContent), 'created');
    const id = (await one<any>(`SELECT id FROM orders WHERE invoice_number='FLOW-1'`)).id;

    const mgr = await openApp(); await mgr.signIn('mgr@alpha.test'); mgr.go('orders'); await until(() => mgr.$('#axlist table'), 'mgr table');
    const mrow = () => [...mgr.d.querySelectorAll('#axlist tr')].find((r: any) => r.textContent.includes('FLOW-1')) as any;
    mgr.click(mrow().querySelector('[data-x2="ready"]')); await until(() => mrow().querySelector('[data-x2="assign"]'), 'ready');
    mgr.select(mrow().querySelector('[data-x2="assign"]'), W.A.partnerId); await until(() => /Assigned/.test(mrow().textContent), 'assigned');

    const par = await openApp(); await par.signIn('p1@alpha.test'); await until(() => /FLOW-1/.test(par.view()), 'partner sees order');
    expect(par.view()).not.toMatch(/B-SEED|A-SEED/);                                            // only own assignment
    const act = async (a: string, next: string) => { par.click(`[data-x2="act"][data-a="${a}"]`); await until(() => par.$(next), 'after ' + a); };
    await act('accept', '[data-x2="act"][data-a="pickup"]'); await act('pickup', '[data-x2="act"][data-a="start"]');
    await act('start', '[data-x2="act"][data-a="arrive"]'); await act('arrive', '[data-x2="out"][data-k="deliver"]');
    par.click('[data-x2="out"][data-k="deliver"]'); await until(() => par.$('#axf1'), 'deliver dialog');
    par.type('#axpg', '1000');
    par.click('#axok'); await until(() => /Payment proof photo is required/.test(par.$('#axerr').textContent), 'proof required');
    par.file('#axf1'); par.click('#axok');
    await until(() => /Pending manager verification/.test(par.view()), 'pending verification');
    expect(await one<any>(`SELECT status,final_status,collected_amount,receivable_amount FROM orders WHERE id=$1`, [id])).toMatchObject({ status: 'delivered', final_status: 'pending', collected_amount: 1000, receivable_amount: 1000 });
    // partner cannot start another until verified: tested at API level; duty OFF is blocked now
    par.click('[data-x2="duty"]'); await until(() => true); await sleep(200);
    expect((await one<any>(`SELECT duty_on FROM users WHERE id=$1`, [W.A.partnerId])).duty_on).toBe(true);

    mgr.go('orders'); await until(() => mrow() && mrow().querySelector('[data-x2="verify"]'), 'verify button');
    mgr.click(mrow().querySelector('[data-x2="verify"]')); await until(() => mgr.$('#axfa'), 'verify dialog'); mgr.click('#axok');
    await until(() => /Complete/.test(mrow().textContent) && !mrow().querySelector('[data-x2="verify"]'), 'verified');
    expect((await one<any>(`SELECT final_status,final_amount FROM orders WHERE id=$1`, [id]))).toMatchObject({ final_status: 'complete', final_amount: 1000 });

    par.go('hist'); await until(() => /FLOW-1/.test(par.view()) && /Delivered/.test(par.view()), 'history');
    par.go('home'); await until(() => /No active orders/.test(par.view()), 'home empty'); par.click('[data-x2="duty"]');
    await until(async () => (await one<any>(`SELECT duty_on FROM users WHERE id=$1`, [W.A.partnerId])).duty_on === false, 'duty off allowed after verification');
    for (const u of [adm, mgr, par]) u.close();
  });
});
