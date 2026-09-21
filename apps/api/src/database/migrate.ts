import './load-env';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const sql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS valid_until timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS support_contact text NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Shanghai';
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL, mobile text, role text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS password_reset_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mobile text NOT NULL, code_hash text NOT NULL,
  expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_codes_mobile_idx ON password_reset_codes(mobile, created_at DESC);
ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique_idx ON users(username) WHERE username IS NOT NULL;
CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL, slug text NOT NULL UNIQUE, description text NOT NULL DEFAULT '', venue text NOT NULL DEFAULT '',
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled', 'ended')),
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS events_tenant_status_idx ON events(tenant_id, status);
ALTER TABLE events ADD COLUMN IF NOT EXISTS hero_color text NOT NULL DEFAULT '#101828';
ALTER TABLE events ADD COLUMN IF NOT EXISTS form_background_color text NOT NULL DEFAULT '#f8f7f2';
ALTER TABLE events ADD COLUMN IF NOT EXISTS registration_form jsonb NOT NULL DEFAULT '[
  {"id":"name","key":"name","label":"姓名","type":"text","required":true,"enabled":true,"system":true,"placeholder":"请输入真实姓名"},
  {"id":"mobile","key":"mobile","label":"手机号","type":"mobile","required":true,"enabled":true,"system":true,"placeholder":"用于接收票券通知"}
]'::jsonb;
-- 更新列默认值，使新建活动不再包含邮箱字段
ALTER TABLE events ALTER COLUMN registration_form SET DEFAULT '[
  {"id":"name","key":"name","label":"姓名","type":"text","required":true,"enabled":true,"system":true,"placeholder":"请输入真实姓名"},
  {"id":"mobile","key":"mobile","label":"手机号","type":"mobile","required":true,"enabled":true,"system":true,"placeholder":"用于接收票券通知"}
]'::jsonb;
-- 修复已有活动中使用旧默认值的记录：去掉邮箱字段（仅自动移除默认邮箱，保留自定义配置）
UPDATE events SET registration_form = (
  SELECT jsonb_agg(field ORDER BY ordinality)
  FROM jsonb_array_elements(registration_form) WITH ORDINALITY AS t(field, ordinality)
  WHERE field->>'key' != 'email'
)
WHERE registration_form IS NOT NULL
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(registration_form) AS field WHERE field->>'key' = 'email' AND field->>'system' = 'true');
CREATE TABLE IF NOT EXISTS ticket_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL, price_cents integer NOT NULL CHECK (price_cents >= 0), capacity integer NOT NULL CHECK (capacity > 0),
  sold_count integer NOT NULL DEFAULT 0 CHECK (sold_count >= 0), sale_starts_at timestamptz NOT NULL, sale_ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), CHECK (sale_ends_at > sale_starts_at), CHECK (sold_count <= capacity)
);
CREATE INDEX IF NOT EXISTS ticket_types_event_idx ON ticket_types(tenant_id, event_id);
CREATE TABLE IF NOT EXISTS registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), event_id uuid NOT NULL REFERENCES events(id),
  ticket_type_id uuid NOT NULL REFERENCES ticket_types(id), attendee_name text NOT NULL, attendee_mobile text NOT NULL, attendee_email text,
  status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS registrations_event_idx ON registrations(tenant_id, event_id, status);
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS form_data jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), event_id uuid NOT NULL REFERENCES events(id),
  registration_id uuid NOT NULL UNIQUE REFERENCES registrations(id), order_no text NOT NULL UNIQUE, amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'closed', 'refunded')),
  paid_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), event_id uuid NOT NULL REFERENCES events(id),
  registration_id uuid NOT NULL UNIQUE REFERENCES registrations(id), code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'checked_in', 'void', 'refunded')),
  checked_in_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tickets_event_status_idx ON tickets(tenant_id, event_id, status);
CREATE TABLE IF NOT EXISTS checkin_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), event_id uuid NOT NULL REFERENCES events(id),
  name text NOT NULL, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS checkin_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), event_id uuid NOT NULL REFERENCES events(id),
  ticket_id uuid NOT NULL REFERENCES tickets(id), checkin_point_id uuid NOT NULL REFERENCES checkin_points(id), operator_id uuid NOT NULL REFERENCES users(id),
  result text NOT NULL CHECK (result IN ('success', 'duplicate', 'invalid')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkin_records_event_idx ON checkin_records(tenant_id, event_id, created_at DESC);
CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL, published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(created_at) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id), scope text NOT NULL, key text NOT NULL, response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, scope, key)
);
CREATE TABLE IF NOT EXISTS platform_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text NOT NULL UNIQUE, display_name text NOT NULL,
  password_hash text NOT NULL, role text NOT NULL CHECK (role IN ('super_admin', 'operations', 'finance', 'auditor')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), platform_user_id uuid NOT NULL REFERENCES platform_users(id),
  action text NOT NULL, target_type text NOT NULL, target_id text, detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_audit_created_idx ON platform_audit_logs(created_at DESC);
CREATE TABLE IF NOT EXISTS subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, name text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0), event_limit integer, attendee_limit integer,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')), created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO subscription_plans(code, name, price_cents, event_limit, attendee_limit) VALUES
  ('starter', '启航版', 0, 3, 500), ('pro', '专业版', 199900, 50, 20000), ('enterprise', '企业版', 0, NULL, NULL)
ON CONFLICT (code) DO NOTHING;
INSERT INTO tenants(id, name) VALUES ('00000000-0000-4000-8000-000000000001', 'EventVivid 示例企业') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id, tenant_id, name, mobile, role) VALUES (
  '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '演示管理员', '13800000000', 'tenant_admin'
) ON CONFLICT (id) DO NOTHING;
`;

async function migrate() {
  const client = new Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://eventvivid:eventvivid@localhost:5432/eventvivid' });
  await client.connect();
  await client.query(sql);
  const username = process.env.HQ_ADMIN_USERNAME ?? 'admin';
  const password = process.env.HQ_ADMIN_PASSWORD;
  if (!password) throw new Error('HQ_ADMIN_PASSWORD is required for the initial platform administrator');
  const passwordHash = await bcrypt.hash(password, 12);
  await client.query(
    `INSERT INTO platform_users(id, username, display_name, password_hash, role)
     VALUES ($1, $2, $3, $4, 'super_admin') ON CONFLICT (username) DO NOTHING`,
    [randomUUID(), username, '总部超级管理员', passwordHash],
  );
  await client.end();
  console.log('EventVivid database migrated.');
}
void migrate();
