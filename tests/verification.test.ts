/**
 * Verification of the connected Login + Orders + Delivery workflow (no new modules).
 * Server rules are tested over HTTP; the real UI is driven in jsdom; Google Sheets sync is re-checked after UI-driven flows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { one, query } from '../src/db.js';
import { processSheetSync, setSheetsClient, GoogleSheetsClient } from '../src/services/sheets.js';
import { api, as, buildWorld, closeDb, login, newOrder, png, type World } from './helpers.js';
import { FakeGoogle } from './fakeGoogle.js';
import { openApp, sleep, until } from './uiHelper.js';

let W: World, base = '', server: any; const G = new FakeGoogle(); const SS = 'V'.repeat(12) + 'VerifySheetAAAA';
const startedAt = Date.now() - 2000;
const ids: Record<string, string> = {};

beforeAll(async () => {
  await G.start();
  Object.assign(config.google, { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://localhost:3000/cb', driveListing: true, minIntervalMs: 0,
    authUrl: G.base + '/auth', tokenUrl: G.base + '/token', revokeUrl: G.base + '/revoke', userinfoUrl: G.base + '/userinfo', sheetsBase: G.base + '/sheets', driveBase: G.base + '/drive' });
  setSheetsClient(new GoogleSheetsClient());
  W = await buildWorld();
  server = createApp().listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server?.close(); G.stop(); await closeDb(); });

const order = async (X: World['A'], inv: string, o: any = {}) => (await X.manager.post('/api/orders', newOrder({ invoiceNumber: inv, billAmount: 1000, changeAmount: 0, ...o }))).body.data;

describe('A. server-side permissions: nothing depends on the UI hiding a button', () => {
  let noPerm: ReturnType<typeof as>, oA: string;
  beforeAll(async () => {
    const r = await W.A.admin.post('/api/users', { role: 'manager', name: 'NoPerm', email: 'noperm@alpha.test', password: 'Demo@1234' });
    await W.A.admin.put(`/api/users/${r.body.data.id}/permissions`, { permissions: [] });
    noPerm = as((await login('noperm@alpha.test')).token); oA = (await order(W.A, 'PM-1')).id;
  });
  const MANAGEMENT: [string, string, any?][] = [
    ['get', '/api/orders'], ['get', '/api/orders/summary'], ['post', '/api/orders', null], ['get', '/api/orders/ID'], ['patch', '/api/orders/ID', { notes: 'x' }], ['delete', '/api/orders/ID'],
    ['post', '/api/orders/ID/ready'], ['post', '/api/orders/ID/assign', { partnerId: 'PID' }], ['post', '/api/orders/ID/cancel'], ['post', '/api/orders/ID/retry'], ['post', '/api/orders/ID/verify', { result: 'complete' }],
    ['get', '/api/orders/ID/events'], ['get', '/api/delivery-partners'], ['get', '/api/customers'], ['get', '/api/users'], ['post', '/api/users', {}], ['get', '/api/returns'],
    ['get', '/api/reports/orders'], ['get', '/api/integrations/google'], ['get', '/api/webhooks'], ['get', '/api/api-keys'], ['put', '/api/business/settings', {}], ['get', '/api/cod/summary'],
  ];
  const fill = (s: string) => s.replace('PID', W.A.partnerId).replace('/ID', '/' + oA);
  const call = (who: any, m: string, p: string, b?: any) => who[m === 'delete' ? 'del' : m](fill(p), b === null ? newOrder() : b ? JSON.parse(fill(JSON.stringify(b))) : undefined);

  it('a manager with ZERO permissions is refused (403 PERMISSION_DENIED) on every management endpoint', async () => {
    for (const [m, p, b] of MANAGEMENT) { const r = await call(noPerm, m, p, b); expect([m, p, r.status], JSON.stringify(r.body)).toEqual([m, p, 403]); expect(r.body.code).toBe('PERMISSION_DENIED'); }
  });
  it('a delivery partner is refused on every management endpoint', async () => {
    for (const [m, p, b] of MANAGEMENT.filter(x => x[1] !== '/api/cod/summary')) { const r = await call(W.A.partner, m, p, b); expect([m, p, r.status]).toEqual([m, p, 403]); }
    const own = (await W.A.partner.get('/api/cod/summary')).body.data; expect(JSON.stringify(own)).not.toContain(W.A.partner2Id);   // own COD only
  });
  it('unauthenticated callers get 401 everywhere', async () => {
    for (const [m, p] of MANAGEMENT) { const r = await (api() as any)[m](fill(p)); expect([m, p, r.status]).toEqual([m, p, 401]); }
  });
  it('the platform owner cannot operate business orders/deliveries', async () => {
    for (const [m, p, b] of MANAGEMENT.filter(x => /orders|delivery-partners|customers/.test(x[1]))) { const r = await call(W.owner, m, p, b); expect([m, p, r.status]).toEqual([m, p, 403]); }
  });
  it('another business\'s admin gets 404 (never 200/403-with-data) for every id-based order endpoint', async () => {
    for (const [m, p, b] of MANAGEMENT.filter(x => x[1].includes('/ID'))) { const r = await call(W.B.admin, m, p, b); expect([m, p, [403, 404].includes(r.status)]).toEqual([m, p, true]); }
    expect((await one<any>(`SELECT status,notes,deleted_at FROM orders WHERE id=$1`, [oA]))).toMatchObject({ status: 'created', notes: null, deleted_at: null });
  });
  it('partners cannot act on deliveries that are not theirs, or perform staff actions', async () => {
    await W.A.manager.post(`/api/orders/${oA}/ready`); await W.A.manager.post(`/api/orders/${oA}/assign`, { partnerId: W.A.partnerId });
    for (const a of ['accept', 'reject', 'pickup', 'start', 'arrive', 'deliver', 'partial', 'fail', 'full_return']) expect((await W.A.partner2.post(`/api/deliveries/${oA}/${a}`, {})).status, a).toBe(403);
    expect((await W.A.partner2.get(`/api/deliveries/${oA}`)).status).toBe(403);
    expect((await W.B.partner.get(`/api/deliveries/${oA}`)).status).toBeGreaterThanOrEqual(403);
    expect((await W.A.manager.post(`/api/deliveries/${oA}/accept`, {})).status).toBe(403);             // managers cannot accept on a partner's behalf
    expect((await W.A.partner.post('/api/cod/settlements', { partnerId: W.A.partnerId, amount: 1 })).status).toBe(403);
    expect((await W.A.partner.post(`/api/orders/${oA}/verify`, { result: 'complete' })).status).toBe(403);   // a partner cannot verify their own delivery
    await W.A.manager.post(`/api/orders/${oA}/cancel`);
  });
  it('the UI shows no action buttons to the zero-permission manager, and forced calls from that session still fail', async () => {
    const ui = await openApp(base); await ui.signIn('noperm@alpha.test'); ui.go('orders');
    await until(() => ui.$('#axlist table'), 'table', 1500).catch(() => until(() => /No orders|You do not have|Missing|Unauthorized/.test(ui.view()), 'denied or empty'));
    expect(ui.$('[data-x2="new"]')).toBeNull(); expect(ui.$('[data-x2="ready"]')).toBeNull(); expect(ui.$('[data-x2="assign"]')).toBeNull(); expect(ui.$('[data-x2="verify"]')).toBeNull();
    await expect(ui.w.__dms.api('/orders', { method: 'POST', body: newOrder() })).rejects.toMatchObject({ status: 403 });
    await expect(ui.w.__dms.api(`/orders/${oA}/assign`, { method: 'POST', body: { partnerId: W.A.partnerId } })).rejects.toMatchObject({ status: 403 });
    ui.close();
  });
});

describe('B. backend timestamps are authoritative and ordered', () => {
  it('every lifecycle timestamp is written by the server, in order; client-supplied times are ignored', async () => {
    const o = await order(W.A, 'TS-1'); const t0 = Date.now();
    await W.A.manager.post(`/api/orders/${o.id}/ready`); await sleep(15);
    await W.A.manager.post(`/api/orders/${o.id}/assign`, { partnerId: W.A.partnerId, assigned_at: '2001-01-01T00:00:00Z' }); await sleep(15);
    for (const a of ['accept', 'pickup', 'start', 'arrive']) { await W.A.partner.post(`/api/deliveries/${o.id}/${a}`, { created_at: '2001-01-01T00:00:00Z', accepted_at: '2001-01-01T00:00:00Z' }); await sleep(15); }
    const proof = (await api().post('/api/files').set('Authorization', `Bearer ${(await login('p1@alpha.test')).token}`).field('kind', 'payment_proof').field('orderId', o.id).attach('file', png, { filename: 'p.png', contentType: 'image/png' })).body.data.id;
    const d = await W.A.partner.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: 1000, paymentProofFileId: proof, completedAt: '2001-01-01T00:00:00Z', delivered_at: '2001-01-01' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const ev = await query<any>(`SELECT new_status,created_at,changed_by,user_role FROM delivery_events WHERE order_id=$1 ORDER BY created_at, id`, [o.id]);
    expect(ev.map(e => e.new_status)).toEqual(['created', 'ready', 'assigned', 'accepted', 'picked_up', 'out_for_delivery', 'arrived', 'delivered']);
    const times = ev.map(e => +new Date(e.created_at)); expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times[0]).toBeGreaterThanOrEqual(startedAt); expect(times.at(-1)!).toBeLessThanOrEqual(Date.now() + 1000); expect(times[0]).toBeGreaterThanOrEqual(t0 - 2000);
    expect(ev.find(e => e.new_status === 'delivered')).toMatchObject({ changed_by: W.A.partnerId, user_role: 'delivery_partner' });
    expect(ev.find(e => e.new_status === 'assigned')).toMatchObject({ changed_by: W.A.managerId, user_role: 'manager' });
    const dl = (await one<any>(`SELECT * FROM deliveries WHERE order_id=$1`, [o.id]))!, as1 = (await one<any>(`SELECT assigned_at FROM delivery_assignments WHERE order_id=$1`, [o.id]))!;
    const T = [as1.assigned_at, dl.accepted_at, dl.picked_up_at, dl.out_for_delivery_at, dl.arrived_at, dl.completed_at].map((x: any) => +new Date(x));
    expect(T.every(Number.isFinite)).toBe(true); expect([...T].sort((a, b) => a - b)).toEqual(T);
    expect(T.every(t => t > +new Date('2020-01-01') && t >= startedAt)).toBe(true);          // none of the 2001 values the client tried to send
    expect((await one<any>(`SELECT created_at FROM orders WHERE id=$1`, [o.id]))!.created_at.getFullYear()).toBeGreaterThan(2020);
    await W.A.manager.post(`/api/orders/${o.id}/verify`, { result: 'complete' });
    const v = (await one<any>(`SELECT verified_at FROM orders WHERE id=$1`, [o.id]))!; expect(+new Date(v.verified_at)).toBeGreaterThanOrEqual(T.at(-1)!);
  });
});

describe('C. UI-driven Failed / Full Return / Partial / Delivered, with Google Sheets sync still intact', () => {
  let adm: Awaited<ReturnType<typeof openApp>>, mgr: typeof adm, p1: typeof adm, p2: typeof adm;
  beforeAll(async () => {
    G.addSpreadsheet(SS, 'Verification', ['Orders']);
    const url = (await W.A.admin.get('/api/integrations/google/auth-url')).body.data.url as string;
    const cb = await api().get(`/api/integrations/google/callback?code=good-code&state=${new URL(url).searchParams.get('state')}`); expect(cb.headers.location).toContain('google=connected');
    expect((await W.A.admin.put('/api/integrations/google/sheet', { spreadsheetId: SS, sheetName: 'Orders' })).status).toBe(200);
    expect((await W.A.admin.post('/api/integrations/google/auto-sync', { enabled: true, initialSync: 'new_only' })).status).toBe(200);
    adm = await openApp(base); await adm.signIn('admin@alpha.test'); mgr = await openApp(base); await mgr.signIn('mgr@alpha.test');
    p1 = await openApp(base); await p1.signIn('p1@alpha.test'); p2 = await openApp(base); await p2.signIn('p2@alpha.test');
  });
  afterAll(() => { for (const u of [adm, mgr, p1, p2]) u?.close(); });

  const mrow = (inv: string) => [...mgr.d.querySelectorAll('#axlist tr')].find((r: any) => r.textContent.includes(inv)) as any;
  async function create(inv: string, bill: string) {
    adm.go('orders'); await until(() => adm.$('#axlist table'), 'admin table');
    adm.click('[data-x2="new"]'); await until(() => adm.$('#axbn'), 'new form');
    adm.type('#axbn', inv); adm.type('#axcn', 'Cust ' + inv); adm.type('#axmo', '98' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0')); adm.type('#axad', '9 Verify Lane'); adm.type('#axba', bill); adm.type('#axch', '0');
    adm.click('#axok'); await until(() => new RegExp(inv).test(adm.$('#axlist').textContent), 'created ' + inv);
    ids[inv] = (await one<any>(`SELECT id FROM orders WHERE invoice_number=$1`, [inv]))!.id;
  }
  async function assign(inv: string, partnerId: string) {
    mgr.go('orders'); await until(() => mrow(inv), 'manager sees ' + inv);
    mgr.click(mrow(inv).querySelector('[data-x2="ready"]')); await until(() => mrow(inv).querySelector('[data-x2="assign"]'), 'ready ' + inv);
    mgr.select(mrow(inv).querySelector('[data-x2="assign"]'), partnerId); await until(() => /Assigned/.test(mrow(inv).textContent), 'assigned ' + inv);
  }
  async function verify(inv: string) {
    mgr.go('orders'); await until(() => mrow(inv) && mrow(inv).querySelector('[data-x2="verify"]'), 'verify button ' + inv);
    mgr.click(mrow(inv).querySelector('[data-x2="verify"]')); await until(() => mgr.$('#axfa'), 'verify dialog'); mgr.click('#axok');
    await until(() => /Complete/.test(mrow(inv).textContent) && !mrow(inv).querySelector('[data-x2="verify"]'), 'verified ' + inv);
  }
  const step = async (u: typeof adm, a: string, next: string) => { u.click(`[data-x2="act"][data-a="${a}"]`); await until(() => u.$(next), 'after ' + a); };
  async function toOut(u: typeof adm, inv: string) {
    u.go('home'); await until(() => new RegExp(inv).test(u.view()), 'partner sees ' + inv);
    await step(u, 'accept', '[data-x2="act"][data-a="pickup"]'); await step(u, 'pickup', '[data-x2="act"][data-a="start"]'); await step(u, 'start', '[data-x2="out"][data-k="fail"]');
  }

  it('FAILED: created in the UI, assigned by the manager, failed by the partner, verified; DB has reason/attempt/timestamps', async () => {
    await create('UIF-1', '700'); await assign('UIF-1', W.A.partner2Id); await toOut(p2, 'UIF-1');
    p2.click('[data-x2="out"][data-k="fail"]'); await until(() => p2.$('#axrs'), 'fail dialog'); p2.type('#axnt', 'Phone switched off'); p2.click('#axok');
    await until(() => /Pending manager verification/.test(p2.view()), 'failed submitted');
    expect(await one<any>(`SELECT status,final_status,collected_amount,attempts FROM orders WHERE invoice_number='UIF-1'`)).toMatchObject({ status: 'failed', final_status: 'pending', collected_amount: 0, attempts: 1 });
    expect(await one<any>(`SELECT failure_reason,failure_notes,completed_at FROM deliveries WHERE order_id=$1`, [ids['UIF-1']])).toMatchObject({ failure_reason: 'Customer unavailable', failure_notes: 'Phone switched off' });
    await verify('UIF-1');
  });
  it('FULL RETURN: return photo is required, a return record is created, the original amount is preserved', async () => {
    await create('UIR-1', '900'); await assign('UIR-1', W.A.partnerId); await toOut(p1, 'UIR-1');
    p1.click('[data-x2="out"][data-k="full_return"]'); await until(() => p1.$('#axf3'), 'return dialog');
    p1.click('#axok'); await until(() => /Return item photo is required/.test(p1.$('#axerr').textContent), 'photo required');
    p1.file('#axf3'); p1.click('#axok'); await until(() => /Pending manager verification/.test(p1.view()), 'return submitted');
    expect(await one<any>(`SELECT status,bill_amount,returned_amount,delivered_amount,collected_amount,final_amount FROM orders WHERE invoice_number='UIR-1'`)).toMatchObject({ status: 'full_return', bill_amount: 900, returned_amount: 900, delivered_amount: 0, collected_amount: 0 });
    expect(await one<any>(`SELECT return_type,original_amount,returned_amount,delivered_amount FROM returns WHERE order_id=$1`, [ids['UIR-1']])).toMatchObject({ return_type: 'full', original_amount: 900, returned_amount: 900, delivered_amount: 0 });
    await verify('UIR-1');
  });
  it('PARTIAL: 1000 - 200 = 800, proof + return photo required, mismatch confirmation works', async () => {
    await create('UIP-1', '1000'); await assign('UIP-1', W.A.partnerId); await toOut(p1, 'UIP-1');
    p1.click('[data-x2="out"][data-k="partial"]'); await until(() => p1.$('#axra'), 'partial dialog');
    p1.type('#axra', '200'); expect(p1.$('#axsm').textContent).toMatch(/Collect.*₹800/);
    p1.type('#axpg', '700'); p1.file('#axf1'); p1.file('#axf3'); p1.click('#axok');
    await until(() => /mismatch/i.test(p1.$('#axerr').textContent), 'mismatch error'); expect(p1.$('#axmmw').hidden).toBe(false);
    p1.type('#axpg', '800'); p1.click('#axok'); await until(() => /Pending manager verification/.test(p1.view()), 'partial submitted');
    expect(await one<any>(`SELECT status,bill_amount,returned_amount,delivered_amount,collected_amount,payment_mismatch FROM orders WHERE invoice_number='UIP-1'`)).toMatchObject({ status: 'partial', bill_amount: 1000, returned_amount: 200, delivered_amount: 800, collected_amount: 800, payment_mismatch: false });
    await verify('UIP-1');
  });
  it('DELIVERED with change: customer pays 1100 for 1000 -> collected 1000, change 100', async () => {
    await create('UID-1', '1000'); await assign('UID-1', W.A.partner2Id); await until(() => /UID-1/.test(p2.view()) || (p2.go('home'), false), 'p2 sees order');
    await step(p2, 'accept', '[data-x2="act"][data-a="pickup"]'); await step(p2, 'pickup', '[data-x2="act"][data-a="start"]'); await step(p2, 'start', '[data-x2="out"][data-k="deliver"]');
    p2.click('[data-x2="out"][data-k="deliver"]'); await until(() => p2.$('#axpg'), 'deliver dialog'); p2.type('#axpg', '1100'); expect(p2.$('#axsm').textContent).toMatch(/Change to customer.*₹100/);
    p2.file('#axf1'); p2.click('#axok'); await until(() => /Pending manager verification/.test(p2.view()), 'delivered submitted');
    expect(await one<any>(`SELECT status,collected_amount,change_given FROM orders WHERE invoice_number='UID-1'`)).toMatchObject({ status: 'delivered', collected_amount: 1000, change_given: 100 });
    await verify('UID-1');
  });
  it('status transitions: the UI never offers an illegal step, and the server rejects forced ones', async () => {
    const id = ids['UID-1'];
    mgr.go('orders'); await until(() => mrow('UID-1'), 'row');
    expect(['ready', 'assign', 'cancel', 'verify', 'edit'].filter(x => mrow('UID-1').querySelector(`[data-x2="${x}"]`))).toEqual([]);     // finished order: no lifecycle buttons
    for (const [m, p] of [['post', 'ready'], ['post', 'assign'], ['post', 'cancel'], ['post', 'retry']] as const) {
      const r = await (W.A.manager as any)[m](`/api/orders/${id}/${p}`, { partnerId: W.A.partnerId }); expect([p, r.status]).toEqual([p, 409]); expect(r.body.code).toBe('INVALID_TRANSITION');
    }
    expect((await W.A.partner2.post(`/api/deliveries/${id}/start`, {})).body.code).toBe('INVALID_TRANSITION');
  });
  it('Google Sheets: every UI-driven order is ONE row, with the right status, return and final amounts, and server timestamps', async () => {
    let r = await processSheetSync(200); expect(r.failed).toBe(0);
    const rows = G.tab(SS, 'Orders').rows, head = rows[0], col = (n: string) => head.indexOf(n);
    const by = (inv: string) => rows.filter(x => x[col('Bill Number')] === inv);
    for (const inv of ['UIF-1', 'UIR-1', 'UIP-1', 'UID-1']) expect(by(inv), inv).toHaveLength(1);
    const get = (inv: string, c: string) => by(inv)[0][col(c)];
    expect(get('UIF-1', 'Status')).toBe('Failed'); expect(get('UIF-1', 'Remarks')).toMatch(/Phone switched off|Customer unavailable/); expect(get('UIF-1', 'Delivered Time')).toBe('');
    expect(get('UIR-1', 'Return Amount')).toBe('900'); expect(get('UIR-1', 'Final Amount')).toBe('0');
    expect(get('UIP-1', 'Status')).toBe('Partial Delivered'); expect(get('UIP-1', 'Return Amount')).toBe('200'); expect(get('UIP-1', 'Final Amount')).toBe('800');
    expect(get('UID-1', 'Status')).toBe('Delivered'); expect(get('UID-1', 'Final Amount')).toBe('1000');
    for (const inv of ['UIP-1', 'UID-1']) { expect(get(inv, 'Assigned Time')).toMatch(/\d{4}/); expect(get(inv, 'Out for Delivery Time')).not.toBe(''); expect(get(inv, 'Duration')).toMatch(/minute|hour|second|< 1/); }
    // the sheet times are the DB event times (Asia/Kolkata), not Google's clock
    const dbAssigned = (await one<any>(`SELECT to_char(a.assigned_at AT TIME ZONE 'Asia/Kolkata','HH12:MI AM') t FROM delivery_assignments a WHERE order_id=$1`, [ids['UID-1']]))!.t;
    expect(get('UID-1', 'Assigned Time')).toContain(dbAssigned);
    // re-running the sync (or Sync Now) never duplicates rows
    const snapshot = (inv: string) => JSON.stringify(by(inv)); const was = ['UIF-1', 'UIR-1', 'UIP-1', 'UID-1'].map(snapshot);
    await W.A.admin.post('/api/integrations/google/sync'); await processSheetSync(200);       // "Sync Now" also pushes older orders; it must never duplicate or alter rows already there
    const after = G.tab(SS, 'Orders').rows.slice(1).map(x => x[col('Bill Number')]); expect(new Set(after).size).toBe(after.length);
    expect(['UIF-1', 'UIR-1', 'UIP-1', 'UID-1'].map(snapshot)).toEqual(was);
    expect((await query<any>(`SELECT count(*)::int n FROM google_sheet_rows r JOIN orders o ON o.id=r.order_id WHERE o.business_id<>r.business_id`))[0].n).toBe(0);
    // Business B's data never reaches Business A's sheet
    await W.B.manager.post('/api/orders', newOrder({ invoiceNumber: 'B-LEAK-CHECK' })); await processSheetSync(200);
    expect(JSON.stringify(G.tab(SS, 'Orders').rows)).not.toContain('B-LEAK-CHECK');
  });
  it('no UI errors were raised during any of the flows', () => { for (const u of [adm, mgr, p1, p2]) expect(u.errors.filter(e => !/Could not load|Not implemented|getContext/i.test(e))).toEqual([]); });
});

describe('D. no mock/demo data and no frontend-only data in the connected UI', () => {
  const DEMO = ['Rahul', 'Amit', 'Sana', 'Vikram', 'Neha', 'Arjun', 'Priya', 'Kabir', 'Meera', 'Ravi', 'Isha', 'Anya', 'Karan', 'Zoya', 'Suresh', 'Anita', 'Farhan', 'Leela', 'Ganesh', 'Tara', 'A. Sharma', 'R. Gupta', 'S. Khan', 'M. Verma', 'Store 2 Door', 'Apex Pharmacy', 'Crumb', 'Sector 14', 'DLF', 'Gurgaon', 'Gurugram'];
  for (const [who, email, role] of [['admin', 'admin@alpha.test', 'admin'], ['manager', 'mgr@alpha.test', 'manager'], ['partner', 'p1@alpha.test', 'partner'], ['owner', 'owner@test.dev', 'owner']] as const)
    it(`${who}: every screen is empty-or-real; the in-page demo arrays stay empty; nothing from the demo dataset appears`, async () => {
      const ui = await openApp(base); await ui.signIn(email);
      for (const k of ui.navKeys()) {
        ui.go(k); await sleep(250); await until(() => !ui.$('#view .sk') && !ui.$('#axlist .sk'), 'loaded ' + k, 8000).catch(() => {});
        const t = ui.text(); for (const d of DEMO) expect(t, `${who}/${k} shows demo value "${d}"`).not.toContain(d);
        expect([ui.ev('orders.length'), ui.ev('partners.length'), ui.ev('STAFF.length'), ui.ev('returns.length'), ui.ev('NT.length')], `${who}/${k}`).toEqual([0, 0, 0, 0, 0]);
      }
      expect(ui.errors.filter(e => !/Could not load|Not implemented|getContext/i.test(e))).toEqual([]);
      ui.close();
    });
  it('every business-data call the UI makes goes to the API (no local order store is read)', async () => {
    const src = await (await fetch(base + '/dms-api-mode.js')).text();
    expect(src).not.toMatch(/localStorage\.setItem\([^)]*(token|jwt|access)/i);
    for (const v of ['dash', 'orders', 'home', 'deliv', 'cur', 'hist', 'account']) expect(src).toContain(v + ':');
    const ui = await openApp(base); await ui.signIn('admin@alpha.test'); const hits: string[] = [];
    const f = ui.w.fetch; ui.w.fetch = (u: string, o: any) => { hits.push((o?.method || 'GET') + ' ' + String(u).split('?')[0]); return f(u, o); };
    ui.go('orders'); await until(() => ui.$('#axlist table'), 'table'); ui.go('dash'); await until(() => /Total orders/.test(ui.view()), 'dash');
    expect(hits).toEqual(expect.arrayContaining(['GET /api/orders', 'GET /api/orders/summary'])); ui.close();
  });
});
