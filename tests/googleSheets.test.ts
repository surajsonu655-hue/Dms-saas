import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, as, buildWorld, closeDb, login, newOrder, png, type World } from './helpers.js';
import { config } from '../src/config.js';
import { one, query } from '../src/db.js';
import { processSheetSync, setSheetsClient, GoogleSheetsClient, SHEET_COLUMNS } from '../src/services/sheets.js';
import { FakeGoogle } from './fakeGoogle.js';

const G = new FakeGoogle(); let W: World;
const SS_A = 'A'.repeat(12) + 'SpreadsheetA1', SS_B = 'B'.repeat(12) + 'SpreadsheetB1';
const EXPECTED = ['Date', 'Bill Number', 'Customer Name', 'Customer Address', 'Bill Amount', 'Change', 'Receivable Amount', 'Pay Mode', 'Delivery Partner', 'Assigned Time', 'Out for Delivery Time', 'Delivered Time', 'Duration', 'Return Amount', 'Final Amount', 'Status', 'Remarks'];
const tokFor = async (email: string) => (await login(email)).token;
const up = async (email: string, kind: string, orderId: string) => (await api().post('/api/files').set('Authorization', `Bearer ${await tokFor(email)}`).field('kind', kind).field('orderId', orderId).attach('file', png, { filename: 'p.png', contentType: 'image/png' })).body.data.id as string;

async function connect(admin: ReturnType<typeof as>, code = 'good-code') {
  const url = (await admin.get('/api/integrations/google/auth-url')).body.data.url as string;
  const state = new URL(url).searchParams.get('state')!;
  const cb = await api().get(`/api/integrations/google/callback?code=${code}&state=${state}`);
  return { url, state, cb };
}
const rowsOf = (ss: string, tab = 'Orders') => G.tab(ss, tab).rows;

beforeAll(async () => {
  await G.start();
  Object.assign(config.google, { clientId: 'test-client-id', clientSecret: 'test-client-secret', redirectUri: 'http://localhost:3000/api/auth/callback/google', driveListing: true, minIntervalMs: 0,
    authUrl: G.base + '/auth', tokenUrl: G.base + '/token', revokeUrl: G.base + '/revoke', userinfoUrl: G.base + '/userinfo', sheetsBase: G.base + '/sheets', driveBase: G.base + '/drive' });
  setSheetsClient(new GoogleSheetsClient());                 // the REAL HTTP client, pointed at the local fake Google
  W = await buildWorld();
  G.addSpreadsheet(SS_A, 'Business A Reports', ['Orders', 'Notes']); G.addSpreadsheet(SS_B, 'Business B Reports', ['Orders']);
});
afterAll(async () => { G.stop(); await closeDb(); });

describe('Google Sheets - connect, select, test, enable (Business A)', () => {
  it('not connected at first; OAuth URL uses backend credentials, minimum scopes, offline access and a single-use state', async () => {
    const s = (await W.A.admin.get('/api/integrations/google')).body.data;
    expect(s.configuredOnServer).toBe(true); expect(s.connection).toBeNull();
    const url = new URL((await W.A.admin.get('/api/integrations/google/auth-url')).body.data.url);
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/callback/google');
    expect(url.searchParams.get('access_type')).toBe('offline');
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes).toContain('https://www.googleapis.com/auth/spreadsheets');
    expect(scopes.every(x => /spreadsheets$|drive\.metadata\.readonly$|userinfo\.email$/.test(x))).toBe(true);   // nothing broader than needed
    expect(url.toString()).not.toContain('test-client-secret');
  });
  it('callback exchanges the code server-side, stores tokens ENCRYPTED, and never returns them', async () => {
    const { cb, state } = await connect(W.A.admin);
    expect(cb.status).toBe(302); expect(cb.headers.location).toContain('google=connected');
    const row = await one<any>(`SELECT * FROM google_sheet_connections WHERE business_id=$1`, [W.A.id]);
    expect(row.google_email).toBe('owner@gmail.test');
    expect(row.refresh_token_enc).toBeTruthy(); expect(row.refresh_token_enc).not.toContain('rt-secret-value'); expect(row.access_token_enc).not.toContain('at-');
    const body = JSON.stringify((await W.A.admin.get('/api/integrations/google')).body);
    expect(body).not.toMatch(/rt-secret-value|refresh_token|access_token|test-client-secret/);
    expect(JSON.parse(body).data.connection).toMatchObject({ googleEmail: 'owner@gmail.test', hasTokens: true, status: 'pending', syncEnabled: false });
    // state is single-use (CSRF protection): replaying it fails
    const replay = await api().get(`/api/integrations/google/callback?code=good-code&state=${state}`);
    expect(replay.headers.location).toContain('google=error');
    // a made-up state is rejected
    expect((await api().get(`/api/integrations/google/callback?code=good-code&state=${'z'.repeat(40)}`)).headers.location).toContain('google=error');
  });
  it('lists accessible spreadsheets and worksheets', async () => {
    const l = (await W.A.admin.get('/api/integrations/google/spreadsheets')).body.data;
    expect(l.map((x: any) => x.id)).toEqual(expect.arrayContaining([SS_A]));
    const t = (await W.A.admin.get(`/api/integrations/google/spreadsheets/${SS_A}/sheets`)).body.data;
    expect(t.title).toBe('Business A Reports'); expect(t.sheets.map((s: any) => s.title)).toEqual(['Orders', 'Notes']);
  });
  it('selecting an empty worksheet creates EXACTLY the 17 required headers, in order', async () => {
    const r = await W.A.admin.put('/api/integrations/google/sheet', { spreadsheetId: SS_A, sheetName: 'Orders' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(rowsOf(SS_A)[0]).toEqual(EXPECTED);
    expect([...SHEET_COLUMNS]).toEqual(EXPECTED);
  });
  it('rejects a missing worksheet, and a worksheet that already holds different headers', async () => {
    expect((await W.A.admin.put('/api/integrations/google/sheet', { spreadsheetId: SS_A, sheetName: 'Nope' })).body.code).toBe('WORKSHEET_MISSING');
    G.tab(SS_A, 'Notes').rows.push(['Some', 'other', 'data']);
    const bad = await W.A.admin.put('/api/integrations/google/sheet', { spreadsheetId: SS_A, sheetName: 'Notes' });
    expect(bad.status).toBe(409); expect(bad.body.code).toBe('HEADER_MISMATCH');
    expect(G.tab(SS_A, 'Notes').rows[0]).toEqual(['Some', 'other', 'data']);       // the user's data was not touched
    expect((await W.A.admin.put('/api/integrations/google/sheet', { spreadsheetId: SS_A, sheetName: 'Orders' })).status).toBe(200);
  });
  it('Test Connection works; Enable Auto Sync demands the initial-sync choice', async () => {
    const t = await W.A.admin.post('/api/integrations/google/test');
    expect(t.body.data).toMatchObject({ connected: true, spreadsheet: 'Business A Reports', worksheet: 'Orders' });
    const no = await W.A.admin.post('/api/integrations/google/auto-sync', { enabled: true });
    expect(no.status).toBe(400); expect(no.body.code).toBe('INITIAL_SYNC_CHOICE_REQUIRED');
    const yes = await W.A.admin.post('/api/integrations/google/auto-sync', { enabled: true, initialSync: 'new_only' });
    expect(yes.body.data).toMatchObject({ syncEnabled: true, queued: 0 });
  });
});

describe('Google Sheets - order lifecycle updates the SAME row', () => {
  it('create -> assign -> out for delivery -> delivered: one row, times from backend events, duration computed', async () => {
    const o = (await W.A.manager.post('/api/orders', newOrder({ invoiceNumber: 'INV-1001', billAmount: 950, changeAmount: 50, customerName: 'Anita Rao', customerAddress: '5 Lake View' }))).body.data;
    await processSheetSync(50);
    let rows = rowsOf(SS_A); expect(rows).toHaveLength(2);
    expect(rows[1].slice(0, 8)).toEqual(['' + rows[1][0], 'INV-1001', 'Anita Rao', '5 Lake View', '950', '50', '1000', 'COD']);
    expect(rows[1][9]).toBe(''); expect(rows[1][15]).toBe('Created');

    await W.A.manager.post(`/api/orders/${o.id}/ready`);
    expect((await W.A.manager.post(`/api/orders/${o.id}/assign`, { partnerId: W.A.partnerId })).status).toBe(200);
    await processSheetSync(50);
    rows = rowsOf(SS_A); expect(rows).toHaveLength(2);                      // still ONE order row
    expect(rows[1][8]).toBe('P1'); expect(rows[1][9]).toMatch(/\d{2} \w{3} \d{4}, \d{2}:\d{2} (AM|PM)/);
    expect(rows[1][10]).toBe(''); expect(rows[1][11]).toBe(''); expect(rows[1][15]).toBe('Assigned');
    const assignedCell = rows[1][9];

    // move the real event timestamps so the duration is deterministic: assigned 10:05, out 10:18, delivered 10:38 (Asia/Kolkata)
    await W.A.partner.post(`/api/deliveries/${o.id}/accept`); await W.A.partner.post(`/api/deliveries/${o.id}/pickup`);
    await W.A.partner.post(`/api/deliveries/${o.id}/start`);
    await processSheetSync(50);
    rows = rowsOf(SS_A); expect(rows).toHaveLength(2);
    expect(rows[1][9]).toBe(assignedCell); expect(rows[1][10]).not.toBe(''); expect(rows[1][11]).toBe(''); expect(rows[1][15]).toBe('Out for Delivery');

    await W.A.partner.post(`/api/deliveries/${o.id}/arrive`);
    const pay = await up('p1@alpha.test', 'payment_proof', o.id);
    expect((await W.A.partner.post(`/api/deliveries/${o.id}/deliver`, { customerPaid: 1000, paymentProofFileId: pay })).status).toBe(200);
    await query(`UPDATE delivery_assignments SET assigned_at = (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '10 hours 5 minutes') AT TIME ZONE 'Asia/Kolkata' WHERE order_id=$1`, [o.id]);
    await query(`UPDATE deliveries SET out_for_delivery_at = (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '10 hours 18 minutes') AT TIME ZONE 'Asia/Kolkata', completed_at = (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '10 hours 38 minutes') AT TIME ZONE 'Asia/Kolkata' WHERE order_id=$1`, [o.id]);
    await query(`UPDATE google_sheet_sync_logs SET sync_status='success' WHERE order_id=$1`, [o.id]);
    await W.A.manager.post(`/api/orders/${o.id}/verify`, { result: 'complete', remarks: '' });     // triggers a sync job
    await processSheetSync(50);
    rows = rowsOf(SS_A); expect(rows).toHaveLength(2);                      // STILL one row
    expect(rows[1][9]).toMatch(/10:05 AM$/); expect(rows[1][10]).toMatch(/10:18 AM$/); expect(rows[1][11]).toMatch(/10:38 AM$/);
    expect(rows[1][12]).toBe('33 minutes');                                  // Delivered - Assigned
    expect(rows[1][13]).toBe('0'); expect(rows[1][14]).toBe('1000'); expect(rows[1][15]).toBe('Delivered');
  });
  it('partial delivery: Return Amount and Final Amount follow the DMS calculation (1000 - 200 = 800)', async () => {
    const o = (await W.A.manager.post('/api/orders', newOrder({ invoiceNumber: 'INV-1002', billAmount: 1000, changeAmount: 0 }))).body.data;
    await W.A.manager.post(`/api/orders/${o.id}/ready`);
    // P1's previous order is already verified, so the partner is free again
    await W.A.manager.post(`/api/orders/${o.id}/assign`, { partnerId: W.A.partnerId });
    for (const a of ['accept', 'pickup', 'start', 'arrive']) await W.A.partner.post(`/api/deliveries/${o.id}/${a}`);
    const pay = await up('p1@alpha.test', 'payment_proof', o.id), ret = await up('p1@alpha.test', 'return_photo', o.id);
    const r = await W.A.partner.post(`/api/deliveries/${o.id}/partial`, { returnedAmount: 200, reason: 'Damaged', customerPaid: 800, paymentProofFileId: pay, returnPhotoFileId: ret });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await processSheetSync(50);
    const rows = rowsOf(SS_A); const row = rows.find(x => x[1] === 'INV-1002')!;
    expect(rows.filter(x => x[1] === 'INV-1002')).toHaveLength(1);
    expect(row[13]).toBe('200'); expect(row[14]).toBe('800'); expect(row[15]).toBe('Partial Delivered'); expect(row[16]).toMatch(/Damaged/);
    await W.A.manager.post(`/api/orders/${o.id}/verify`, { result: 'complete' });
  });
  it('failed and returned orders sync too, each in a single row', async () => {
    const o = (await W.A.manager.post('/api/orders', newOrder({ invoiceNumber: 'INV-1003' }))).body.data;
    await W.A.manager.post(`/api/orders/${o.id}/ready`); await W.A.manager.post(`/api/orders/${o.id}/assign`, { partnerId: W.A.partner2Id });
    for (const a of ['accept', 'pickup', 'start', 'arrive']) await W.A.partner2.post(`/api/deliveries/${o.id}/${a}`);
    await W.A.partner2.post(`/api/deliveries/${o.id}/fail`, { reason: 'Customer unavailable' });
    await processSheetSync(50);
    const rows = rowsOf(SS_A).filter(x => x[1] === 'INV-1003');
    expect(rows).toHaveLength(1); expect(rows[0][15]).toBe('Failed'); expect(rows[0][16]).toMatch(/Customer unavailable/);
  });
  it('duplicate Bill Numbers in a sheet never confuse the sync: rows are matched by internal order id', async () => {
    const m = await one<any>(`SELECT count(*)::int n, count(DISTINCT order_id)::int d FROM google_sheet_rows WHERE business_id=$1`, [W.A.id]);
    expect(m.n).toBe(m.d);
    expect(m.n).toBe(rowsOf(SS_A).length - 1);
  });
});

describe('Google Sheets - resilience and errors', () => {
  it('Google down: the order is still saved, job stays pending, retry succeeds, no duplicate row', async () => {
    G.mode = 'down';
    const r = await W.A.manager.post('/api/orders', newOrder({ invoiceNumber: 'INV-2001' }));
    expect(r.status).toBe(201);
    const id = r.body.data.id;
    const run = await processSheetSync(50);
    expect(run.retrying + run.failed).toBeGreaterThan(0);
    expect(rowsOf(SS_A).some(x => x[1] === 'INV-2001')).toBe(false);
    const st = (await W.A.admin.get('/api/integrations/google')).body.data.connection;
    expect(st.syncStatus).toBe('error'); expect(st.lastError).toMatch(/temporarily unavailable/i);
    expect(st.lastError).not.toMatch(/rt-secret|at-\d|Bearer/);
    G.mode = 'ok'; await query(`UPDATE google_sheet_sync_logs SET next_attempt_at=now() WHERE order_id=$1 AND sync_status='pending'`, [id]);
    await processSheetSync(50); await processSheetSync(50);
    expect(rowsOf(SS_A).filter(x => x[1] === 'INV-2001')).toHaveLength(1);
  });
  it('rate limit is retried later (not failed permanently)', async () => {
    G.mode = 'ratelimit';
    const id = (await W.A.manager.post('/api/orders', newOrder({ invoiceNumber: 'INV-2002' }))).body.data.id;
    const run = await processSheetSync(50); expect(run.retrying).toBeGreaterThan(0);
    const j = await one<any>(`SELECT sync_status,error_message FROM google_sheet_sync_logs WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1`, [id]);
    expect(j.sync_status).toBe('pending'); expect(j.error_message).toMatch(/rate limiting/i);
    G.mode = 'ok'; await query(`UPDATE google_sheet_sync_logs SET next_attempt_at=now()`);
    await processSheetSync(50);
  });
  it('an expired access token is refreshed with the stored refresh token', async () => {
    await query(`UPDATE google_sheet_connections SET token_expires_at = now() - interval '1 hour' WHERE business_id=$1`, [W.A.id]);
    const before = G.tokenCalls.filter(g => g === 'refresh_token').length;
    expect((await W.A.admin.post('/api/integrations/google/test')).status).toBe(200);
    expect(G.tokenCalls.filter(g => g === 'refresh_token').length).toBe(before + 1);
  });
  it('Sync Now reports how many records were synchronized / failed and does not duplicate rows', async () => {
    const before = rowsOf(SS_A).length;
    const r = await W.A.admin.post('/api/integrations/google/sync');
    expect(r.status).toBe(200);
    expect(r.body.data.synchronized).toBeGreaterThan(0); expect(r.body.data.failed).toBe(0);
    expect(r.body.message).toMatch(/records synchronized/);
    expect(rowsOf(SS_A).length).toBe(before);
    const st = (await W.A.admin.get('/api/integrations/google')).body.data.connection;
    expect(st.lastSyncAt).toBeTruthy(); expect(st.syncStatus).toBe('ok');
  });
  it('a user who moved/sorted rows in the sheet does not cause duplicates (row is found again by Bill Number)', async () => {
    const rows = G.tab(SS_A, 'Orders').rows; const keep = rows[1]; rows.splice(1, 1); rows.push(keep);     // user re-ordered rows
    const oid = (await one<any>(`SELECT id FROM orders WHERE invoice_number=$1`, [keep[1]]))!.id;
    await W.A.manager.patch(`/api/orders/${oid}`, { remarks: 'edited' }).catch(() => null);
    await query(`INSERT INTO google_sheet_sync_logs(business_id,connection_id,order_id) SELECT $1,id,$2 FROM google_sheet_connections WHERE business_id=$1 ON CONFLICT DO NOTHING`, [W.A.id, oid]);
    await processSheetSync(50);
    expect(rowsOf(SS_A).filter(x => x[1] === keep[1])).toHaveLength(1);
  });
  it('revoked Google access gives a clear "reconnect" status instead of crashing or leaking details', async () => {
    G.revokedRefresh = true; await query(`UPDATE google_sheet_connections SET token_expires_at = now() - interval '1 hour' WHERE business_id=$1`, [W.A.id]);
    const t = await W.A.admin.post('/api/integrations/google/test');
    expect(t.status).toBe(401); expect(t.body.code).toBe('GOOGLE_REAUTH_REQUIRED'); expect(t.body.message).toMatch(/reconnect/i);
    expect((await W.A.admin.get('/api/integrations/google')).body.data.connection.syncStatus).toBe('error');
    expect((await W.A.manager.post('/api/orders', newOrder({ invoiceNumber: 'INV-2003' }))).status).toBe(201);     // DMS keeps working
    G.revokedRefresh = false;
    await connect(W.A.admin);                                                    // same Google account reconnects: selection is kept
    const c = (await W.A.admin.get('/api/integrations/google')).body.data.connection;
    expect(c).toMatchObject({ spreadsheetId: SS_A, sheetName: 'Orders' });
    expect((await W.A.admin.post('/api/integrations/google/test')).status).toBe(200);
  });
  it('OAuth problems map to friendly messages (bad code, bad client, redirect mismatch, cancelled)', async () => {
    const bad = await connect(W.A.admin, 'wrong-code'); expect(bad.cb.headers.location).toContain('google=error');
    G.badClient = true; const bc = await connect(W.A.admin); G.badClient = false;
    expect(bc.cb.headers.location).toContain('google=error');
    G.redirectMismatch = true; const rm = await connect(W.A.admin); G.redirectMismatch = false; expect(rm.cb.headers.location).toContain('google=error');
    const cancelled = await api().get('/api/integrations/google/callback?error=access_denied&state=' + 'z'.repeat(40));
    expect(cancelled.status).toBe(302); expect(cancelled.headers.location).toContain('google=');
    const last = (await W.A.admin.get('/api/integrations/google')).body.data.connection;
    expect(JSON.stringify(last)).not.toMatch(/test-client-secret/);
  });
  it('an inaccessible spreadsheet gives a permission message', async () => {
    G.addSpreadsheet('F'.repeat(24), 'Locked', ['Orders']); G.spreadsheets.get('F'.repeat(24))!.forbidden = true;
    const r = await W.A.admin.put('/api/integrations/google/sheet', { spreadsheetId: 'F'.repeat(24), sheetName: 'Orders' });
    expect(r.status).toBe(403); expect(r.body.code).toBe('GOOGLE_PERMISSION_DENIED');
    expect((await W.A.admin.put('/api/integrations/google/sheet', { spreadsheetId: 'X'.repeat(24), sheetName: 'Orders' })).body.code).toBe('GOOGLE_NOT_FOUND');
  });
});

describe('Google Sheets - tenant isolation and permissions', () => {
  it('Business B connects its OWN account/spreadsheet; A\'s data never reaches B\'s sheet and vice versa', async () => {
    await connect(W.B.admin);
    expect((await W.B.admin.put('/api/integrations/google/sheet', { spreadsheetId: SS_B, sheetName: 'Orders' })).status).toBe(200);
    await W.B.admin.post('/api/integrations/google/auto-sync', { enabled: true, initialSync: 'new_only' });
    const o = (await W.B.manager.post('/api/orders', newOrder({ invoiceNumber: 'B-ONLY-1', customerName: 'Beta Customer' }))).body.data;
    await W.A.manager.post('/api/orders', newOrder({ invoiceNumber: 'A-ONLY-1', customerName: 'Alpha Customer' }));
    await processSheetSync(100);
    const a = JSON.stringify(rowsOf(SS_A)), b = JSON.stringify(rowsOf(SS_B));
    expect(b).toContain('B-ONLY-1'); expect(b).not.toContain('A-ONLY-1'); expect(b).not.toContain('Alpha Customer');
    expect(a).toContain('A-ONLY-1'); expect(a).not.toContain('B-ONLY-1'); expect(a).not.toContain('Beta Customer');
    expect(o.business_id).toBe(W.B.id);
    const rows = await query<any>(`SELECT DISTINCT c.business_id FROM google_sheet_rows r JOIN google_sheet_connections c ON c.id=r.connection_id JOIN orders o ON o.id=r.order_id WHERE c.business_id<>o.business_id`);
    expect(rows).toHaveLength(0);                                              // no mapping ever crosses a tenant boundary
  });
  it('B cannot see or use A\'s connection, and the same worksheet cannot be claimed by two businesses', async () => {
    const seenByB = JSON.stringify((await W.B.admin.get('/api/integrations/google')).body);
    expect(seenByB).toContain(SS_B); expect(seenByB).not.toContain(SS_A);
    const claim = await W.B.admin.put('/api/integrations/google/sheet', { spreadsheetId: SS_A, sheetName: 'Orders' });
    expect(claim.status).toBe(409); expect(claim.body.code).toBe('WORKSHEET_IN_USE');
    expect((await W.B.admin.get('/api/integrations/google/sync-logs')).body.data.every((l: any) => !l.invoice_number?.startsWith('A-'))).toBe(true);
    expect((await one<any>(`SELECT spreadsheet_id FROM google_sheet_connections WHERE business_id=$1`, [W.B.id]))!.spreadsheet_id).toBe(SS_B);
  });
  it('only people with integrations.manage can configure; partners and unauthenticated callers cannot', async () => {
    expect((await W.A.partner.get('/api/integrations/google')).status).toBe(403);
    expect((await api().get('/api/integrations/google')).status).toBe(401);
    expect((await W.owner.get('/api/integrations/google')).status).toBe(403);               // platform owner cannot read tenants' Google connections
    // manager has no integrations permission by default...
    expect((await W.A.manager.get('/api/integrations/google')).status).toBe(403);
    // ...until the Business Admin grants it (the admin holds it, so it can be delegated)
    const base = (await W.A.admin.get(`/api/users/${W.A.managerId}/permissions`)).body.data.permissions as string[];
    expect((await W.A.admin.put(`/api/users/${W.A.managerId}/permissions`, { permissions: [...base, 'integrations.view'] })).status).toBe(200);
    expect((await W.A.manager.get('/api/integrations/google')).status).toBe(200);
    expect((await W.A.manager.post('/api/integrations/google/sync')).status).toBe(403);     // view only: cannot sync
    expect(JSON.stringify((await W.A.manager.get('/api/integrations/google')).body)).not.toMatch(/refresh_token|access_token|rt-secret-value|"at-\d+"|client_secret/i);
  });
  it('Disconnect revokes at Google, wipes tokens, stops syncing', async () => {
    const calls = G.revokeCalls;
    expect((await W.A.admin.del('/api/integrations/google')).status).toBe(200);
    expect(G.revokeCalls).toBe(calls + 1);
    const c = await one<any>(`SELECT * FROM google_sheet_connections WHERE business_id=$1`, [W.A.id]);
    expect(c).toMatchObject({ status: 'disconnected', sync_enabled: false, refresh_token_enc: null, access_token_enc: null });
    const before = rowsOf(SS_A).length;
    await W.A.manager.post('/api/orders', newOrder({ invoiceNumber: 'AFTER-DISC' })); await processSheetSync(50);
    expect(rowsOf(SS_A).length).toBe(before);
    expect((await W.B.admin.get('/api/integrations/google')).body.data.connection.status).toBe('active');   // B untouched
  });
});
