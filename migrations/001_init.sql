CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_api_call_limit INTEGER NOT NULL,
  monthly_token_limit BIGINT NOT NULL
);

INSERT INTO plans (id, name, monthly_api_call_limit, monthly_token_limit) VALUES
  ('free', 'Free', 1000, 100000),
  ('pro', 'Pro', 50000, 5000000)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL REFERENCES plans(id) DEFAULT 'free',
  plan_status TEXT NOT NULL DEFAULT 'active',
  stripe_customer_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions (tenant_id);

CREATE TABLE IF NOT EXISTS usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  api_calls INTEGER NOT NULL DEFAULT 1,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros BIGINT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_created ON usage_events (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
