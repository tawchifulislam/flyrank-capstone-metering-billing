# Design: Usage Metering & Billing Engine

## Problem

SaaS products need to answer three questions for every customer: how much have they used, how much do they owe, and have they hit their plan limit. This service meters usage per tenant, enforces plan quotas, calculates costs with correct money math, and keeps subscription plans in sync with Stripe through verified, idempotent webhooks. The hard part is correctness: a retried request must never be double-counted, and a replayed webhook must never be processed twice.

## Non-goals

- No real payments. Stripe test mode only.
- No invoicing, proration, or overage billing in the core build. These are stretch goals.
- No real AI model calls. Token counts are simulated, because this service meters numbers and does not run models.
- No frontend or dashboard UI. The API is the product.

## Plans and quotas

Quotas reset on the first day of each calendar month (UTC).

| Plan | API calls / month | AI tokens / month |
| --- | --- | --- |
| Free | 1,000 | 100,000 |
| Pro | 50,000 | 5,000,000 |

Quota counts total tokens: input + cached input + output + reasoning.

## Money rules

- All money is stored as integer micro-dollars (1 USD = 1,000,000 micro-dollars). Floats are never used.
- Pricing constants live in `src/config.js`:

| Item | Price (micro-dollars) |
| --- | --- |
| API call | 1,000 per call |
| Input token | 300,000 per 1M tokens |
| Cached input token | 75,000 per 1M tokens |
| Output token | 2,500,000 per 1M tokens |
| Reasoning token | billed as output |

- Cost of a request = api call price + input cost + cached input cost + (output + reasoning) cost, each category priced separately and then summed.
- Rounding: each category is rounded up to the next whole micro-dollar once per event.

## Data model

```sql
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_api_call_limit INTEGER NOT NULL,
  monthly_token_limit BIGINT NOT NULL
);

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL REFERENCES plans(id) DEFAULT 'free',
  plan_status TEXT NOT NULL DEFAULT 'active',
  stripe_customer_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
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

CREATE TABLE usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  idempotency_key TEXT NOT NULL,
  api_calls INTEGER NOT NULL DEFAULT 1,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros BIGINT NOT NULL,
  result JSONB NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_usage_events_tenant_created ON usage_events (tenant_id, created_at);

CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Tenancy rule

Every query on `usage_events` and `subscriptions` filters by `tenant_id` taken from the authenticated API key, never from the request body. A tenant can never read or write another tenant's rows.

## Status codes

- `429 Too Many Requests`: the monthly API call or token quota is exceeded. The body names which limit was hit, and a `Retry-After` header points to the next period start.
- `402 Payment Required`: the tenant is on a paid plan whose `plan_status` is not `active` (for example past_due or canceled).
- `400`: invalid input or missing `Idempotency-Key`.
- `401`: missing or invalid API key.

## API contract

All endpoints except `POST /tenants` and `POST /webhooks/stripe` require an `x-api-key` header. The tenant is resolved from the key.

### POST /tenants

Creates a tenant on the Free plan. Returns the API key once. Only its hash is stored.

- `201`: `{ "id", "name", "plan_id", "api_key" }`
- `400`: invalid name

### POST /generate

The dummy billable endpoint. It simulates one AI response and records usage.

Headers: `x-api-key`, `Idempotency-Key` (required, 1 to 128 characters).

Body:

```json
{
  "prompt": "string, 1 to 4000 characters",
  "input_tokens": 0,
  "cached_input_tokens": 0,
  "output_tokens": 0,
  "reasoning_tokens": 0
}
```

Token fields are non-negative integers and default to 0. They are simulated by the caller, so cost and quota behaviour can be tested exactly.

Responses:

- `201`: first time this key is seen. Body: `{ "id", "usage": { ... }, "cost_micros" }`
- `200`: replay of a known key with the same payload. The body is identical to the original response and the header `Idempotent-Replayed: true` is added. No new usage event is created.
- `409`: same key reused with a different payload
- `429`: API call or token quota exceeded, with a message naming the limit and a `Retry-After` header
- `402`: plan status is not active
- `400`: invalid body or missing `Idempotency-Key`
- `401`: missing or invalid API key

### GET /usage

Returns the current month rollup for the tenant:

```json
{
  "period": { "start": "...", "end": "..." },
  "plan": "free",
  "api_calls": { "used": 0, "limit": 1000 },
  "tokens": { "used": 0, "limit": 100000 },
  "cost_micros": 0,
  "cost_breakdown": {
    "api_calls": 0,
    "input": 0,
    "cached_input": 0,
    "output_and_reasoning": 0
  }
}
```

### POST /billing/checkout

Creates a Stripe Checkout session in test mode for the Pro plan. Returns `{ "url" }`.

### POST /webhooks/stripe

Receives Stripe events. Reads the raw body, verifies the signature, deduplicates by event id, then updates the tenant plan and status.

- `400`: invalid signature, nothing changes
- `200`: processed, or already processed (replay ignored)

## Idempotency strategy

The idempotency key is scoped per tenant. The pair `(tenant_id, idempotency_key)` is unique in `usage_events`.

Order of operations inside one database transaction for `POST /generate`:

1. Take a per-tenant advisory lock: `pg_advisory_xact_lock(hashtext(tenant_id))`. Concurrent requests for the same tenant are serialized, so quota checks cannot race.
2. Look up `(tenant_id, idempotency_key)`. If found with the same `request_hash`, return the stored `result` with `200`. If found with a different hash, return `409`. This check happens before the quota check, so a retry of an accepted request still succeeds even if the tenant is now at the limit.
3. Compute this month's usage for the tenant. If `used + requested > limit` for calls or tokens, return `429`.
4. Compute cost with integer math and insert the usage event with its `result`.
5. Commit and return `201`.

The unique constraint is the last line of defence. If two requests somehow pass step 2, one insert fails and is treated as a replay.

Boundary rule: a request is allowed when `used + requested <= limit`. With a limit of 1,000 calls, call number 1,000 succeeds and call number 1,001 returns `429`.

Stripe webhooks use the same idea: `stripe_events.id` is the primary key. An event is inserted first, and a duplicate insert means the event was already processed.

## Layers

- `routes`: HTTP only, parsing, status codes, Zod validation
- `services`: metering, quota, pricing, billing sync rules
- `repositories`: all SQL, no business rules

A route never talks to the database directly, and a repository never decides an HTTP status.
