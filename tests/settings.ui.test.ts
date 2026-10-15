import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { one, query } from '../src/db.js';
import { processSheetSync, setSheetsClient, GoogleSheetsClient } from '../src/services/sheets.js';
import { api, as, buildWorld, closeDb, login, newOrder, png, type World } from './helpers.js';
import { openApp, until, sleep } from './uiHelper.js';
import { FakeGoogle } from './fakeGoogle.js';

let W: World, base = '', server: any; const G = new FakeGoogle();
const SS = 'S'.repeat(12) + 'UiSpreadsheet1';
beforeAll(async () => {
  await G.start();
  Object.assign(config.google, { clientId: 'test-client-id', clientSecret: 'test-client-secret', redirectUri: 'http://localhost/cb', driveListing: true, minIntervalMs: 0, authUrl: G.base + '/auth', tokenUrl: G.base + '/token', revokeUrl: G.base + '/revoke', userinfoUrl: G.base + '/userinfo', sheetsBase: G.base + '/sheets', driveBase: G.base + '/drive' });
  setSheetsClient(new GoogleSheetsClient());
  W = await buildWorld(); server = createApp().listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; G.addSpreadsheet(SS, 'UI Reports', ['Orders']);
});
afterAll(async () => { server?.close(); G.stop(); await closeDb(); });
const open = () => openApp(base);
const rowOf = (ui: any, t: string) => [...ui.d.querySelectorAll('#view tr')].find((r: any) => r.textContent.includes(t)) as any;
const tick = (ui: any, sel: string, v: boolean) => { const el = ui.$(sel); el.checked = v; el.dispatchEvent(new ui.w.Event('change', { bubbles: true })); };
const noise = (ui: any) => ui.errors.filter((e: string) => !/Could not load|Not implemented|getContext/i.test(e));

describe('Staff & Team', () => {
  it('lists only this business\'s people; creates, edits, deactivates, resets and deletes through the server', async () => {
    const ui = await open(); await ui.signIn('admin@alpha.test'); expect(ui.nav()).toContain('Staff & Team'); ui.go('staff'); await until(() => ui.$('#axsl table'), 'staff table');
    expect(ui.$('#axsl').textContent).toContain('alpha.test'); expect(ui.$('#axsl').textContent).not.toContain('beta.test');
    ui.click('[data-x2="snew"]'); await until(() => ui.$('#axse'), 'dialog');
    ui.select(ui.$('#axsro'), 'delivery_partner'); ui.type('#axsn', 'Rita Das'); ui.type('#axse', 'rita@alpha.test'); ui.type('#axsp', 'weakpass'); ui.type('#axsm', '9812345670'); ui.type('#axsd', 'Supervisor'); ui.click('#axok');
    await until(() => /capital letter/i.test(ui.$('#axerr').textContent), 'weak password refused by the server');
    ui.type('#axsp', 'Welcome@123'); ui.click('#axok'); await until(() => rowOf(ui, 'rita@alpha.test'), 'listed');
    expect(await one<any>(`SELECT business_id,role,designation FROM users WHERE email='rita@alpha.test'`)).toMatchObject({ business_id: W.A.id, role: 'delivery_partner', designation: 'Supervisor' });
    ui.click('[data-x2="snew"]'); await until(() => ui.$('#axse'), 'dialog 2'); ui.select(ui.$('#axsro'), 'delivery_partner'); ui.type('#axsn', 'Dup'); ui.type('#axse', 'rita@alpha.test'); ui.type('#axsp', 'Welcome@123'); ui.click('#axok'); await until(() => /already exists/i.test(ui.$('#axerr').textContent), 'duplicate'); ui.click('#dlg button[value="x"]');
    ui.click(rowOf(ui, 'rita@alpha.test').querySelector('[data-x2="sedit"]')); await until(() => ui.$('#axsn'), 'edit'); ui.type('#axsd', 'Team Leader'); ui.click('#axok'); await until(() => /Team Leader/.test(rowOf(ui, 'rita@alpha.test')?.textContent ?? ''), 'edited');
    const rl = await login('rita@alpha.test', 'Welcome@123'); expect(rl.res.status).toBe(200);
    ui.click(rowOf(ui, 'rita@alpha.test').querySelector('[data-x2="spw"]')); await until(() => ui.$('#axnp'), 'reset dialog'); ui.type('#axnp', 'Another@123'); ui.click('#axok'); await until(async () => (await login('rita@alpha.test', 'Another@123')).res.status === 200, 'new password works');
    expect((await login('rita@alpha.test', 'Welcome@123')).res.status).toBe(401);
    ui.click(rowOf(ui, 'rita@alpha.test').querySelector('[data-x2="stog"]')); await until(() => /inactive/.test(rowOf(ui, 'rita@alpha.test')?.textContent ?? ''), 'deactivated'); expect((await login('rita@alpha.test', 'Another@123')).res.status).toBe(403);
    ui.click(rowOf(ui, 'rita@alpha.test').querySelector('[data-x2="sdel"]')); await until(() => ui.$('#cy'), 'confirm'); ui.click('#cy'); await until(() => !rowOf(ui, 'rita@alpha.test'), 'deleted');
    expect(await one<any>(`SELECT deleted_at IS NOT NULL AS gone FROM users WHERE email='rita@alpha.test'`)).toMatchObject({ gone: true });
    expect(noise(ui)).toEqual([]); ui.close();
  });
  it('manager rights: only rights the admin holds are offered, the server refuses anything else, and revocations apply at once', async () => {
    const adminPerms = (await W.owner.get(`/api/owner/users/${W.A.adminId}/permissions`)).body.data.permissions as string[];
    await W.owner.put(`/api/owner/users/${W.A.adminId}/permissions`, { permissions: adminPerms.filter(p => p !== 'reports.export') });
    const ui = await open(); await ui.signIn('admin@alpha.test'); ui.go('staff'); await until(() => ui.$('#axsl table'), 'table');
    ui.click(rowOf(ui, 'mgr@alpha.test').querySelector('[data-x2="srights"]')); await until(() => ui.$('.axpm'), 'rights dialog');
    const offered = [...ui.d.querySelectorAll('.axpm')].map((c: any) => c.value); expect(offered).toContain('orders.view'); expect(offered).not.toContain('reports.export'); expect(offered).not.toContain('permissions.manage');
    for (const c of ui.d.querySelectorAll('.axpm')) (c as any).checked = ['orders.view', 'reports.view'].includes((c as any).value);
    ui.click('#axok'); await until(async () => (await one<any>(`SELECT count(*)::int n FROM user_permissions WHERE user_id=$1`, [W.A.managerId])).n === 2, 'rights saved');
    await expect(ui.w.__dms.api(`/users/${W.A.managerId}/permissions`, { method: 'PUT', body: { permissions: ['reports.export'] } })).rejects.toMatchObject({ status: 403, code: 'PERMISSION_NOT_HELD' });
    const m = await open(); await m.signIn('mgr@alpha.test'); expect(m.nav()).not.toContain('Staff & Team'); expect(m.nav()).not.toContain('COD');
    await expect(m.w.__dms.api('/users')).rejects.toMatchObject({ status: 403 });
    await W.owner.put(`/api/owner/users/${W.A.adminId}/permissions`, { permissions: adminPerms });
    await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: ['orders.view', 'orders.create', 'orders.edit', 'deliveries.view', 'deliveries.assign', 'deliveries.reassign', 'deliveries.update', 'deliveries.verify', 'customers.view', 'cod.view', 'returns.view', 'returns.manage', 'reports.view'] });
    ui.close(); m.close();
  });
  it('Business A cannot see or change Business B\'s staff', async () => {
    const ui = await open(); await ui.signIn('admin@alpha.test');
    for (const call of [() => ui.w.__dms.api('/users/' + W.B.partnerId), () => ui.w.__dms.api('/users/' + W.B.partnerId, { method: 'PATCH', body: { name: 'Hacked' } }), () => ui.w.__dms.api('/users/' + W.B.managerId + '/reset-password', { method: 'POST', body: { newPassword: 'Hacked@123' } }), () => ui.w.__dms.api('/users/' + W.B.partnerId, { method: 'DELETE' })]) await expect(call()).rejects.toMatchObject({ status: 404 });
    expect((await one<any>(`SELECT name FROM users WHERE id=$1`, [W.B.partnerId])).name).toBe('P1'); ui.close();
  });
});

describe('Settings', () => {
  it('business details: validation comes from the server, a valid save updates the database and the header, logo uploads', async () => {
    const ui = await open(); await ui.signIn('admin@alpha.test'); ui.go('settings'); await until(() => ui.$('#axb_name'), 'business tab');
    ui.type('#axb_phone', '12'); ui.click('[data-x2="bsave"]'); await until(() => /Mobile|digits/i.test(ui.$('#axbe').textContent), 'bad phone refused');
    ui.type('#axb_phone', '9876543210'); ui.type('#axb_name', 'Alpha Store Ltd'); ui.file('#axblogo'); ui.click('[data-x2="bsave"]');
    await until(() => /Alpha Store Ltd/.test(ui.$('#title').textContent), 'header updated');
    expect(await one<any>(`SELECT name,phone,logo_key FROM businesses WHERE id=$1`, [W.A.id])).toMatchObject({ name: 'Alpha Store Ltd', phone: '9876543210' });
    expect((await one<any>(`SELECT logo_key FROM businesses WHERE id=$1`, [W.A.id])).logo_key).toBeTruthy();
    expect((await one<any>(`SELECT name FROM businesses WHERE id=$1`, [W.B.id])).name).toBe('Beta Pharmacy'); ui.close();
  });
  it('delivery rules are saved on the server and actually change behaviour (OTP is demanded at delivery)', async () => {
    const ui = await open(); await ui.signIn('admin@alpha.test'); ui.go('settings'); await until(() => ui.$('[data-x2="stab"][data-t2="ops"]'), 'tabs'); ui.click('[data-x2="stab"][data-t2="ops"]'); await until(() => ui.$('#axf_otpRequired'), 'ops tab');
    ui.type('#axf_paymentModes', 'cod, bitcoin!'); ui.click('[data-x2="osv"]'); await until(() => /Invalid|payment/i.test(ui.$('#axfe').textContent), 'bad mode refused');
    ui.type('#axf_paymentModes', 'cod, upi, card'); tick(ui, '#axf_otpRequired', true); ui.select(ui.$('#axf_managerReportScope'), 'weekly'); ui.click('[data-x2="osv"]');
    await until(async () => (await one<any>(`SELECT otp_required,manager_report_scope,payment_modes FROM business_settings WHERE business_id=$1`, [W.A.id])).otp_required === true, 'saved');
    expect(await one<any>(`SELECT manager_report_scope,payment_modes FROM business_settings WHERE business_id=$1`, [W.A.id])).toMatchObject({ manager_report_scope: 'weekly', payment_modes: ['cod', 'upi', 'card'] });
    const o = (await W.A.manager.post('/api/orders', newOrder({ billAmount: 100, changeAmount: 0 }))).body.data; expect(o.otp_for_testing ?? o.otp_hash === undefined).toBeTruthy();
    expect((await W.A.manager.post('/api/orders', newOrder({ paymentMode: 'prepaid' }))).status).toBe(400);           // 'prepaid' was removed from this business's modes
    await W.A.admin.put('/api/business/settings', { otpRequired: false, managerReportScope: 'complete', paymentModes: ['cod', 'prepaid', 'upi', 'card', 'other'] });
    ui.click('[data-x2="stab"][data-t2="sub"]'); await until(() => /Plan/.test(ui.$('#axtab').textContent) && /Pro/.test(ui.$('#axtab').textContent), 'subscription'); ui.close();
  });
  it('a user without settings.manage sees read-only fields and the server refuses forced changes; managers and partners get no settings editor', async () => {
    const perms = (await W.A.admin.get(`/api/users/${W.A.managerId}/permissions`)).body.data.permissions as string[];
    const m = await open(); await m.signIn('mgr@alpha.test'); m.go('settings'); await until(() => /Your rights/.test(m.view()), 'rights summary'); expect(m.$('[data-x2="bsave"]')).toBeNull();
    await expect(m.w.__dms.api('/business', { method: 'PATCH', body: { name: 'X' } })).rejects.toMatchObject({ status: 403 }); await expect(m.w.__dms.api('/business/settings', { method: 'PUT', body: { otpRequired: true } })).rejects.toMatchObject({ status: 403 });
    const p = await open(); await p.signIn('p1@alpha.test'); expect(p.nav().join()).not.toMatch(/Settings/); p.go('settings'); expect(p.view()).toMatch(/Unauthorized/); await expect(p.w.__dms.api('/business/settings')).rejects.toMatchObject({ status: 403 });
    expect(perms.length).toBeGreaterThan(0); m.close(); p.close();
  });
});

describe('API keys and webhooks', () => {
  it('API key: secret shown once, works for its scopes only, revocable', async () => {
    const ui = await open(); await ui.signIn('admin@alpha.test'); ui.go('settings'); await until(() => ui.$('[data-x2="stab"][data-t2="keys"]'), 'tabs'); ui.click('[data-x2="stab"][data-t2="keys"]'); await until(() => ui.$('[data-x2="knew"]'), 'keys tab');
    ui.click('[data-x2="knew"]'); await until(() => ui.$('#axkn'), 'dialog'); ui.click('#axok'); await until(() => /name/i.test(ui.$('#axerr').textContent), 'name required');
    ui.type('#axkn', 'ERP'); ui.click('#axok'); await until(() => /name|scope/i.test(ui.$('#axerr').textContent), 'scope required');
    for (const sc of ['orders.create', 'orders.view']) (ui.d.querySelector(`.axks[value="${sc}"]`) as any).checked = true; ui.click('#axok');
    await until(() => ui.$('#dlg input[readonly]'), 'secret dialog'); const secret = ui.$('#dlg input[readonly]').value; expect(secret).toMatch(/^dms_live_/);
    ui.click('#dlg button[value="x"]'); await until(() => /ERP/.test(ui.$('#axtab').textContent), 'listed'); expect(ui.view()).not.toContain(secret);
    expect(await one<any>(`SELECT key_hash FROM api_keys WHERE name='ERP'`)).not.toMatchObject({ key_hash: secret });
    const r = await api().post('/api/orders').set('x-api-key', secret).send(newOrder({ invoiceNumber: 'KEY-1' })); expect(r.status).toBe(201); expect(r.body.data.business_id).toBe(W.A.id);
    expect((await api().get('/api/customers').set('x-api-key', secret)).status).toBe(403);
    ui.click(rowOf(ui, 'ERP').querySelector('[data-x2="krev"]')); await until(() => ui.$('#cy'), 'confirm'); ui.click('#cy'); await until(async () => (await api().get('/api/orders').set('x-api-key', secret)).status === 401, 'revoked'); ui.close();
  });
  it('webhook: created with a one-time secret, test delivery is signed, can be paused and deleted', async () => {
    const got: any[] = []; const srv = http.createServer((q, r) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { got.push({ h: q.headers, b }); r.statusCode = 200; r.end('ok'); }); }); await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`;
    const ui = await open(); await ui.signIn('admin@alpha.test'); ui.go('settings'); await until(() => ui.$('[data-x2="stab"][data-t2="hooks"]'), 'tabs'); ui.click('[data-x2="stab"][data-t2="hooks"]'); await until(() => ui.$('[data-x2="hnew"]'), 'hooks tab');
    ui.click('[data-x2="hnew"]'); await until(() => ui.$('#axhu'), 'dialog'); ui.type('#axhu', 'not a url'); ui.click('#axok'); await until(() => /valid URL/i.test(ui.$('#axerr').textContent), 'url validation');
    ui.type('#axhu', url); ui.click('#axok'); await until(() => ui.$('#dlg input[readonly]'), 'secret'); const secret = ui.$('#dlg input[readonly]').value; ui.click('#dlg button[value="x"]');
    await until(() => rowOf(ui, '127.0.0.1'), 'listed'); expect(ui.view()).not.toContain(secret);
    ui.click(rowOf(ui, '127.0.0.1').querySelector('[data-x2="htest"]')); await until(() => got.length === 1, 'test delivery received');
    const sig = String(got[0].h['x-dms-signature']), [ts, v1] = sig.split(',').map(p => p.split('=')[1]); expect(v1).toBe(createHmac('sha256', secret).update(`${ts}.${got[0].b}`).digest('hex'));
    ui.click(rowOf(ui, '127.0.0.1').querySelector('[data-x2="htog"]')); await until(() => /Paused/.test(rowOf(ui, '127.0.0.1')?.textContent ?? ''), 'paused');
    ui.click(rowOf(ui, '127.0.0.1').querySelector('[data-x2="hdel"]')); await until(() => ui.$('#cy'), 'confirm'); ui.click('#cy'); await until(() => !rowOf(ui, '127.0.0.1'), 'deleted'); srv.close(); ui.close();
  });
  it('managers and partners cannot reach API keys / webhooks', async () => {
    const m = await open(); await m.signIn('mgr@alpha.test'); for (const pth of ['/api-keys', '/webhooks']) await expect(m.w.__dms.api(pth)).rejects.toMatchObject({ status: 403 });
    const p = await open(); await p.signIn('p1@alpha.test'); for (const pth of ['/api-keys', '/webhooks', '/integrations/google']) await expect(p.w.__dms.api(pth)).rejects.toMatchObject({ status: 403 }); m.close(); p.close();
  });
});

describe('Google Sheets screen (against a local imitation of Google)', () => {
  const oauth = async (admin: ReturnType<typeof as>) => { const u = (await admin.get('/api/integrations/google/auth-url')).body.data.url as string; const st = new URL(u).searchParams.get('state')!; return api().get(`/api/integrations/google/callback?code=good-code&state=${st}`); };
  it('connect -> choose spreadsheet and worksheet -> test -> enable auto sync -> order lands in the same row, no duplicates', async () => {
    const ui = await open(); await ui.signIn('admin@alpha.test'); ui.go('settings'); await until(() => ui.$('[data-x2="stab"][data-t2="google"]'), 'tabs'); ui.click('[data-x2="stab"][data-t2="google"]');
    await until(() => ui.$('[data-x2="gconnect"]'), 'connect button'); expect(ui.$('#axtab').textContent).toMatch(/No Google account is connected/);
    expect((await oauth(W.A.admin)).status).toBe(302);
    ui.go('settings'); ui.click('[data-x2="stab"][data-t2="google"]'); await until(() => /owner@gmail\.test/.test(ui.$('#axtab')?.textContent ?? ''), 'connected account shown');
    expect(ui.view()).not.toMatch(/rt-secret|access_token|refresh_token|test-client-secret/);
    ui.click('[data-x2="gpick"]'); await until(() => ui.$('#axgsel'), 'spreadsheet list'); ui.select(ui.$('#axgsel'), SS); await until(() => ui.$('#axgtab'), 'worksheets'); ui.click('[data-x2="gsel"]');
    await until(() => G.tab(SS, 'Orders').rows[0]?.length === 17 && ui.$('[data-x2="gtest"]'), 'worksheet selected and header written'); expect(G.tab(SS, 'Orders').rows[0]).toHaveLength(17); expect(G.tab(SS, 'Orders').rows[0][0]).toBe('Date');
    ui.click('[data-x2="gtest"]'); await until(() => /Google Sheet Connected/.test(ui.$('#axgmsg')?.textContent ?? ui.view()), 'test connection ok');
    ui.click('[data-x2="gon"]'); await until(() => ui.$('input[name=axim]'), 'initial sync choice'); ui.click('input[name=axim][value="new_only"]'); ui.click('#axok'); await until(() => ui.$('[data-x2="goff"]'), 'auto sync enabled');
    const o = (await W.A.manager.post('/api/orders', newOrder({ invoiceNumber: 'SHEET-UI-1' }))).body.data; await W.A.manager.post(`/api/orders/${o.id}/ready`); await W.A.manager.post(`/api/orders/${o.id}/assign`, { partnerId: W.A.partnerId });
    await processSheetSync(50); const rows = G.tab(SS, 'Orders').rows.filter(r => r[1] === 'SHEET-UI-1'); expect(rows).toHaveLength(1); expect(rows[0][8]).toBe('P1'); expect(rows[0][15]).toBe('Assigned');
    ui.click('[data-x2="gsync"]'); await until(() => /records synchronized/.test(ui.$('#axgmsg')?.textContent ?? ''), 'sync now result'); expect(G.tab(SS, 'Orders').rows.filter(r => r[1] === 'SHEET-UI-1')).toHaveLength(1);
    ui.click('[data-x2="goff"]'); await until(() => ui.$('[data-x2="gon"]'), 'disabled'); expect(noise(ui)).toEqual([]); ui.close();
  });
  it('other businesses and low-rights users: B never sees A\'s sheet, a view-only manager gets no action buttons, a partner is refused, disconnect wipes access', async () => {
    const b = await open(); await b.signIn('admin@beta.test'); b.go('settings'); b.click('[data-x2="stab"][data-t2="google"]'); await until(() => b.$('[data-x2="gconnect"]'), 'B not connected'); expect(b.view()).not.toContain('UI Reports'); expect(b.view()).not.toContain('owner@gmail.test');
    const base0 = (await W.A.admin.get(`/api/users/${W.A.managerId}/permissions`)).body.data.permissions as string[];
    await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: [...base0, 'integrations.view'] });
    const m = await open(); await m.signIn('mgr@alpha.test'); expect(m.nav()).toContain('Google Sheets'); m.go('sheets'); await until(() => /Connected account/.test(m.view()), 'status visible');
    for (const a of ['gconnect', 'gtest', 'gon', 'goff', 'gsync', 'gpick', 'gdisc']) expect(m.$(`[data-x2="${a}"]`)).toBeNull();
    await expect(m.w.__dms.api('/integrations/google/sync', { method: 'POST' })).rejects.toMatchObject({ status: 403 }); expect(JSON.stringify((await m.w.__dms.api('/integrations/google')).data)).not.toMatch(/refresh_token|access_token|rt-secret|client_secret|"at-\d/i);
    const p = await open(); await p.signIn('p1@alpha.test'); await expect(p.w.__dms.api('/integrations/google')).rejects.toMatchObject({ status: 403 });
    await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: base0 });
    const ui = await open(); await ui.signIn('admin@alpha.test'); ui.go('settings'); ui.click('[data-x2="stab"][data-t2="google"]'); await until(() => ui.$('[data-x2="gdisc"]'), 'disconnect button'); ui.click('[data-x2="gdisc"]'); await until(() => ui.$('#cy'), 'confirm'); ui.click('#cy');
    await until(() => ui.$('[data-x2="gconnect"]') && /No Google account/.test(ui.$('#axtab').textContent), 'disconnected');
    expect(await one<any>(`SELECT refresh_token_enc,sync_enabled FROM google_sheet_connections WHERE business_id=$1`, [W.A.id])).toMatchObject({ refresh_token_enc: null, sync_enabled: false });
    expect((await one<any>(`SELECT status FROM google_sheet_connections WHERE business_id=$1`, [W.B.id])) ?? { status: 'none' }).not.toMatchObject({ status: 'active' }); [b, m, p, ui].forEach((u: any) => u.close());
  });
});

describe('Notifications', () => {
  it('each person sees only their own notifications; the bell counts unread; reading updates both', async () => {
    const o = (await W.A.manager.post('/api/orders', newOrder({ invoiceNumber: 'NOTE-1' }))).body.data; await W.A.manager.post(`/api/orders/${o.id}/ready`); await W.A.manager.post(`/api/orders/${o.id}/assign`, { partnerId: W.A.partner2Id });
    const p = await open(); await p.signIn('p2@alpha.test'); await until(() => /1|2|3/.test(p.$('#bc').textContent), 'bell shows unread'); const n0 = Number(p.$('#bc').textContent);
    p.click('#bell'); await until(() => /New delivery|Delivery/.test(p.view()), 'list'); expect(p.view()).toContain('NOTE-1'); expect(p.view()).not.toMatch(/HOOK|SHEET-UI/);
    p.click(p.d.querySelector('[data-x2="nrd"]')); await until(() => Number(p.$('#bc').textContent || 0) < n0, 'count decreased');
    p.click('[data-x2="nread"]'); await until(() => !p.$('#bc').textContent, 'all read'); expect((await one<any>(`SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND status='unread'`, [W.A.partner2Id])).n).toBe(0);
    const b = await open(); await b.signIn('mgr@beta.test'); b.go('notif'); await until(() => /notifications/.test(b.view()), 'B list'); expect(b.view()).not.toContain('NOTE-1');
    const own = await open(); await own.signIn('owner@test.dev'); own.go('notif'); expect(own.view()).toMatch(/Not connected|not connected|not available/i); p.close(); b.close(); own.close(); await sleep(1);
  });
});
