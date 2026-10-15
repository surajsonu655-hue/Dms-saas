import crypto from 'node:crypto';
import { config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import { one, query } from '../db.js';
import { AppError } from '../errors.js';
import { ORDER_REPORT_COLUMNS, orderReportSelect } from './orderReport.js';

export const SHEET_COLUMNS = [...ORDER_REPORT_COLUMNS];
const LAST_COL = 'Q';                                   // 17 columns: A..Q
export const GOOGLE_SCOPES = {
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  drive: 'https://www.googleapis.com/auth/drive.metadata.readonly',   // only to LIST spreadsheets; no file contents
  email: 'https://www.googleapis.com/auth/userinfo.email',
};
export const googleConfigured = () => !!(config.google.clientId && config.google.clientSecret && config.google.redirectUri);

// ---------------------------------------------------------------------------------------- errors
/** Errors carry a user-safe message. Raw Google payloads, tokens and secrets are never forwarded. */
export class GoogleError extends AppError {
  constructor(status: number, code: string, message: string, public fatal = false, public retryAfterSec?: number) { super(status, code, message); }
}
function mapGoogleHttpError(status: number, body: any, where: string): GoogleError {
  const reason = String(body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? body?.error ?? '').toLowerCase();
  if (status === 401) return new GoogleError(401, 'GOOGLE_REAUTH_REQUIRED', 'Google access expired or was revoked. Please reconnect the Google account.', true);
  if (status === 403 && /(ratelimit|quota|userratelimit)/.test(reason)) return new GoogleError(429, 'GOOGLE_RATE_LIMIT', 'Google is rate limiting requests. The sync will retry automatically.', false, 60);
  if (status === 403 && /(accessnotconfigured|servicedisabled)/.test(reason + JSON.stringify(body?.error?.message ?? '').toLowerCase()))
    return new GoogleError(503, 'GOOGLE_API_DISABLED', 'The Google Sheets / Drive API is not enabled for this Google Cloud project. Enable it in Google Cloud Console.', true);
  if (status === 403) return new GoogleError(403, 'GOOGLE_PERMISSION_DENIED', 'The connected Google account does not have access to this spreadsheet. Share it with that account or choose another spreadsheet.', true);
  if (status === 404) return new GoogleError(404, 'GOOGLE_NOT_FOUND', `${where} was not found. It may have been deleted or the link is wrong.`, true);
  if (status === 429) return new GoogleError(429, 'GOOGLE_RATE_LIMIT', 'Google is rate limiting requests. The sync will retry automatically.', false, 60);
  if (status >= 500) return new GoogleError(502, 'GOOGLE_UNAVAILABLE', 'Google is temporarily unavailable. The sync will retry automatically.', false, 120);
  return new GoogleError(502, 'GOOGLE_ERROR', 'Google rejected the request.', false);
}
async function gfetch(url: string, init: RequestInit, where = 'The requested item'): Promise<any> {
  let r: Response;
  try { r = await fetch(url, init); }
  catch { throw new GoogleError(502, 'GOOGLE_UNREACHABLE', 'Could not reach Google. Check the server\'s internet connection; the sync will retry automatically.', false, 120); }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw mapGoogleHttpError(r.status, j, where);
  return j;
}

// ---------------------------------------------------------------------------------------- tokens
const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });

/** Returns a valid access token for a connection, refreshing it with the stored (encrypted) refresh token when needed. */
export async function accessToken(conn: any): Promise<string> {
  if (!conn.refresh_token_enc) throw new GoogleError(400, 'GOOGLE_NOT_CONNECTED', 'No Google account is connected for this business.', true);
  if (conn.access_token_enc && conn.token_expires_at && new Date(conn.token_expires_at).getTime() > Date.now() + 60_000) return decrypt(conn.access_token_enc);
  if (!googleConfigured()) throw new GoogleError(503, 'GOOGLE_NOT_CONFIGURED', 'Google OAuth is not configured on this server.', true);
  let r: Response;
  try { r = await fetch(config.google.tokenUrl, form({ client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: decrypt(conn.refresh_token_enc), grant_type: 'refresh_token' })); }
  catch { throw new GoogleError(502, 'GOOGLE_UNREACHABLE', 'Could not reach Google to refresh access.', false, 120); }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    if (j.error === 'invalid_grant') {
      await query(`UPDATE google_sheet_connections SET status='error', sync_status='error', last_error=$2 WHERE id=$1`, [conn.id, 'Google access was revoked or expired. Reconnect the Google account.']);
      throw new GoogleError(401, 'GOOGLE_REAUTH_REQUIRED', 'Google access was revoked or expired. Please reconnect the Google account.', true);
    }
    if (j.error === 'invalid_client') throw new GoogleError(503, 'GOOGLE_CLIENT_INVALID', 'The server\'s Google OAuth client ID/secret was rejected by Google. The administrator must check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.', true);
    throw new GoogleError(502, 'GOOGLE_TOKEN_REFRESH_FAILED', 'Could not refresh Google access.', false, 120);
  }
  await query(`UPDATE google_sheet_connections SET access_token_enc=$2, token_expires_at=$3 WHERE id=$1`, [conn.id, encrypt(j.access_token), new Date(Date.now() + (j.expires_in ?? 3600) * 1000)]);
  conn.access_token_enc = encrypt(j.access_token); conn.token_expires_at = new Date(Date.now() + (j.expires_in ?? 3600) * 1000);
  return j.access_token;
}
const authz = async (conn: any) => ({ authorization: `Bearer ${await accessToken(conn)}` });
const a1 = (sheet: string, range: string) => `'${sheet.replace(/'/g, "''")}'!${range}`;
const sheetsUrl = (id: string, path: string) => `${config.google.sheetsBase}/spreadsheets/${encodeURIComponent(id)}${path}`;

// ---------------------------------------------------------------------------------------- Sheets / Drive API
export interface SheetsClient {
  listSpreadsheets(conn: any, q?: string): Promise<{ id: string; name: string; modifiedTime?: string }[]>;
  getSpreadsheet(conn: any, spreadsheetId: string): Promise<{ title: string; sheets: { sheetId: number; title: string; index: number }[] }>;
  addSheet(conn: any, spreadsheetId: string, title: string): Promise<{ sheetId: number; title: string }>;
  readHeader(conn: any): Promise<string[]>;
  writeHeader(conn: any): Promise<void>;
  readColumnB(conn: any): Promise<string[]>;
  append(conn: any, values: (string | number)[]): Promise<{ rowId: number }>;
  update(conn: any, rowId: number, values: (string | number)[]): Promise<void>;
}

export class GoogleSheetsClient implements SheetsClient {
  async listSpreadsheets(conn: any, q?: string) {
    if (!config.google.driveListing) throw new GoogleError(501, 'DRIVE_LISTING_DISABLED', 'Spreadsheet listing is disabled on this server. Paste the spreadsheet link instead.');
    const term = q ? ` and name contains '${q.replace(/[\\']/g, ' ')}'` : '';
    const url = `${config.google.driveBase}/files?` + new URLSearchParams({ q: `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false${term}`, pageSize: '50', orderBy: 'modifiedTime desc', fields: 'files(id,name,modifiedTime)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    const j = await gfetch(url, { headers: await authz(conn) }, 'Spreadsheet list');
    return (j.files ?? []).map((f: any) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
  }
  async getSpreadsheet(conn: any, id: string) {
    const j = await gfetch(sheetsUrl(id, '?fields=properties.title,sheets.properties(sheetId,title,index)'), { headers: await authz(conn) }, 'The spreadsheet');
    return { title: j.properties?.title ?? '', sheets: (j.sheets ?? []).map((s: any) => ({ sheetId: s.properties.sheetId, title: s.properties.title, index: s.properties.index })) };
  }
  async addSheet(conn: any, id: string, title: string) {
    const j = await gfetch(sheetsUrl(id, ':batchUpdate'), { method: 'POST', headers: { ...(await authz(conn)), 'content-type': 'application/json' }, body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }) }, 'The spreadsheet');
    const p = j.replies?.[0]?.addSheet?.properties; return { sheetId: p.sheetId, title: p.title };
  }
  async readHeader(conn: any) {
    const j = await gfetch(sheetsUrl(conn.spreadsheet_id, `/values/${encodeURIComponent(a1(conn.sheet_name, `A1:${LAST_COL}1`))}`), { headers: await authz(conn) }, 'The worksheet');
    return (j.values?.[0] ?? []).map((v: any) => String(v));
  }
  async writeHeader(conn: any) {
    await gfetch(sheetsUrl(conn.spreadsheet_id, `/values/${encodeURIComponent(a1(conn.sheet_name, `A1:${LAST_COL}1`))}?valueInputOption=RAW`), { method: 'PUT', headers: { ...(await authz(conn)), 'content-type': 'application/json' }, body: JSON.stringify({ values: [SHEET_COLUMNS] }) }, 'The worksheet');
  }
  async readColumnB(conn: any) {
    const j = await gfetch(sheetsUrl(conn.spreadsheet_id, `/values/${encodeURIComponent(a1(conn.sheet_name, 'B:B'))}`), { headers: await authz(conn) }, 'The worksheet');
    return (j.values ?? []).map((r: any[]) => String(r?.[0] ?? ''));
  }
  async append(conn: any, values: (string | number)[]) {
    const j = await gfetch(sheetsUrl(conn.spreadsheet_id, `/values/${encodeURIComponent(a1(conn.sheet_name, `A:${LAST_COL}`))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`),
      { method: 'POST', headers: { ...(await authz(conn)), 'content-type': 'application/json' }, body: JSON.stringify({ values: [values] }) }, 'The worksheet');
    const m = /!(?:[A-Z]+)(\d+)/.exec(j?.updates?.updatedRange ?? '');
    if (!m) throw new GoogleError(502, 'GOOGLE_ERROR', 'Google did not confirm the appended row.');
    return { rowId: Number(m[1]) };
  }
  async update(conn: any, rowId: number, values: (string | number)[]) {
    await gfetch(sheetsUrl(conn.spreadsheet_id, `/values/${encodeURIComponent(a1(conn.sheet_name, `A${rowId}:${LAST_COL}${rowId}`))}?valueInputOption=USER_ENTERED`),
      { method: 'PUT', headers: { ...(await authz(conn)), 'content-type': 'application/json' }, body: JSON.stringify({ values: [values] }) }, 'The worksheet');
  }
}
let client: SheetsClient = new GoogleSheetsClient();
export const sheets = () => client;
export const setSheetsClient = (c: SheetsClient) => { client = c; };

// ---------------------------------------------------------------------------------------- selection / verification
export const parseSpreadsheetId = (input: string) => {
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(input) ?? /^([A-Za-z0-9_-]{20,})$/.exec(input.trim());
  return m ? m[1] : null;
};
export type HeaderState = 'empty' | 'match' | 'mismatch';
export const headerState = (h: string[]): HeaderState => !h.length || h.every(c => !c.trim()) ? 'empty' : SHEET_COLUMNS.every((c, i) => (h[i] ?? '').trim() === c) && h.slice(SHEET_COLUMNS.length).every(c => !c.trim()) ? 'match' : 'mismatch';

/** Verifies access to the spreadsheet + worksheet and inspects the header row. Throws user-safe errors. */
export async function verifyTarget(conn: any) {
  const ss = await client.getSpreadsheet(conn, conn.spreadsheet_id);
  const tab = ss.sheets.find(s => s.title === conn.sheet_name);
  if (!tab) throw new GoogleError(404, 'WORKSHEET_MISSING', `Worksheet "${conn.sheet_name}" does not exist in "${ss.title}". Pick another tab or let DMS create it.`, true);
  const header = await client.readHeader({ ...conn });
  return { spreadsheetTitle: ss.title, sheetId: tab.sheetId, sheetTitle: tab.title, headerState: headerState(header), header };
}

// ---------------------------------------------------------------------------------------- order rows
type Cell = string | number;
const safe = (v: any): Cell => v == null ? '' : typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v;   // formula-injection guard

export async function orderRow(orderId: string, businessId: string): Promise<Cell[] | null> {
  // Times are rendered in the BUSINESS timezone (businesses.timezone, default Asia/Kolkata). Timestamps themselves come from DMS events, never from Google.
  const tz = (await one<any>(`SELECT timezone FROM businesses WHERE id=$1`, [businessId]))?.timezone ?? 'Asia/Kolkata';
  const ORD = orderReportSelect('$3');
  const r = await one<any>(`SELECT ${ORD.select} FROM orders o LEFT JOIN users u ON u.id=o.current_partner_id ${ORD.joins}
                             WHERE o.id=$1 AND o.business_id=$2 AND o.deleted_at IS NULL`, [orderId, businessId, tz]);
  if (!r) return null;
  return SHEET_COLUMNS.map((_, i) => safe(r['c' + String(i + 1).padStart(2, '0')]));
}

// ---------------------------------------------------------------------------------------- sync worker
const MAX_ATTEMPTS = 8;
const sleep = (ms: number) => ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();

async function syncOne(conn: any, job: any) {
  const row = await orderRow(job.order_id, job.business_id);
  if (!row) throw new GoogleError(404, 'ORDER_GONE', 'Order no longer exists', true);
  if (!conn.header_written) {
    const st = headerState(await client.readHeader(conn));
    if (st === 'mismatch') throw new GoogleError(409, 'HEADER_MISMATCH', 'The worksheet already contains different column headers. Choose an empty worksheet or confirm replacing the header.', true);
    if (st === 'empty') await client.writeHeader(conn);
    await query(`UPDATE google_sheet_connections SET header_written=true, header_status='ok' WHERE id=$1`, [conn.id]); conn.header_written = true;
  }
  const bill = String(row[1]);
  const map = await one<any>(`SELECT * FROM google_sheet_rows WHERE connection_id=$1 AND order_id=$2`, [conn.id, job.order_id]);
  let rowId: number | null = null;

  if (map) {
    // Is our row still where we left it? (user may have sorted/inserted/deleted rows)
    const col = await client.readColumnB(conn);
    if ((col[map.row_id - 1] ?? '') === bill) rowId = map.row_id;
    else { const i = col.indexOf(bill); rowId = i >= 1 ? i + 1 : null; }
    if (rowId) await client.update(conn, rowId, row);
  } else if (job.attempts > 1) {
    // retry after a possibly half-finished attempt: never append twice
    const i = (await client.readColumnB(conn)).indexOf(bill);
    if (i >= 1) { rowId = i + 1; await client.update(conn, rowId, row); }
  }
  if (!rowId) rowId = (await client.append(conn, row)).rowId;
  // unique(connection_id, order_id) guarantees one mapping per order even if two workers race
  await query(`INSERT INTO google_sheet_rows(business_id,connection_id,order_id,row_id,invoice_number,last_synced_at) VALUES($1,$2,$3,$4,$5,now())
               ON CONFLICT (connection_id,order_id) DO UPDATE SET row_id=EXCLUDED.row_id, invoice_number=EXCLUDED.invoice_number, last_synced_at=now()`, [job.business_id, conn.id, job.order_id, rowId, bill]);
  return rowId;
}

/** Process due sync jobs. The database is the source of truth; this only pushes a copy. A Google failure never touches the order. */
export async function processSheetSync(limit = 25, opts: { businessId?: string; budgetMs?: number } = {}) {
  const started = Date.now();
  const stats = { processed: 0, synced: 0, failed: 0, retrying: 0, errors: [] as string[] };
  while (stats.processed < limit && (!opts.budgetMs || Date.now() - started < opts.budgetMs)) {
    const jobs = await query<any>(`UPDATE google_sheet_sync_logs SET attempts=attempts+1, next_attempt_at=now()+interval '5 minutes'
        WHERE id IN (SELECT id FROM google_sheet_sync_logs WHERE sync_status='pending' AND next_attempt_at<=now() AND ($1::uuid IS NULL OR business_id=$1) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, [opts.businessId ?? null]);
    if (!jobs.length) break;
    const j = jobs[0]; stats.processed++;
    let conn: any = null;
    try {
      conn = await one<any>(`SELECT * FROM google_sheet_connections WHERE id=$1 AND business_id=$2`, [j.connection_id, j.business_id]);    // tenant-checked
      if (!conn || conn.status !== 'active' || !conn.spreadsheet_id) throw new GoogleError(409, 'NOT_CONNECTED', 'Google Sheet connection is not active', true);
      await query(`UPDATE google_sheet_connections SET sync_status='syncing' WHERE id=$1 AND sync_status<>'error'`, [conn.id]);
      const readAt = (await one<any>(`SELECT updated_at FROM orders WHERE id=$1`, [j.order_id]))?.updated_at;
      const rowId = await syncOne(conn, j);
      await query(`UPDATE google_sheet_sync_logs SET sync_status='success', row_id=$2, last_synced_at=now(), error_message=NULL WHERE id=$1`, [j.id, rowId]);
      const cur = (await one<any>(`SELECT updated_at FROM orders WHERE id=$1`, [j.order_id]))?.updated_at;
      if (cur && readAt && new Date(cur) > new Date(readAt))        // order changed while we were syncing -> queue one more pass
        await query(`INSERT INTO google_sheet_sync_logs(business_id,connection_id,order_id) VALUES($1,$2,$3) ON CONFLICT (connection_id, order_id) WHERE sync_status='pending' DO NOTHING`, [j.business_id, conn.id, j.order_id]);
      await query(`UPDATE google_sheet_connections SET last_sync_at=now(), sync_status='ok', last_error=NULL WHERE id=$1`, [conn.id]);
      stats.synced++;
    } catch (e: any) {
      if (!(e instanceof GoogleError)) console.error('[sheets] unexpected sync error (order ' + j.order_id + '):', e?.message ?? e);   // details stay in server logs only
      const g = e instanceof GoogleError ? e : new GoogleError(502, 'SYNC_ERROR', 'Unexpected sync error', false);
      const dead = g.fatal || j.attempts >= MAX_ATTEMPTS;
      if (dead) { stats.failed++; } else stats.retrying++;
      if (!stats.errors.includes(g.message)) stats.errors.push(g.message);
      const delayMin = g.retryAfterSec ? Math.ceil(g.retryAfterSec / 60) : Math.min(2 ** j.attempts, 360);
      await query(`UPDATE google_sheet_sync_logs SET sync_status=$2, error_message=$3, next_attempt_at=now()+($4 || ' minutes')::interval WHERE id=$1`, [j.id, dead ? 'failed' : 'pending', g.message.slice(0, 500), String(delayMin)]);
      if (j.connection_id) await query(`UPDATE google_sheet_connections SET sync_status='error', last_error=$2 WHERE id=$1`, [j.connection_id, g.message.slice(0, 500)]);
      if (g.code === 'GOOGLE_REAUTH_REQUIRED' || g.code === 'GOOGLE_NOT_CONNECTED') break;      // no point hammering Google; the admin must reconnect
    }
    await sleep(config.google.minIntervalMs);
  }
  return stats;
}

/** Queue every existing order of one business for sync (initial / manual sync). Pending jobs are de-duplicated per order. */
export async function enqueueBackfill(businessId: string, connectionId: string) {
  await query(`UPDATE google_sheet_sync_logs SET sync_status='dead', error_message='Superseded by a newer sync' WHERE connection_id=$1 AND sync_status='failed'`, [connectionId]);
  const r = await query(`INSERT INTO google_sheet_sync_logs(business_id,connection_id,order_id)
      SELECT business_id,$2,id FROM orders WHERE business_id=$1 AND deleted_at IS NULL ON CONFLICT (connection_id, order_id) WHERE sync_status='pending' DO NOTHING RETURNING id`, [businessId, connectionId]);
  return r.length;
}

// ---------------------------------------------------------------------------------------- OAuth
export async function googleAuthUrl(businessId: string, userId: string) {
  if (!googleConfigured()) throw new GoogleError(503, 'GOOGLE_NOT_CONFIGURED', 'Google OAuth is not configured on this server. The administrator must set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.');
  const nonce = crypto.randomBytes(24).toString('hex');
  await query(`INSERT INTO oauth_states(nonce,business_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')`, [nonce, businessId, userId]);
  const scope = [GOOGLE_SCOPES.sheets, GOOGLE_SCOPES.email, ...(config.google.driveListing ? [GOOGLE_SCOPES.drive] : [])].join(' ');
  return `${config.google.authUrl}?` + new URLSearchParams({ client_id: config.google.clientId, redirect_uri: config.google.redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', scope, state: nonce });
}

/** Handles Google's redirect. Returns the tenant the single-use `state` was issued for. */
export async function googleExchange(code: string, state: string) {
  const st = await one<any>(`UPDATE oauth_states SET used_at=now() WHERE nonce=$1 AND used_at IS NULL AND expires_at>now() RETURNING *`, [state]);
  if (!st) throw new GoogleError(400, 'INVALID_STATE', 'This sign-in link is invalid or has expired. Start the connection again.');
  let r: Response;
  try { r = await fetch(config.google.tokenUrl, form({ code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: config.google.redirectUri, grant_type: 'authorization_code' })); }
  catch { throw new GoogleError(502, 'GOOGLE_UNREACHABLE', 'Could not reach Google.'); }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    if (j.error === 'invalid_client') throw new GoogleError(503, 'GOOGLE_CLIENT_INVALID', 'Google rejected the OAuth client ID/secret configured on the server.');
    if (j.error === 'redirect_uri_mismatch') throw new GoogleError(400, 'REDIRECT_URI_MISMATCH', 'The redirect URI does not match the one registered in Google Cloud Console.');
    if (j.error === 'invalid_grant') throw new GoogleError(400, 'INVALID_CODE', 'The Google authorization code is invalid or already used. Start again.');
    throw new GoogleError(502, 'GOOGLE_ERROR', 'Google rejected the authorization.');
  }
  let email: string | null = null;
  try { email = (await gfetch(config.google.userinfoUrl, { headers: { authorization: `Bearer ${j.access_token}` } })).email ?? null; } catch { /* optional */ }
  const prev = await one<any>(`SELECT * FROM google_sheet_connections WHERE business_id=$1`, [st.business_id]);
  if (!j.refresh_token && !prev?.refresh_token_enc) throw new GoogleError(400, 'NO_REFRESH_TOKEN', 'Google did not return offline access. Remove DMS from your Google account permissions and connect again.');
  const sameAccount = prev && prev.google_email && prev.google_email === email;
  await query(`INSERT INTO google_sheet_connections(business_id,google_email,access_token_enc,refresh_token_enc,token_expires_at,status,sync_status,created_by,granted_scopes)
               VALUES($1,$2,$3,$4,$5,'pending','not_configured',$6,$7)
               ON CONFLICT (business_id) DO UPDATE SET google_email=EXCLUDED.google_email, access_token_enc=EXCLUDED.access_token_enc, token_expires_at=EXCLUDED.token_expires_at,
                 refresh_token_enc=COALESCE(EXCLUDED.refresh_token_enc, google_sheet_connections.refresh_token_enc), granted_scopes=EXCLUDED.granted_scopes, last_error=NULL,
                 status=CASE WHEN $8 AND google_sheet_connections.spreadsheet_id IS NOT NULL THEN 'active' ELSE 'pending' END,
                 sync_status=CASE WHEN $8 AND google_sheet_connections.spreadsheet_id IS NOT NULL THEN 'ready' ELSE 'not_configured' END,
                 spreadsheet_id=CASE WHEN $8 THEN google_sheet_connections.spreadsheet_id ELSE NULL END, sheet_name=CASE WHEN $8 THEN google_sheet_connections.sheet_name ELSE 'Orders' END,
                 spreadsheet_name=CASE WHEN $8 THEN google_sheet_connections.spreadsheet_name ELSE NULL END, sheet_id=CASE WHEN $8 THEN google_sheet_connections.sheet_id ELSE NULL END,
                 sync_enabled=CASE WHEN $8 THEN google_sheet_connections.sync_enabled ELSE false END, header_written=CASE WHEN $8 THEN google_sheet_connections.header_written ELSE false END`,
    [st.business_id, email, encrypt(j.access_token), j.refresh_token ? encrypt(j.refresh_token) : null, new Date(Date.now() + (j.expires_in ?? 3600) * 1000), st.user_id, j.scope ?? null, !!sameAccount]);
  if (!sameAccount) await query(`DELETE FROM google_sheet_rows WHERE business_id=$1`, [st.business_id]);
  return { businessId: st.business_id as string, email };
}

export async function revokeGoogle(conn: any) {
  try { if (conn?.refresh_token_enc) await fetch(config.google.revokeUrl, form({ token: decrypt(conn.refresh_token_enc) })); } catch { /* best effort */ }
}
