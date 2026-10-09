// Kept separate so deployments can apply this additive migration without running seeds.
export const creditPaymentsSql = `
CREATE TABLE IF NOT EXISTS credit_purchase_orders (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), created_by uuid NOT NULL REFERENCES users(id),
 idempotency_key uuid NOT NULL, pack_count integer NOT NULL CHECK(pack_count IN (100,500,2000)),
 pack_name text NOT NULL, amount_cents integer NOT NULL CHECK(amount_cents > 0),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','paid','failed','expired')),
 req_date char(8) NOT NULL, req_seq_id varchar(32) NOT NULL UNIQUE, huifu_id varchar(32) NOT NULL,
 app_id text NOT NULL, hf_seq_id text UNIQUE, pay_info jsonb, payment_started_at timestamptz,
 last_queried_at timestamptz, next_query_at timestamptz NOT NULL DEFAULT now(),
 paid_at timestamptz, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS credit_purchase_tenant_idx ON credit_purchase_orders(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS credit_purchase_reconcile_idx ON credit_purchase_orders(next_query_at) WHERE status='processing';
CREATE TABLE IF NOT EXISTS credit_payment_notifications (
 id text PRIMARY KEY, order_id uuid NOT NULL REFERENCES credit_purchase_orders(id),
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS credit_payment_oauth_states (
 state_hash char(64) PRIMARY KEY, order_id uuid NOT NULL REFERENCES credit_purchase_orders(id),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
`;
