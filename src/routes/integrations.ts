import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { authenticate, biz, notPartner, requirePerm, requireTenant, SCOPE_PERMISSIONS } from '../auth.js';
import { one, query } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, wrap } from '../errors.js';
import { created, ok } from '../http.js';
import { uuid } from '../validate.js';
import { audit } from '../audit.js';
import { sha256 } from '../crypto.js';
import { assertFeature } from '../services/plan.js';
import { GOOGLE_SCOPES, GoogleError, SHEET_COLUMNS, enqueueBackfill, googleAuthUrl, googleConfigured, googleExchange, headerState, parseSpreadsheetId, processSheetSync, revokeGoogle, sheets, verifyTarget } from '../services/sheets.js';
import { assertSafeWebhookUrl, newWebhookSecret, processWebhookDeliveries, WEBHOOK_EVENTS } from '../services/webhooks.js';
import { meta, paging } from './util.js';

export const integrationsRouter = Router();

// OAuth callback: the browser comes back from Google without our bearer token, so the single-use `state` issued by
// /auth-url (bound to one business + user, 10 min expiry) is what authenticates it. Registered under both paths so the
// redirect URI can be either /api/integrations/google/callback or /api/auth/callback/google.
const callback = wrap(async (req, res) => {
  const back = (s: string, reason?: string) => res.redirect(`${config.frontendUrl}/settings/integrations?google=${s}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`);
  const q = z.object({ code: z.string().min(5).max(2000).optional(), state: z.string().min(10).max(200).optional(), error: z.string().max(100).optional() }).safeParse(req.query);
  if (!q.success) return back('error', 'INVALID_REQUEST');
  if (q.data.error) return back(q.data.error === 'access_denied' ? 'cancelled' : 'error', q.data.error === 'access_denied' ? undefined : 'GOOGLE_ERROR');
  if (!q.data.code || !q.data.state) return back('error', 'INVALID_REQUEST');
  try {
    const r = await googleExchange(q.data.code, q.data.state);
    await audit(undefined, { businessId: r.businessId, action: 'integration.google_authorized', entity: 'google_sheet_connection', newValue: { googleEmail: r.email }, req });
    back('connected');
  } catch (e: any) { back('error', e instanceof GoogleError ? e.code : 'GOOGLE_ERROR'); }
});
integrationsRouter.get(['/integrations/google/callback', '/auth/callback/google'], callback);

const secured = Router();
// Only engage for this router's own paths; a bare .use() would also guard other routers mounted under /api (e.g. partner endpoints).
secured.use((req, _res, next) => /^\/(integrations|webhooks|api-keys)(\/|$)/.test(req.path) ? next() : next('router'));
secured.use(authenticate, requireTenant, notPartner);
integrationsRouter.use(secured);

// ---- Google Sheets ---------------------------------------------------------------------------
// Tokens, the client secret and raw Google errors never leave the server; this is the only shape the browser sees.
const publicConn = (c: any, counts?: any) => !c ? null : ({
  status: c.status, googleEmail: c.google_email, spreadsheetId: c.spreadsheet_id, spreadsheetName: c.spreadsheet_name, sheetName: c.sheet_name, sheetId: c.sheet_id,
  syncEnabled: c.sync_enabled, syncStatus: c.sync_status, lastSyncAt: c.last_sync_at, lastError: c.last_error, initialSyncMode: c.initial_sync_mode,
  hasTokens: !!c.refresh_token_enc, canListSpreadsheets: (c.granted_scopes ?? '').includes(GOOGLE_SCOPES.drive), columns: SHEET_COLUMNS, ...(counts ? { counts } : {}),
});
async function counts(businessId: string) {
  return (await one<any>(`SELECT count(*) FILTER (WHERE sync_status='pending')::int AS pending, count(*) FILTER (WHERE sync_status='failed')::int AS failed,
      (SELECT count(*)::int FROM google_sheet_rows WHERE business_id=$1) AS synced FROM google_sheet_sync_logs WHERE business_id=$1`, [businessId]))!;
}
const myConn = async (req: any, needActive = false) => {
  const c = await one<any>(`SELECT * FROM google_sheet_connections WHERE business_id=$1`, [biz(req)]);          // business id comes from the session, never the request
  if (!c || !c.refresh_token_enc) throw badRequest('Connect a Google account first');
  if (needActive && (c.status !== 'active' || !c.spreadsheet_id)) throw badRequest('Select a spreadsheet and worksheet first');
  return c;
};

secured.get('/integrations/google', requirePerm('integrations.view'), wrap(async (req, res) => {
  const c = await one<any>(`SELECT * FROM google_sheet_connections WHERE business_id=$1`, [biz(req)]);
  ok(res, { configuredOnServer: googleConfigured(), connection: publicConn(c, await counts(biz(req))) });
}));
secured.get('/integrations/google/auth-url', requirePerm('integrations.manage'), wrap(async (req, res) => {
  await assertFeature(biz(req), 'googleSheets');
  ok(res, { url: await googleAuthUrl(biz(req), req.auth!.userId!) });
}));
secured.get('/integrations/google/spreadsheets', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const q = z.object({ q: z.string().max(80).optional() }).parse(req.query);
  ok(res, await sheets().listSpreadsheets(await myConn(req), q.q));
}));
secured.get('/integrations/google/spreadsheets/:spreadsheetId/sheets', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const id = parseSpreadsheetId(z.string().max(300).parse(req.params.spreadsheetId)); if (!id) throw badRequest('Invalid spreadsheet ID');
  ok(res, await sheets().getSpreadsheet(await myConn(req), id));
}));

// Choose spreadsheet + worksheet. Verifies access, reads the header row and (only if the sheet is empty, or the admin confirms) writes the header.
secured.put('/integrations/google/sheet', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const b = z.object({ spreadsheet: z.string().trim().min(10).max(300).optional(), spreadsheetId: z.string().trim().min(10).max(300).optional(),
    sheetName: z.string().trim().min(1).max(100).regex(/^[^\[\]*?:\/\\]+$/, 'Invalid worksheet name'), createIfMissing: z.boolean().default(false), overwriteHeader: z.boolean().default(false) }).parse(req.body);
  await assertFeature(biz(req), 'googleSheets');
  const id = parseSpreadsheetId(b.spreadsheet ?? b.spreadsheetId ?? ''); if (!id) throw badRequest('Enter a valid spreadsheet link or ID');
  const c = await myConn(req);
  const ss = await sheets().getSpreadsheet(c, id);
  let tab = ss.sheets.find(s => s.title === b.sheetName);
  if (!tab) { if (!b.createIfMissing) throw new GoogleError(404, 'WORKSHEET_MISSING', `Worksheet "${b.sheetName}" does not exist in "${ss.title}". Pick an existing tab or choose "create it for me".`); tab = { ...(await sheets().addSheet(c, id, b.sheetName)), index: ss.sheets.length }; }
  const target = { ...c, spreadsheet_id: id, sheet_name: tab.title };
  const hs = headerState(await sheets().readHeader(target));
  if (hs === 'mismatch' && !b.overwriteHeader) throw new GoogleError(409, 'HEADER_MISMATCH', 'This worksheet already contains different column headers. Pick an empty worksheet, or confirm that DMS may replace the header row.');
  if (hs !== 'match') await sheets().writeHeader(target);
  let n: any;
  try {
    n = await one<any>(`UPDATE google_sheet_connections SET spreadsheet_id=$2, spreadsheet_name=$3, sheet_id=$4, sheet_name=$5, status='active', sync_status='ready', header_written=true, header_status='ok',
        sync_enabled=false, initial_sync_mode=NULL, last_error=NULL WHERE id=$1 RETURNING *`, [c.id, id, ss.title, tab.sheetId, tab.title]);
  } catch (e: any) { if (e.code === '23505') throw conflict('This worksheet is already connected to another business. Use a different worksheet.', 'WORKSHEET_IN_USE'); throw e; }
  await query(`DELETE FROM google_sheet_rows WHERE connection_id=$1`, [c.id]);       // different target: old row numbers no longer apply
  await query(`UPDATE google_sheet_sync_logs SET sync_status='dead', error_message='Worksheet changed' WHERE connection_id=$1 AND sync_status IN ('pending','failed')`, [c.id]);
  await audit(undefined, { auth: req.auth, action: 'integration.google_sheet_configured', entity: 'google_sheet_connection', entityId: c.id, newValue: { spreadsheetId: id, sheetName: tab.title }, req });
  ok(res, publicConn(n), 'Google Sheet selected');
}));

secured.post('/integrations/google/test', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const c = await myConn(req, true);
  const v = await verifyTarget(c);
  await query(`UPDATE google_sheet_connections SET spreadsheet_name=$2, sheet_id=$3, sync_status=CASE WHEN sync_status='error' THEN 'ready' ELSE sync_status END, last_error=NULL, status='active' WHERE id=$1`, [c.id, v.spreadsheetTitle, v.sheetId]);
  ok(res, { connected: true, googleEmail: c.google_email, spreadsheet: v.spreadsheetTitle, worksheet: v.sheetTitle, headerState: v.headerState }, 'Google Sheet connected');
}));

// Enable / disable automatic sync. The first time, the admin must choose what to do with existing orders.
secured.post('/integrations/google/auto-sync', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const b = z.object({ enabled: z.boolean(), initialSync: z.enum(['existing', 'new_only']).optional() }).parse(req.body);
  const c = await myConn(req, true);
  if (b.enabled && !c.initial_sync_mode && !b.initialSync) throw new AppError(400, 'INITIAL_SYNC_CHOICE_REQUIRED', 'Choose whether to sync existing Order Reports or only new orders.', [{ options: ['existing', 'new_only'] }]);
  if (b.enabled) await verifyTarget(c);
  await query(`UPDATE google_sheet_connections SET sync_enabled=$2, initial_sync_mode=COALESCE(initial_sync_mode,$3) WHERE id=$1`, [c.id, b.enabled, b.initialSync ?? null]);
  let queued = 0;
  if (b.enabled && !c.initial_sync_mode && b.initialSync === 'existing') queued = await enqueueBackfill(biz(req), c.id);
  await audit(undefined, { auth: req.auth, action: b.enabled ? 'integration.google_autosync_enabled' : 'integration.google_autosync_disabled', entity: 'google_sheet_connection', entityId: c.id, newValue: { initialSync: b.initialSync }, req });
  ok(res, { syncEnabled: b.enabled, queued }, b.enabled ? 'Auto sync enabled' : 'Auto sync disabled');
}));

// "Sync Now": (re)queue every order of THIS business and process what fits in the time budget; the rest continues in the background.
secured.post('/integrations/google/sync', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const c = await myConn(req, true);
  const queued = await enqueueBackfill(biz(req), c.id);
  await query(`UPDATE google_sheet_connections SET sync_status='syncing' WHERE id=$1`, [c.id]);
  const r = await processSheetSync(500, { businessId: biz(req), budgetMs: 20_000 });
  const cnt = await counts(biz(req));
  await query(`UPDATE google_sheet_connections SET sync_status=CASE WHEN $2>0 THEN 'error' WHEN $3>0 THEN 'syncing' ELSE 'ok' END, last_sync_at=CASE WHEN $4>0 THEN now() ELSE last_sync_at END WHERE id=$1`, [c.id, cnt.failed, cnt.pending, r.synced]);
  ok(res, { queued, synchronized: r.synced, failed: cnt.failed, retrying: r.retrying, remaining: cnt.pending, errors: r.errors }, r.failed ? `${r.synced} records synchronized, ${r.failed} failed` : `Sync complete: ${r.synced} records synchronized`);
}));
secured.post('/integrations/google/sync/run', requirePerm('integrations.manage'), wrap(async (req, res) => ok(res, await processSheetSync(50, { businessId: biz(req) }), 'Sync run complete')));

secured.delete('/integrations/google', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const c = await one<any>(`SELECT * FROM google_sheet_connections WHERE business_id=$1`, [biz(req)]);
  if (c) await revokeGoogle(c);
  await query(`UPDATE google_sheet_connections SET status='disconnected', sync_enabled=false, sync_status='not_configured', access_token_enc=NULL, refresh_token_enc=NULL, token_expires_at=NULL,
      spreadsheet_id=NULL, spreadsheet_name=NULL, sheet_id=NULL, header_written=false, last_error=NULL, initial_sync_mode=NULL, granted_scopes=NULL WHERE business_id=$1`, [biz(req)]);
  await query(`DELETE FROM google_sheet_rows WHERE business_id=$1`, [biz(req)]);
  await query(`UPDATE google_sheet_sync_logs SET sync_status='dead', error_message='Disconnected' WHERE business_id=$1 AND sync_status IN ('pending','failed')`, [biz(req)]);
  await audit(undefined, { auth: req.auth, action: 'integration.google_disconnected', entity: 'google_sheet_connection', req });
  ok(res, null, 'Google account disconnected');
}));
secured.get('/integrations/google/sync-logs', requirePerm('integrations.view'), wrap(async (req, res) => {
  const p = paging(req), s = z.enum(['pending', 'success', 'failed', 'dead']).optional().parse(req.query.status);
  const total = (await one<any>(`SELECT count(*)::int n FROM google_sheet_sync_logs WHERE business_id=$1 AND ($2::text IS NULL OR sync_status=$2)`, [biz(req), s ?? null]))!.n;
  ok(res, await query(`SELECT l.id,l.order_id,o.invoice_number,l.action,l.sync_status,l.attempts,l.row_id,l.error_message,l.last_synced_at,l.created_at,l.next_attempt_at FROM google_sheet_sync_logs l LEFT JOIN orders o ON o.id=l.order_id WHERE l.business_id=$1 AND ($2::text IS NULL OR l.sync_status=$2) ORDER BY l.created_at DESC LIMIT $3 OFFSET $4`, [biz(req), s ?? null, p.limit, p.offset]), 'OK', 200, meta(p, total));
}));

// ---- Webhooks ---------------------------------------------------------------------------------------
const hookBody = z.object({ url: z.string().url().max(500), events: z.array(z.enum(['*', ...WEBHOOK_EVENTS] as [string, ...string[]])).min(1).default(['*']), active: z.boolean().default(true) });
const pubHook = (h: any) => ({ id: h.id, url: h.url, events: h.events, active: h.active, lastDeliveryAt: h.last_delivery_at, failureCount: h.failure_count, createdAt: h.created_at });
secured.get('/webhooks', requirePerm('webhooks.manage'), wrap(async (req, res) => ok(res, (await query(`SELECT * FROM webhooks WHERE business_id=$1 ORDER BY created_at DESC`, [biz(req)])).map(pubHook))));
secured.get('/webhooks/events', requirePerm('webhooks.manage'), wrap(async (_q, res) => ok(res, WEBHOOK_EVENTS)));
secured.post('/webhooks', requirePerm('webhooks.manage'), wrap(async (req, res) => {
  const b = hookBody.parse(req.body); await assertSafeWebhookUrl(b.url);
  const secret = newWebhookSecret();
  const h = await one<any>(`INSERT INTO webhooks(business_id,url,secret,events,active,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [biz(req), b.url, secret, b.events, b.active, req.auth!.userId]);
  await audit(undefined, { auth: req.auth, action: 'webhook.created', entity: 'webhook', entityId: h.id, newValue: { url: b.url, events: b.events }, req });
  created(res, { ...pubHook(h), secret, note: 'Store this signing secret now. It will not be shown again.' }, 'Webhook created');
}));
secured.patch('/webhooks/:id', requirePerm('webhooks.manage'), wrap(async (req, res) => {
  const b = hookBody.partial().parse(req.body), id = uuid.parse(req.params.id); if (b.url) await assertSafeWebhookUrl(b.url);
  const h = await one<any>(`UPDATE webhooks SET url=COALESCE($3,url), events=COALESCE($4,events), active=COALESCE($5,active), failure_count=CASE WHEN $5 IS TRUE THEN 0 ELSE failure_count END WHERE id=$1 AND business_id=$2 RETURNING *`, [id, biz(req), b.url ?? null, b.events ?? null, b.active ?? null]);
  if (!h) throw notFound('Webhook not found');
  await audit(undefined, { auth: req.auth, action: 'webhook.updated', entity: 'webhook', entityId: id, newValue: b, req });
  ok(res, pubHook(h), 'Webhook updated');
}));
secured.post('/webhooks/:id/rotate-secret', requirePerm('webhooks.manage'), wrap(async (req, res) => {
  const secret = newWebhookSecret();
  const h = await one<any>(`UPDATE webhooks SET secret=$3 WHERE id=$1 AND business_id=$2 RETURNING id`, [uuid.parse(req.params.id), biz(req), secret]); if (!h) throw notFound('Webhook not found');
  await audit(undefined, { auth: req.auth, action: 'webhook.secret_rotated', entity: 'webhook', entityId: h.id, req });
  ok(res, { secret }, 'Secret rotated. Store it now; it will not be shown again.');
}));
secured.delete('/webhooks/:id', requirePerm('webhooks.manage'), wrap(async (req, res) => {
  const h = await one(`DELETE FROM webhooks WHERE id=$1 AND business_id=$2 RETURNING id`, [uuid.parse(req.params.id), biz(req)]); if (!h) throw notFound('Webhook not found');
  await audit(undefined, { auth: req.auth, action: 'webhook.deleted', entity: 'webhook', entityId: req.params.id, req });
  ok(res, null, 'Webhook deleted');
}));
secured.post('/webhooks/:id/test', requirePerm('webhooks.manage'), wrap(async (req, res) => {
  const h = await one<any>(`SELECT * FROM webhooks WHERE id=$1 AND business_id=$2`, [uuid.parse(req.params.id), biz(req)]); if (!h) throw notFound('Webhook not found');
  const d = await one<any>(`INSERT INTO webhook_deliveries(business_id,webhook_id,event,payload) VALUES($1,$2,'webhook.test',$3::jsonb) RETURNING id`, [biz(req), h.id, JSON.stringify({ event: 'webhook.test', business_id: biz(req), created_at: new Date().toISOString(), data: { message: 'Test delivery from DMS' } })]);
  await processWebhookDeliveries(10);
  ok(res, await one(`SELECT id,event,status,attempts,response_status,error_message FROM webhook_deliveries WHERE id=$1`, [d.id]), 'Test delivery attempted');
}));
secured.get('/webhooks/:id/deliveries', requirePerm('webhooks.manage'), wrap(async (req, res) => {
  const p = paging(req), id = uuid.parse(req.params.id);
  const total = (await one<any>(`SELECT count(*)::int n FROM webhook_deliveries WHERE webhook_id=$1 AND business_id=$2`, [id, biz(req)]))!.n;
  ok(res, await query(`SELECT id,event,status,attempts,response_status,error_message,next_attempt_at,created_at FROM webhook_deliveries WHERE webhook_id=$1 AND business_id=$2 ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [id, biz(req), p.limit, p.offset]), 'OK', 200, meta(p, total));
}));
secured.post('/webhooks/deliveries/:id/retry', requirePerm('webhooks.manage'), wrap(async (req, res) => {
  const d = await one(`UPDATE webhook_deliveries SET status='pending', next_attempt_at=now(), attempts=LEAST(attempts,3) WHERE id=$1 AND business_id=$2 AND status IN ('failed','dead','pending') RETURNING id`, [uuid.parse(req.params.id), biz(req)]);
  if (!d) throw notFound('Delivery not found');
  ok(res, null, 'Retry queued');
}));

// ---- API keys ----------------------------------------------------------------------------------------------
secured.get('/api-keys', requirePerm('apikeys.manage'), wrap(async (req, res) => ok(res, await query(`SELECT id,name,key_prefix,scopes,created_at,last_used_at,revoked_at,(revoked_at IS NULL) AS active FROM api_keys WHERE business_id=$1 ORDER BY created_at DESC`, [biz(req)]))));
secured.post('/api-keys', requirePerm('apikeys.manage'), wrap(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(80), scopes: z.array(z.enum(SCOPE_PERMISSIONS as [string, ...string[]])).min(1) }).parse(req.body);
  for (const s of b.scopes) if (!req.auth!.perms.has(s)) throw forbidden(`You cannot grant scope "${s}" because you do not hold it`, 'PERMISSION_NOT_HELD');
  await assertFeature(biz(req), 'apiAccess');
  const secret = 'dms_live_' + crypto.randomBytes(24).toString('hex');
  const k = await one<any>(`INSERT INTO api_keys(business_id,name,key_prefix,key_hash,scopes,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,key_prefix,scopes,created_at`, [biz(req), b.name, secret.slice(0, 13), sha256(secret), b.scopes, req.auth!.userId]);
  await audit(undefined, { auth: req.auth, action: 'apikey.created', entity: 'api_key', entityId: k.id, newValue: { name: b.name, scopes: b.scopes }, req });
  created(res, { ...k, secret, note: 'Copy this key now. It cannot be shown again; only a hash is stored.' }, 'API key created');
}));
secured.delete('/api-keys/:id', requirePerm('apikeys.manage'), wrap(async (req, res) => {
  const k = await one(`UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND business_id=$2 AND revoked_at IS NULL RETURNING id`, [uuid.parse(req.params.id), biz(req)]); if (!k) throw notFound('API key not found');
  await audit(undefined, { auth: req.auth, action: 'apikey.revoked', entity: 'api_key', entityId: req.params.id, req });
  ok(res, null, 'API key revoked');
}));
