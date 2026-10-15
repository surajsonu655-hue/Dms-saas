-- DMS SaaS initial schema (PostgreSQL 14+)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only (immutable)', TG_TABLE_NAME USING ERRCODE = '42501'; END; $$ LANGUAGE plpgsql;

-- ---------- platform ----------
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  price numeric(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  billing_cycle text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','quarterly','yearly')),
  max_users int, max_delivery_partners int, max_orders_per_month int,   -- NULL = unlimited
  api_access boolean NOT NULL DEFAULT false,
  google_sheets boolean NOT NULL DEFAULT false,
  whatsapp boolean NOT NULL DEFAULT false,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  business_type text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','suspended')),
  phone text, email text, whatsapp_number text,
  address text, city text, state text, pincode text,
  logo_key text,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX businesses_name_uq ON businesses (lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE business_settings (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  cod_enabled boolean NOT NULL DEFAULT true,
  returns_enabled boolean NOT NULL DEFAULT true,
  partial_delivery_enabled boolean NOT NULL DEFAULT true,
  otp_required boolean NOT NULL DEFAULT false,
  photo_required boolean NOT NULL DEFAULT false,
  signature_required boolean NOT NULL DEFAULT false,
  payment_proof_required boolean NOT NULL DEFAULT true,
  return_photo_required boolean NOT NULL DEFAULT true,
  gps_required boolean NOT NULL DEFAULT false,
  payment_modes text[] NOT NULL DEFAULT ARRAY['cod','prepaid','upi','card','other'],
  order_prefix text NOT NULL DEFAULT 'ORD',
  manager_report_scope text NOT NULL DEFAULT 'complete' CHECK (manager_report_scope IN ('same_day','weekly','monthly','yearly','complete')),
  notification_prefs jsonb NOT NULL DEFAULT '{"in_app":true,"email":false,"whatsapp":false}'::jsonb,
  delivery_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id),
  status text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','past_due','expired','cancelled')),
  start_date date NOT NULL DEFAULT current_date,
  renewal_date date,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,  -- per-business overrides of plan limits
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- identity ----------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,   -- NULL only for the platform owner
  role text NOT NULL CHECK (role IN ('owner','business_admin','manager','delivery_partner')),
  name text NOT NULL,
  email citext NOT NULL UNIQUE,
  mobile text,
  designation text,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  duty_on boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_has_no_business CHECK ((role = 'owner') = (business_id IS NULL))
);
CREATE INDEX users_business_role_idx ON users (business_id, role) WHERE deleted_at IS NULL;

CREATE TABLE roles (
  role text PRIMARY KEY CHECK (role IN ('owner','business_admin','manager','delivery_partner')),
  label text NOT NULL, rank int NOT NULL
);
CREATE TABLE permissions (
  key text PRIMARY KEY, category text NOT NULL, description text NOT NULL, scope text NOT NULL DEFAULT 'business' CHECK (scope IN ('platform','business'))
);
CREATE TABLE role_permissions (   -- defaults applied when a user of that role is created
  role text NOT NULL REFERENCES roles(role), permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role, permission_key)
);
CREATE TABLE user_permissions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_key)
);
CREATE INDEX user_permissions_business_idx ON user_permissions (business_id, permission_key);

CREATE TABLE sessions (    -- refresh-token backed sessions; revoking one invalidates its access tokens immediately
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text, user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ---------- customers & orders ----------
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL, mobile text NOT NULL, address text, area text, city text, pincode text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, mobile)
);
CREATE INDEX customers_search_idx ON customers (business_id, lower(name));

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  invoice_number text NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id),
  customer_name text NOT NULL, customer_mobile text NOT NULL, customer_address text NOT NULL, area text,
  bill_amount numeric(12,2) NOT NULL CHECK (bill_amount > 0),
  change_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (change_amount >= 0),
  receivable_amount numeric(12,2) NOT NULL CHECK (receivable_amount >= 0),   -- bill + change, computed server-side
  payment_mode text NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','ready','assigned','accepted','picked_up','out_for_delivery','arrived','delivered','partial','failed','full_return','cancelled')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  delivery_date date, notes text, remarks text,
  assigned_manager_id uuid REFERENCES users(id),
  current_partner_id uuid REFERENCES users(id),
  attempts int NOT NULL DEFAULT 0,
  otp_hash text,
  -- outcome (original amounts are never overwritten)
  returned_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (returned_amount >= 0),
  delivered_amount numeric(12,2),
  collected_amount numeric(12,2) NOT NULL DEFAULT 0,
  change_given numeric(12,2) NOT NULL DEFAULT 0,
  payment_mismatch boolean NOT NULL DEFAULT false,
  final_amount numeric(12,2),
  final_status text NOT NULL DEFAULT 'pending' CHECK (final_status IN ('pending','complete','incomplete')),
  verified_by uuid REFERENCES users(id), verified_at timestamptz, manager_remarks text,
  completed_at timestamptz,
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, invoice_number)
);
CREATE INDEX orders_biz_status_idx ON orders (business_id, status, created_at DESC);
CREATE INDEX orders_biz_created_idx ON orders (business_id, created_at DESC);
CREATE INDEX orders_partner_idx ON orders (business_id, current_partner_id, status);
CREATE INDEX orders_customer_idx ON orders (business_id, customer_id);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku text, name text NOT NULL, quantity numeric(12,3) NOT NULL CHECK (quantity > 0), unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0), total numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

-- ---------- deliveries ----------
CREATE TABLE deliveries (            -- one row per delivery attempt
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  attempt_no int NOT NULL,
  partner_id uuid REFERENCES users(id),
  status text NOT NULL,
  accepted_at timestamptz, picked_up_at timestamptz, out_for_delivery_at timestamptz, arrived_at timestamptz, completed_at timestamptz,
  failure_reason text, failure_notes text,
  proof jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, attempt_no)
);
CREATE INDEX deliveries_partner_idx ON deliveries (business_id, partner_id);

CREATE TABLE delivery_assignments (  -- full assignment history, never overwritten
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  delivery_id uuid REFERENCES deliveries(id) ON DELETE SET NULL,
  partner_id uuid NOT NULL REFERENCES users(id),
  previous_partner_id uuid REFERENCES users(id),
  assigned_by uuid REFERENCES users(id),
  reason text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz, end_reason text,   -- 'reassigned' | 'rejected' | 'completed'
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_assignments_order_idx ON delivery_assignments (order_id);

CREATE TABLE delivery_events (       -- immutable lifecycle log
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  delivery_id uuid REFERENCES deliveries(id) ON DELETE SET NULL,
  previous_status text, new_status text NOT NULL,
  changed_by uuid REFERENCES users(id), user_role text,
  latitude numeric(9,6), longitude numeric(9,6),
  notes text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_events_order_idx ON delivery_events (order_id, created_at);
CREATE TRIGGER delivery_events_immutable BEFORE UPDATE OR DELETE ON delivery_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- files ----------
CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  storage_key text NOT NULL, kind text NOT NULL,  -- photo | signature | payment_proof | return_photo | document | logo
  mime_type text NOT NULL, size_bytes int NOT NULL,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_order_idx ON files (business_id, order_id);

-- ---------- money ----------
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  delivery_id uuid REFERENCES deliveries(id),
  mode text NOT NULL, amount numeric(12,2) NOT NULL CHECK (amount >= 0), expected_amount numeric(12,2) NOT NULL,
  change_given numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','mismatch')),
  reference text, proof_file_id uuid REFERENCES files(id),
  collected_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_idx ON payments (order_id);

CREATE TABLE cod_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES users(id),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  reference_no text, notes text,
  settled_by uuid REFERENCES users(id), settled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cod_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES users(id),
  expected_amount numeric(12,2) NOT NULL CHECK (expected_amount >= 0),
  collected_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (collected_amount >= 0),
  change_given numeric(12,2) NOT NULL DEFAULT 0,
  settled_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (settled_amount >= 0),
  status text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','collected','submitted','settled','void')),
  submitted_at timestamptz, settled_at timestamptz, last_settlement_id uuid REFERENCES cod_settlements(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (settled_amount <= collected_amount)
);
CREATE INDEX cod_partner_idx ON cod_transactions (business_id, partner_id, status);

-- ---------- returns ----------
CREATE TABLE returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  delivery_id uuid REFERENCES deliveries(id),
  return_type text NOT NULL CHECK (return_type IN ('partial','full')),
  original_amount numeric(12,2) NOT NULL, returned_amount numeric(12,2) NOT NULL CHECK (returned_amount > 0), delivered_amount numeric(12,2) NOT NULL CHECK (delivered_amount >= 0),
  reason text NOT NULL, notes text,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','assigned','picked_up','received','verified','closed')),
  photo_file_id uuid REFERENCES files(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_math CHECK (delivered_amount = original_amount - returned_amount)
);
CREATE INDEX returns_biz_idx ON returns (business_id, created_at DESC);
CREATE TABLE return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  return_id uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  order_item_id uuid REFERENCES order_items(id), sku text, name text NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0), unit_price numeric(12,2) NOT NULL, amount numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- notifications, integrations ----------
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','email','whatsapp','webhook')),
  type text NOT NULL, title text NOT NULL, body text, data jsonb NOT NULL DEFAULT '{}'::jsonb,
  recipient text,                         -- phone/email for outbound channels
  status text NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','read','queued','sent','failed')),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, status, created_at DESC);

CREATE TABLE google_sheet_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  google_email text, spreadsheet_id text, sheet_name text NOT NULL DEFAULT 'Orders',
  access_token_enc text, refresh_token_enc text, token_expires_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','error','disconnected')),
  header_written boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE google_sheet_rows (       -- exactly one sheet row per order per connection
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES google_sheet_connections(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  row_id int NOT NULL,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, order_id)
);
CREATE TABLE google_sheet_sync_logs (  -- also the sync job queue (transactional outbox)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES google_sheet_connections(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
  action text NOT NULL DEFAULT 'upsert',
  sync_status text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending','success','failed','dead')),
  attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  row_id int, error_message text, last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sheet_jobs_due_idx ON google_sheet_sync_logs (sync_status, next_attempt_at);
CREATE UNIQUE INDEX sheet_jobs_one_pending ON google_sheet_sync_logs (connection_id, order_id) WHERE sync_status = 'pending';

CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url text NOT NULL, secret text NOT NULL, events text[] NOT NULL DEFAULT ARRAY['*'],
  active boolean NOT NULL DEFAULT true,
  last_delivery_at timestamptz, failure_count int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  webhook_id uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed','dead')),
  attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status int, error_message text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (status, next_attempt_at);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL, key_prefix text NOT NULL, key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_by uuid REFERENCES users(id), revoked_at timestamptz, last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reports (        -- saved report definitions
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL, report_type text NOT NULL, params jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- administrative audit (separate from delivery_events) ----------
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL, user_role text,
  action text NOT NULL, entity text, entity_id text,
  old_value jsonb, new_value jsonb, ip text, user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_biz_idx ON audit_logs (business_id, created_at DESC);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- updated_at triggers
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='updated_at'
           AND table_name NOT IN ('delivery_events','audit_logs') LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_updated', t);
  END LOOP; END $$;
