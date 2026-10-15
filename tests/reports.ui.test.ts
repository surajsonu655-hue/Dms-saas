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
  const mk = async (X: World['A'], inv: string, bill: number, deliver: boolean) => {
    const o = (await X.manager.post('/api/orders', newOrder({ invoiceNumber: inv, billAmount: bill, changeAmount: 0 }))).body.data;
    if (deliver) {
      await X.manager.post(`/api/orders/${o.id}/ready`); await X.manager.post(`/api/orders/${o.id}/assign`, { partnerId: X.partnerId });
      for (const a of ['accept', 'pickup', 'start', 'arrive']) await X.partner.post(`/api/deliveries/${o.id}/${a}`, {});
      const tok = (await login(X === W.A ? 'p1@alpha.test' : 'p1@beta.test')).token;
      const pay = (await api().post('/api/files').set('Authorization', `Bearer ${tok}`).field('kind', 'payment_proof').field('orderId', o.id).attach('file', png, { filename: 'p.png', contentType: 'image/png' })).body.data.id;
      await X.partner.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: bill, paymentProofFileId: pay }); await X.manager.post(`/api/orders/${o.id}/verify`, { result: 'complete' });
    }
    return o.id as string;
  };
  (W as any).__old = await mk(W.A, "RP-A-OLD", 400, true);
  await mk(W.A, 'RP-A-1', 950, true); await mk(W.A, 'RP-A-2', 120, false); await mk(W.B, 'RP-B-1', 777, true);
  await query(`UPDATE orders SET created_at = now() - interval '20 days' WHERE id=$1`, [(W as any).__old]);
});
afterAll(async () => { server?.close(); await closeDb(); });
const rowsText = (ui: any) => (ui.$('#axrpc')?.textContent ?? '').replace(/\s+/g, ' ');

describe('Reports module (UI <-> backend)', () => {
  it('admin sees real report rows for their own business only; type, status and period filters are applied by the server', async () => {
    const ui = await openApp(base); await ui.signIn('admin@alpha.test'); expect(ui.nav()).toContain('Data & Reports'); ui.go('reports');
    await until(() => ui.$('#axrpc table'), 'report table');
    let t = rowsText(ui); expect(t).toContain('RP-A-1'); expect(t).toContain('RP-A-2'); expect(t).not.toContain('RP-B-1'); expect(t).not.toContain('RP-A-OLD');     // default period = this week
    expect([...ui.d.querySelectorAll('#axrpc th')].map((x: any) => x.textContent)).toEqual(['Date', 'Bill Number', 'Customer Name', 'Customer Address', 'Bill Amount', 'Change', 'Receivable Amount', 'Pay Mode', 'Delivery Partner', 'Assigned Time', 'Out for Delivery Time', 'Delivered Time', 'Duration', 'Return Amount', 'Final Amount', 'Status', 'Remarks']);
    ui.ev('S.range=-1; S.range=-2; S.cf="2000-01-01"; S.ct="2100-01-01"; render()'); await until(() => /RP-A-OLD/.test(rowsText(ui)), 'custom range');
    ui.select(ui.$('#axrps'), 'delivered'); await until(() => !/RP-A-2/.test(rowsText(ui)) && /RP-A-1/.test(rowsText(ui)), 'status filter');
    ui.select(ui.$('#axrps'), ''); ui.select(ui.$('#axrpt'), 'cod'); await until(() => /Expected|expected/i.test(ui.$('#axrpc').textContent) && ui.$('#axrpc table'), 'cod report');
    ui.select(ui.$('#axrpt'), 'partner_performance'); await until(() => /P1/.test(rowsText(ui)), 'partner performance');
    ui.select(ui.$('#axrpp'), W.A.partner2Id); await until(() => !/P1/.test(rowsText(ui)) || /No rows/.test(rowsText(ui)), 'partner filter');
    ui.close();
  });
  it('exports are built by the server: CSV / Excel contain only this business and respect the filters', async () => {
    const ui = await openApp(base); await ui.signIn('admin@alpha.test'); ui.go('reports'); await until(() => ui.$('#axrpc table'), 'table');
    expect(ui.$('[data-x2="rexp"][data-f="csv"]')).toBeTruthy();
    const blob = await ui.w.__dms.exportReport('csv'); const csv = await blob.text();
    expect(csv).toContain('RP-A-1'); expect(csv).not.toContain('RP-B-1'); expect(csv.split(/\r?\n/)[0]).toContain('Bill Number');
    ui.select(ui.$('#axrps'), 'delivered'); await until(() => !/RP-A-2/.test(rowsText(ui)), 'filtered');
    expect(await (await ui.w.__dms.exportReport('csv')).text()).not.toContain('RP-A-2');                // export honours the current filters
    expect(await (await ui.w.__dms.exportReport('excel')).text()).toContain('<table');
    expect(await one<any>(`SELECT count(*)::int n FROM audit_logs WHERE action='report.exported'`)).toMatchObject({ n: 3 });
    ui.close();
  });
  it('manager without reports.export gets no export buttons and the server refuses a forced export; without reports.view the page is blocked', async () => {
    const perms = (await W.A.admin.get(`/api/users/${W.A.managerId}/permissions`)).body.data.permissions as string[];
    await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: [...perms.filter(p => p !== 'reports.export'), 'reports.view'] });
    const ui = await openApp(base); await ui.signIn('mgr@alpha.test'); expect(ui.nav()).toContain('Reports'); ui.go('reports'); await until(() => ui.$('#axrpc table'), 'table');
    expect(ui.$('[data-x2="rexp"]')).toBeNull();
    await expect(ui.w.__dms.exportReport('csv')).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: perms.filter(p => p !== 'reports.view' && p !== 'reports.export') });
    const u2 = await openApp(base); await u2.signIn('mgr@alpha.test'); expect(u2.nav()).not.toContain('Reports'); u2.go('reports'); expect(u2.view()).toMatch(/Unauthorized/);
    await expect(u2.w.__dms.api('/reports/orders')).rejects.toMatchObject({ status: 403 });
    await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: perms }); ui.close(); u2.close();
  });
  it('manager report scope: "same day only" is enforced by the server and explained on screen', async () => {
    await W.A.admin.put('/api/business/settings', { managerReportScope: 'same_day' });
    const ui = await openApp(base); await ui.signIn('mgr@alpha.test'); ui.ev('S.range=-2; S.cf="2000-01-01"; S.ct="2100-01-01"'); ui.go('reports');
    await until(() => ui.$('#axrpn'), 'scope note'); expect(ui.$('#axrpn').textContent).toMatch(/same day only/);
    expect(rowsText(ui)).toContain('RP-A-1'); expect(rowsText(ui)).not.toContain('RP-A-OLD');                    // the 20-day-old order is hidden even though the UI asked for all time
    const direct = await ui.w.__dms.api('/reports/orders?from=2000-01-01&to=2100-01-01&limit=100'); expect(direct.data.rows.some((r: any) => r.includes('RP-A-OLD'))).toBe(false);
    ui.ev('S.range=-2; S.cf="2000-01-01"; S.ct="2000-12-31"'); ui.go('reports');
    await until(() => /limited to same day/i.test(ui.$('#axrpc')?.textContent ?? ''), 'scope error shown');
    await W.A.admin.put('/api/business/settings', { managerReportScope: 'complete' });
    ui.ev('S.range=-2; S.cf="2000-01-01"; S.ct="2100-01-01"'); ui.go('reports'); await until(() => /RP-A-OLD/.test(rowsText(ui)), 'full history after admin widens scope');
    ui.close();
  });
  it('Business A cannot read Business B\'s report rows, by UI or by a forced request', async () => {
    const ui = await openApp(base); await ui.signIn('admin@alpha.test');
    for (const t of ['orders', 'deliveries', 'revenue', 'cod', 'returns']) { const r = await ui.w.__dms.api(`/reports/${t}?limit=100&from=2000-01-01&to=2100-01-01`); expect(JSON.stringify(r.data)).not.toContain('RP-B-1'); }
    await expect(ui.w.__dms.api('/reports/orders?partnerId=' + W.B.partnerId)).resolves.toMatchObject({ meta: { total: 0 } });
    const b = await openApp(base); await b.signIn('admin@beta.test'); b.go('reports'); await until(() => b.$('#axrpc table'), 'B table');
    expect(rowsText(b)).toContain('RP-B-1'); expect(rowsText(b)).not.toContain('RP-A-1'); ui.close(); b.close();
  });
  it('partners and the platform owner have no reports; errors are readable', async () => {
    const p = await openApp(base); await p.signIn('p1@alpha.test'); expect(p.nav().join()).not.toMatch(/Report/); p.go('reports'); expect(p.view()).toMatch(/Unauthorized/);
    await expect(p.w.__dms.api('/reports/orders')).rejects.toMatchObject({ status: 403 });
    const o = await openApp(base); await o.signIn('owner@test.dev'); await expect(o.w.__dms.api('/reports/orders')).rejects.toMatchObject({ status: 403 });
    expect([p, o].flatMap((u: any) => u.errors.filter((e: string) => !/Could not load|Not implemented|getContext/i.test(e)))).toEqual([]); p.close(); o.close();
  });
});
