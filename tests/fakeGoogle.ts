import http from 'node:http';

/** A small in-memory imitation of the Google endpoints DMS uses (OAuth token, userinfo, Drive list, Sheets values), so the REAL HTTP client code is exercised. */
export interface FakeTab { sheetId: number; title: string; rows: string[][] }
export class FakeGoogle {
  server!: http.Server; base = '';
  spreadsheets = new Map<string, { title: string; tabs: FakeTab[]; forbidden?: boolean }>();
  email = 'owner@gmail.test';
  mode: 'ok' | 'down' | 'ratelimit' = 'ok';
  badClient = false; revokedRefresh = false; redirectMismatch = false;
  tokenCalls: string[] = []; revokeCalls = 0; requests: string[] = []; validAccess = new Set<string>(); n = 0;

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as any).port}`;
  }
  stop() { this.server.close(); }
  addSpreadsheet(id: string, title: string, tabs: string[] = ['Sheet1']) { this.spreadsheets.set(id, { title, tabs: tabs.map((t, i) => ({ sheetId: 100 + i, title: t, rows: [] })) }); }
  tab(id: string, title: string) { return this.spreadsheets.get(id)!.tabs.find(t => t.title === title)!; }

  private json(res: http.ServerResponse, status: number, body: any) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
      const url = new URL(req.url!, this.base); const path = decodeURIComponent(url.pathname); const method = req.method!;
      this.requests.push(`${method} ${path}`);
      if (path === '/token') {
        const p = new URLSearchParams(raw); this.tokenCalls.push(p.get('grant_type')!);
        if (this.badClient) return this.json(res, 401, { error: 'invalid_client' });
        if (p.get('grant_type') === 'authorization_code') {
          if (this.redirectMismatch) return this.json(res, 400, { error: 'redirect_uri_mismatch' });
          if (p.get('code') !== 'good-code') return this.json(res, 400, { error: 'invalid_grant' });
          const at = 'at-' + (++this.n); this.validAccess.add(at);
          return this.json(res, 200, { access_token: at, refresh_token: 'rt-secret-value', expires_in: 3600, scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly email' });
        }
        if (p.get('grant_type') === 'refresh_token') {
          if (this.revokedRefresh || p.get('refresh_token') !== 'rt-secret-value') return this.json(res, 400, { error: 'invalid_grant' });
          const at = 'at-' + (++this.n); this.validAccess.add(at); return this.json(res, 200, { access_token: at, expires_in: 3600 });
        }
      }
      if (path === '/revoke') { this.revokeCalls++; return this.json(res, 200, {}); }
      const tok = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      if (!tok || !this.validAccess.has(tok)) return this.json(res, 401, { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } });
      if (path === '/userinfo') return this.json(res, 200, { email: this.email });
      if (this.mode === 'down') return this.json(res, 503, { error: { code: 503, message: 'backend error' } });
      if (this.mode === 'ratelimit') return this.json(res, 429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } });
      if (path === '/drive/files') return this.json(res, 200, { files: [...this.spreadsheets].map(([id, s]) => ({ id, name: s.title, modifiedTime: '2026-10-01T00:00:00Z' })) });
      const m = /^\/sheets\/spreadsheets\/([^/:]+)(?::(batchUpdate))?(?:\/values\/(.+?)(?::(append))?)?$/.exec(path);
      if (!m) return this.json(res, 404, { error: { code: 404, message: 'not found' } });
      const [, id, batch, rangeRaw, append] = m; const ss = this.spreadsheets.get(id);
      if (!ss) return this.json(res, 404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } });
      if (ss.forbidden) return this.json(res, 403, { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } });
      if (batch) { const t = JSON.parse(raw).requests[0].addSheet.properties.title; const tab = { sheetId: 200 + ss.tabs.length, title: t, rows: [] }; ss.tabs.push(tab); return this.json(res, 200, { replies: [{ addSheet: { properties: { sheetId: tab.sheetId, title: t } } }] }); }
      if (!rangeRaw) return this.json(res, 200, { properties: { title: ss.title }, sheets: ss.tabs.map((t, i) => ({ properties: { sheetId: t.sheetId, title: t.title, index: i } })) });
      const rm = /^'((?:[^']|'')+)'!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(rangeRaw);
      if (!rm) return this.json(res, 400, { error: { code: 400, message: 'bad range' } });
      const tab = ss.tabs.find(t => t.title === rm[1].replace(/''/g, "'")); if (!tab) return this.json(res, 400, { error: { code: 400, message: 'Unable to parse range' } });
      const c1 = rm[2], r1 = rm[3] ? Number(rm[3]) : undefined, c2 = rm[4], r2 = rm[5] ? Number(rm[5]) : r1;
      const ci = (c: string) => c.charCodeAt(0) - 65;
      if (append) {
        const vals = JSON.parse(raw).values[0].map(String); tab.rows.push(vals); const row = tab.rows.length;
        return this.json(res, 200, { updates: { updatedRange: `'${tab.title}'!A${row}:Q${row}`, updatedRows: 1 } });
      }
      if (method === 'PUT') { const vals = JSON.parse(raw).values[0].map(String); while (tab.rows.length < (r1 as number)) tab.rows.push([]); tab.rows[(r1 as number) - 1] = vals; return this.json(res, 200, { updatedRange: rangeRaw }); }
      // GET
      if (!r1 && c1 === (c2 ?? c1))   // whole-column read (e.g. B:B), as the real Sheets API returns it
        return this.json(res, 200, { values: tab.rows.map(r => [r[ci(c1)] ?? '']) });
      
      const row = tab.rows[(r1 as number) - 1] ?? []; const cells = row.slice(ci(c1), ci(c2 ?? c1) + 1);
      return this.json(res, 200, cells.some(Boolean) ? { values: [cells] } : {});
    });
  }
}
