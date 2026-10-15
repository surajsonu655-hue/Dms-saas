-- Google Sheets integration v2: worksheet selection, auto-sync switch, sync status, OAuth state store.
ALTER TABLE google_sheet_connections
  ADD COLUMN spreadsheet_name text,
  ADD COLUMN sheet_id bigint,                         -- numeric tab id (stable even if the tab is renamed)
  ADD COLUMN sync_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN last_sync_at timestamptz,
  ADD COLUMN sync_status text NOT NULL DEFAULT 'not_configured' CHECK (sync_status IN ('not_configured','ready','syncing','ok','error')),
  ADD COLUMN last_error text,
  ADD COLUMN initial_sync_mode text CHECK (initial_sync_mode IN ('existing','new_only')),
  ADD COLUMN granted_scopes text,
  ADD COLUMN header_status text;
ALTER TABLE google_sheet_rows ADD COLUMN invoice_number text;   -- used to re-locate a row if the user sorts/deletes rows in the sheet

-- A worksheet can feed exactly one business: two tenants can never write into the same tab.
CREATE UNIQUE INDEX google_sheet_connections_target_uq ON google_sheet_connections (spreadsheet_id, sheet_name) WHERE spreadsheet_id IS NOT NULL AND status = 'active';

-- Single-use OAuth `state` values (CSRF + replay protection). Raw Google tokens are never stored here.
CREATE TABLE oauth_states (
  nonce text PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'google_sheets',
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
