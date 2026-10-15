# DMS SaaS backend

Node 22 · TypeScript · Express · PostgreSQL (node-postgres, plain SQL migrations) · JWT + refresh sessions · zod validation.

## Run locally
```bash
cp .env.example .env            # fill JWT_SECRET, JWT_REFRESH_SECRET, TOKEN_ENC_KEY (openssl rand -hex 32)
docker compose up -d db         # or use any PostgreSQL 14+
npm install
npm run migrate                 # applies migrations/*.sql once each
npm run seed                    # demo data (3 businesses, 25 users, 30 customers, 50 orders)
npm run dev                     # http://localhost:4000   docs: /api/docs   health: /health
npm test                        # needs a database named dms_test (TEST_DATABASE_URL to override)
```
Production: `npm run build && NODE_ENV=production node dist/src/migrate.js && node dist/src/server.js` (or `docker compose up`). Production refuses to start without the secrets above.

## Demo logins (password `Demo@1234`, dev only)
owner@dms.demo · admin1@store2door.demo · manager1@store2door.demo · partner1@store2door.demo (same pattern for apexpharmacy, crumbco).

## Google Sheets setup
1. Google Cloud Console → APIs & Services → Library: enable **Google Sheets API** and **Google Drive API** (Drive is only used to list spreadsheets; scope `drive.metadata.readonly`).
2. OAuth consent screen: add scopes `.../auth/spreadsheets`, `.../auth/drive.metadata.readonly`, `.../auth/userinfo.email`. While the app is in *Testing*, add each Google account as a test user.
3. Credentials → your OAuth client (type **Web application**):
   - Authorized redirect URI (must match `GOOGLE_REDIRECT_URI` exactly): `http://localhost:4000/api/integrations/google/callback`
   - Authorized JavaScript origins: not needed (the flow is server-side).
4. From the downloaded JSON copy `web.client_id` → `GOOGLE_CLIENT_ID`, `web.client_secret` → `GOOGLE_CLIENT_SECRET` in `.env`.
5. In DMS: Settings → Integrations → Google Sheets → Connect → choose spreadsheet/worksheet → Test → Enable Auto Sync.

## Sheet columns (exact order)
Date, Bill Number, Customer Name, Customer Address, Bill Amount, Change, Receivable Amount, Pay Mode, Delivery Partner, Assigned Time, Out for Delivery Time, Delivered Time, Duration, Return Amount, Final Amount, Status, Remarks.

## Web UI (existing frontend, connected to the API)
`public/index.html` is the existing DMS interface, unchanged. When the backend serves it (`http://localhost:4000/`) it injects `public/dms-api-mode.js`,
which signs in through `/api/auth/*`, loads data from the API and shows server errors. Opened any other way (no backend) the file still works as the standalone demo.

Connected so far (every screen reads/writes the API; the server enforces all rules and permissions):
- **All roles:** login / session restore / logout / change password, role-based navigation.
- **Business Admin & Manager:** dashboard, orders (create, edit, ready, assign/reassign, cancel, retry, verify, details), returns, COD (cash position, settlements), reports (filters, scope, CSV/Excel).
- **Delivery Partner:** assigned orders, accept / pickup / start / arrive, deliver / partial / full return / fail with proof upload, history, duty, own cash + submit.
- **Platform Owner:** dashboard, businesses (suspend / activate / deactivate / delete with confirmation), onboarding, business overview, staff, subscriptions, plans, business-level reports, Business Admin rights.

Also connected: Staff & Team (add/edit/deactivate/reset password/delete, manager permissions), Settings (business details, delivery rules, subscription, API keys, webhooks),
Google Sheets (connect, choose spreadsheet/worksheet, test, auto sync, sync now) and notifications (bell + list).
**Using the bundled UI with Google:** set `FRONTEND_URL=http://localhost:4000` and `GOOGLE_REDIRECT_URI=http://localhost:4000/api/integrations/google/callback`
(and add that exact URI in Google Cloud Console) so Google returns you to this app.

Not connected yet (shown as a notice, never demo data): a Customers screen (the API exists), owner Revenue/Payments, Support tickets, System Settings, owner notifications, and custom roles/rights (no backend for these yet).

```bash
npm run migrate && npm run seed && npm run dev      # then open http://localhost:4000  (admin1@store2door.demo / Demo@1234)
npm test                                           # 119 tests incl. browser-simulated end-to-end runs of the UI against the live API + PostgreSQL
```
