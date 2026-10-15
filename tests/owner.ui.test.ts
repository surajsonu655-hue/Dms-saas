import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { one, query } from '../src/db.js';
import { api, as, buildWorld, closeDb, login, newOrder, png, type World } from './helpers.js';
import { openApp, until } from './uiHelper.js';

let W: World, base = '', server: any;
beforeAll(async () => {
  W = await buildWorld(); server = createApp().listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await W.owner.post('/api/owner/plans', { name: 'Starter', price: 499 });
  for (const [X, em, inv, bill] of [[W.A, 'p1@alpha.test', 'OW-A-1', 900], [W.B, 'p1@beta.test', 'OW-B-1', 400]] as const) {
    const o = (await X.manager.post('/api/orders', newOrder({ invoiceNumber: inv, billAmount: bill, changeAmount: 0, customerName: 'Secret ' + inv }))).body.data;
    await X.manager.post(`/api/orders/${o.id}/ready`); await X.manager.post(`/api/orders/${o.id}/assign`, { partnerId: X.partnerId });
    for (const a of ['accept', 'pickup', 'start', 'arrive']) await X.partner.post(`/api/deliveries/${o.id}/${a}`, {});
    const tok = (await login(em)).token, pay = (await api().post('/api/files').set('Authorization', `Bearer ${tok}`).field('kind', 'payment_proof').field('orderId', o.id).attach('file', png, { filename: 'p.png', contentType: 'image/png' })).body.data.id;
    await X.partner.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: bill, paymentProofFileId: pay });
  }
});
afterAll(async () => { server?.close(); await closeDb(); });
const own = async () => { const ui = await openApp(base); await ui.signIn('owner@test.dev'); return ui; };
const rowOf = (ui: any, name: string) => [...ui.d.querySelectorAll('#view tr')].find((r: any) => r.textContent.includes(name)) as any;

describe('Owner (SaaS operator) modules', () => {
  it('has exactly the 15 owner menu items, in order, and no operational modules', async () => {
    const ui = await own();
    expect(ui.nav()).toEqual(['Dashboard', 'Businesses', 'Business Onboarding', 'Users & Roles', 'Subscriptions', 'Plans & Billing', 'Revenue / Payments', 'Reports & Exports', 'Notifications', 'Support / Helpdesk', 'Integrations', 'API Keys', 'Webhooks', 'System Settings', 'Rights & Permissions']);
    ui.go('orders'); expect(ui.view()).toMatch(/Unauthorized/); await expect(ui.w.__dms.api('/orders')).rejects.toMatchObject({ status: 403, code: 'OWNER_NOT_OPERATIONAL' });
    ui.close();
  });
  it('dashboard: real platform numbers from the database, no order-level data', async () => {
    const ui = await own(); await until(() => ui.$('#view .kpi'), 'dashboard');
    const d = (await W.owner.get('/api/owner/dashboard')).body.data;
    const k = [...ui.d.querySelectorAll('#view .kpi')].map((x: any) => x.textContent.replace(/\s+/g, ' ').trim());
    expect(k.find((x: string) => /Total businesses/.test(x))).toMatch(/2$/); expect(k.find((x: string) => /Business revenue/.test(x))).toContain(`₹${Math.round(d.revenue).toLocaleString('en-IN')}`);
    expect(ui.view()).toContain('Alpha Store'); expect(ui.view()).toContain('Beta Pharmacy'); expect(ui.view()).not.toMatch(/OW-A-1|Secret/);
    ui.close();
  });
  it('businesses: list, search, status filter; revenue per business is real', async () => {
    const ui = await own(); ui.go('biz'); await until(() => ui.$('#axbl table'), 'list');
    expect(rowOf(ui, 'Alpha Store').textContent).toContain('₹900'); expect(rowOf(ui, 'Beta Pharmacy').textContent).toContain('₹400');
    ui.type('#axbq', 'Alpha'); await until(() => !rowOf(ui, 'Beta Pharmacy') && rowOf(ui, 'Alpha Store'), 'search');
    ui.type('#axbq', ''); ui.select(ui.$('#axbs'), 'suspended'); await until(() => /No businesses match/.test(ui.$('#axbl').textContent), 'status filter'); ui.close();
  });
  it('overview shows business-level information only (no orders, no customers)', async () => {
    const ui = await own(); ui.go('biz'); await until(() => ui.$('#axbl table'), 'list');
    ui.click(rowOf(ui, 'Alpha Store').querySelector('[data-x2="bopen"]')); await until(() => /Subscription/.test(ui.view()) && /Staff/.test(ui.view()), 'overview');
    const t = ui.view(); expect(t).toContain('Alpha Store'); expect(t).toContain('Alpha Store Admin'); expect(t).toMatch(/Revenue\s*₹900/); expect(t).not.toMatch(/OW-A-1|Secret|OW-B-1/); expect(t).toContain('alpha.test'); expect(t).not.toContain('beta.test');
    ui.close();
  });
  it('suspend signs the business out at once and blocks login; activate restores it; both need confirmation', async () => {
    const adminUi = await openApp(base); await adminUi.signIn('admin@beta.test'); const ui = await own(); ui.go('biz'); await until(() => ui.$('#axbl table'), 'list');
    ui.click(rowOf(ui, 'Beta Pharmacy').querySelector('[data-x2="bsus"]')); await until(() => ui.$('#cy'), 'confirm'); ui.click('#cy');
    await until(() => /suspended/.test(rowOf(ui, 'Beta Pharmacy')?.textContent ?? ''), 'suspended in UI');
    expect((await one<any>(`SELECT status FROM businesses WHERE name='Beta Pharmacy'`)).status).toBe('suspended');
    await expect(adminUi.w.__dms.api('/orders')).rejects.toMatchObject({ status: 401 }); expect((await login('admin@beta.test')).res.status).toBe(403);
    ui.click(rowOf(ui, 'Beta Pharmacy').querySelector('[data-x2="bact"]')); await until(() => /active/.test(rowOf(ui, 'Beta Pharmacy')?.textContent ?? '') && !/suspended/.test(rowOf(ui, 'Beta Pharmacy').textContent), 'active again');
    expect((await login('admin@beta.test')).res.status).toBe(200); adminUi.close(); ui.close();
  });
  it('onboarding: validation errors come from the server; a valid form creates the business and a working admin login; duplicates are refused', async () => {
    const ui = await own(); ui.go('onboard'); await until(() => ui.$('#axo1'), 'form');
    ui.type('#axo1', 'Fresh Bakes'); ui.type('#axo2', 'Bakery'); ui.type('#axo3', 'Neha Rao'); ui.type('#axo4', 'neha@freshbakes.test'); ui.type('#axo6', 'weakpass');
    ui.click('[data-x2="osave"]'); await until(() => /capital letter/i.test(ui.$('#axoe').textContent), 'weak password error');
    expect(await one<any>(`SELECT count(*)::int n FROM businesses WHERE name='Fresh Bakes'`)).toMatchObject({ n: 0 });
    ui.type('#axo6', 'Welcome@123'); ui.click('[data-x2="osave"]'); await until(() => ui.ev('S.view') === 'biz' && rowOf(ui, 'Fresh Bakes'), 'created');
    expect(await one<any>(`SELECT role,status FROM users WHERE email='neha@freshbakes.test'`)).toMatchObject({ role: 'business_admin', status: 'active' });
    expect(await one<any>(`SELECT s.status FROM subscriptions s JOIN businesses b ON b.id=s.business_id WHERE b.name='Fresh Bakes'`)).toMatchObject({ status: 'trial' });
    const a = await openApp(base); await a.signIn('neha@freshbakes.test', 'Welcome@123'); expect(a.ev('S.role')).toBe('admin'); expect(a.ev('BIZ[0].name')).toBe('Fresh Bakes'); await until(() => /Total orders/.test(a.view()), 'new admin dashboard'); expect(a.view()).not.toMatch(/Alpha|Beta/); a.close();
    ui.go('onboard'); await until(() => ui.$('#axo1'), 'form 2'); ui.type('#axo1', 'fresh bakes'); ui.type('#axo2', 'Bakery'); ui.type('#axo3', 'X Y'); ui.type('#axo4', 'x@y.test'); ui.type('#axo6', 'Welcome@123'); ui.click('[data-x2="osave"]');
    await until(() => /already exists|exists/i.test(ui.$('#axoe').textContent), 'duplicate refused');
    // delete (with the confirmation text) removes platform access for that business
    ui.go('biz'); await until(() => rowOf(ui, 'Fresh Bakes'), 'row'); ui.click(rowOf(ui, 'Fresh Bakes').querySelector('[data-x2="bdel"]')); await until(() => ui.$('#cy') && /Are you sure you want to delete/.test(ui.$('#dlg').textContent), 'confirm text'); ui.click('#cy');
    await until(() => !rowOf(ui, 'Fresh Bakes'), 'removed from list'); expect((await login('neha@freshbakes.test')).res.status).toBeGreaterThanOrEqual(401);
    expect(await one<any>(`SELECT deleted_at IS NOT NULL AS gone FROM businesses WHERE name='Fresh Bakes'`)).toMatchObject({ gone: true });             // soft delete: history preserved
    ui.close();
  });
  it('plans: create, edit and deactivate through the UI', async () => {
    const ui = await own(); ui.go('plans'); await until(() => ui.$('[data-x2="pnew"]'), 'plans');
    ui.click('[data-x2="pnew"]'); await until(() => ui.$('#axpn'), 'dialog'); ui.type('#axpn', 'Gold'); ui.type('#axpp', '-5'); ui.click('#axok'); await until(() => /negative/i.test(ui.$('#axerr').textContent), 'client check');
    ui.type('#axpp', '1999'); ui.type('#axpu', '25'); ui.$('#axpg').checked = true; ui.click('#axok'); await until(() => rowOf(ui, 'Gold'), 'plan listed');
    expect(await one<any>(`SELECT price,max_users,google_sheets,max_orders_per_month FROM plans WHERE name='Gold'`)).toMatchObject({ price: 1999, max_users: 25, google_sheets: true, max_orders_per_month: null });
    ui.click(rowOf(ui, 'Gold').querySelector('[data-x2="pedit"]')); await until(() => ui.$('#axpn'), 'edit'); ui.type('#axpp', '2499'); ui.click('#axok'); await until(() => /₹2,499/.test(rowOf(ui, 'Gold')?.textContent ?? ''), 'edited');
    ui.click(rowOf(ui, 'Gold').querySelector('[data-x2="ptog"]')); await until(() => /Activate/.test(rowOf(ui, 'Gold')?.textContent ?? ''), 'deactivated'); expect((await one<any>(`SELECT active FROM plans WHERE name='Gold'`)).active).toBe(false);
    ui.close();
  });
  it('subscriptions: plan and subscription status are changed on the server, separately from business status', async () => {
    const ui = await own(); ui.go('subs'); await until(() => ui.$('[data-x2="sp"]'), 'subs');
    const sp = rowOf(ui, 'Alpha Store').querySelector('[data-x2="sp"]'); const starter = (await one<any>(`SELECT id FROM plans WHERE name='Starter'`)).id;
    ui.select(sp, starter); await until(async () => (await one<any>(`SELECT p.name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.business_id=$1`, [W.A.id])).name === 'Starter', 'plan changed');
    await until(() => rowOf(ui, 'Alpha Store')?.querySelector('[data-x2="ss"]'), 'rerendered'); ui.select(rowOf(ui, 'Alpha Store').querySelector('[data-x2="ss"]'), 'past_due');
    await until(async () => (await one<any>(`SELECT status FROM subscriptions WHERE business_id=$1`, [W.A.id])).status === 'past_due', 'status changed');
    expect((await one<any>(`SELECT status FROM businesses WHERE id=$1`, [W.A.id])).status).toBe('active'); ui.close();
  });
  it('users & roles: each business\'s own staff only, with real per-person figures', async () => {
    const ui = await own(); ui.go('users'); await until(() => ui.$('#axub'), 'selector'); ui.select(ui.$('#axub'), W.A.id); await until(() => ui.$('#axul table'), 'staff');
    expect(ui.$('#axul').textContent).toContain('alpha.test'); expect(ui.$('#axul').textContent).not.toContain('beta.test');
    ui.select(ui.$('#axub'), W.B.id); await until(() => /beta\.test/.test(ui.$('#axul').textContent) && !/alpha\.test/.test(ui.$('#axul').textContent), 'other business');
    ui.select(ui.$('#axur'), 'delivery_partner'); await until(() => !/Manager/.test(ui.$('#axul').textContent) && /Delivery Partner/.test(ui.$('#axul').textContent), 'role filter'); ui.close();
  });
  it('rights: removing a right from a Business Admin removes it from that business\'s managers at once, and nowhere else', async () => {
    const before = await query<any>(`SELECT count(*)::int n FROM user_permissions WHERE business_id=$1 AND permission_key='reports.export'`, [W.B.id]);
    const ui = await own(); ui.go('rights'); await until(() => ui.$('#axrb'), 'selector'); ui.select(ui.$('#axrb'), W.A.id); await until(() => ui.$('[data-x2="pchk"][data-k="reports.export"]') && /Alpha Store Admin/.test(ui.$('#axra').textContent), 'matrix');
    const adminSel = ui.$('#axra'); expect(adminSel.textContent).toContain('Alpha Store Admin');
    const cb = ui.$('[data-x2="pchk"][data-k="reports.export"]'); expect(cb.checked).toBe(true); cb.checked = false; cb.dispatchEvent(new ui.w.Event('change', { bubbles: true })); ui.click('[data-x2="rsave"]');
    await until(async () => (await one<any>(`SELECT count(*)::int n FROM user_permissions WHERE user_id=$1 AND permission_key='reports.export'`, [W.A.adminId])).n === 0, 'admin right removed');
    expect(await one<any>(`SELECT count(*)::int n FROM user_permissions WHERE business_id=$1 AND permission_key='reports.export'`, [W.A.id])).toMatchObject({ n: 0 });
    expect(await one<any>(`SELECT count(*)::int n FROM user_permissions WHERE business_id=$1 AND permission_key='reports.export'`, [W.B.id])).toMatchObject(before[0]);
    expect(ui.view()).toMatch(/Custom roles and custom rights/);                             // honest about what the backend does not support yet
    const a = await openApp(base); await a.signIn('admin@alpha.test'); a.go('reports'); await until(() => a.$('#axrpc'), 'reports'); expect(a.$('[data-x2="rexp"]')).toBeNull();
    await expect(a.w.__dms.exportReport('csv')).rejects.toMatchObject({ status: 403 }); a.close(); ui.close();
  });
  it('reports: business-level rows for all businesses, filters, and server-built CSV / Excel exports', async () => {
    const ui = await own(); ui.ev('S.range=-2; S.cf="2000-01-01"; S.ct="2100-01-01"'); ui.go('reports'); await until(() => ui.$('#axoc table'), 'report');
    expect(ui.$('#axoc').textContent).toContain('Alpha Store'); expect(ui.$('#axoc').textContent).toContain('Beta Pharmacy'); expect(ui.$('#axoc').textContent).not.toMatch(/OW-A-1|Secret/);
    const csv = await (await ui.w.__dms.ownerExport('csv')).text(); expect(csv).toContain('Gross Sales'); expect(csv).toContain('Alpha Store'); expect(csv).toContain('Beta Pharmacy');
    expect(await (await ui.w.__dms.ownerExport('excel')).text()).toContain('<table');
    ui.select(ui.$('#axob'), W.A.id); await until(() => !/Beta Pharmacy/.test(ui.$('#axoc').textContent), 'single business');
    expect((await one<any>(`SELECT count(*)::int n FROM audit_logs WHERE action='report.platform_businesses'`)).n).toBeGreaterThanOrEqual(3); ui.close();
  });
  it('only the owner can use platform endpoints; modules without a backend say so honestly', async () => {
    for (const email of ['admin@alpha.test', 'mgr@alpha.test', 'p1@alpha.test']) {
      const u = await openApp(base); await u.signIn(email);
      for (const path of ['/owner/businesses', '/owner/dashboard', '/owner/plans', '/owner/reports/businesses']) await expect(u.w.__dms.api(path)).rejects.toMatchObject({ status: 403 });
      await expect(u.w.__dms.api('/owner/businesses', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 403 });
      await expect(u.w.__dms.api(`/owner/users/${W.B.adminId}/permissions`, { method: 'PUT', body: { permissions: [] } })).rejects.toMatchObject({ status: 403 }); u.close();
    }
    const ui = await own(); for (const [v, re] of [['revenue', /no backend yet/], ['support', /no backend yet/], ['sys', /no backend yet/], ['integ', /managed per business/i], ['apikeys', /managed per business/i], ['hooks', /managed per business/i]] as const) { ui.go(v); expect(ui.view()).toMatch(re); }
    expect(ui.errors.filter((e: string) => !/Could not load|Not implemented|getContext/i.test(e))).toEqual([]); ui.close();
  });
});
