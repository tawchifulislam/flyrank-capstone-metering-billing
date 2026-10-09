# flyrank-capstone-metering-billing

A usage metering and billing backend for a SaaS product. It answers three questions for every customer (tenant): how much have they used, what does it cost, and have they hit their plan limit.

- Meters API calls and simulated AI tokens per tenant, exactly once, even when a request is retried
- Enforces monthly quotas per plan and answers honestly: `429` when a usage quota is exceeded, `402` when the plan is not in good standing
- Calculates cost in integer micro-dollars with the AI token rules (cached input is cheaper, reasoning tokens count as output)
- Keeps the plan in sync with Stripe (test mode only) through signature-verified, deduplicated webhooks
- Sends usage alerts at 80% and 100% of a quota from a background job with retries

Stack: Node.js 24, Express, PostgreSQL 16, Zod, Stripe (test mode), Docker Compose.

## Architecture

```text
Client
  | x-api-key, Idempotency-Key
  v
+--------------------------------------------------------------+
| routes      HTTP only: parsing, Zod validation, status codes |
+--------------------------------------------------------------+
| services    meterService  usageService  billingService        |
|             webhookService  alertService  pricing  period     |
+--------------------------------------------------------------+
| repositories  all SQL, no business rules                      |
+--------------------------------------------------------------+
                            |
                      PostgreSQL 16
  plans, tenants, subscriptions, usage_events, stripe_events,
  usage_alerts, schema_migrations
```

Three paths through the system:

```text
1. Metering (one write path)
   POST /generate
     -> requireApiKey (tenant resolved from the key, never from the body)
     -> MeterService.record(tenant, idempotencyKey, payload)
          BEGIN
          lock tenant (pg_advisory_xact_lock)
          same key seen before?
            same payload      -> return the stored response (200, no new event)
            different payload -> 409
          plan_status not active -> 402
          used + requested > plan limit -> 429 with Retry-After
          cost = pricing(calls, input, cached input, output + reasoning)
          INSERT usage_event (unique on tenant_id + idempotency_key)
          COMMIT
     -> alertService.dispatch (background, after commit)
     -> 201

2. Read path
   GET /usage -> sum of this month's usage_events -> { used, limit, cost }

3. Payment sync
   POST /billing/checkout -> Stripe Checkout (test mode) -> customer pays
   Stripe signs a webhook -> POST /webhooks/stripe (raw body)
     -> verify signature            (forged -> 400, nothing changes)
     -> INSERT stripe_events(id)    (duplicate id -> 200, ignored)
     -> update tenant plan / status and subscription row
```

## Run it

You need Docker with Compose. Nothing else.

```bash
cp -n .env.example .env
docker compose up --build -d --wait
docker compose exec -T app npm run seed
```

The app listens on `http://localhost:3001`. PostgreSQL is exposed on host port `5433`. Migrations run automatically when the app container starts. The placeholder Stripe values in `.env.example` are enough for everything except the real Stripe Checkout redirect (see "Stripe test mode" below).

Stop and wipe everything, including the database volume:

```bash
docker compose down -v
```

### Demo tenants (created by the seed step)

| Tenant | Plan | API key |
| --- | --- | --- |
| Demo Free Co | free | `mb_demo_free_0000000000000000` |
| Demo Pro Co | pro | `mb_demo_pro_00000000000000000` |

Try it:

```bash
curl -s -X POST http://localhost:3001/generate \
  -H "x-api-key: mb_demo_free_0000000000000000" \
  -H "Idempotency-Key: demo-1" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"hello","input_tokens":1000,"output_tokens":500}'

curl -s http://localhost:3001/usage -H "x-api-key: mb_demo_free_0000000000000000"
```

Send the first request twice: the second answer is identical, carries the header `Idempotent-Replayed: true`, and usage still shows one call.

## API

| Method and path | Auth | What it does |
| --- | --- | --- |
| `GET /health` | none | Liveness check |
| `POST /tenants` | none | Creates a tenant on the Free plan and returns its API key once. Body: `{ "name": "..." }` |
| `GET /tenants/me` | `x-api-key` | The authenticated tenant, with plan and plan status |
| `POST /generate` | `x-api-key`, `Idempotency-Key` | The dummy billable endpoint. Body: `prompt` plus optional `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_tokens` (simulated counts) |
| `GET /usage` | `x-api-key` | This month's usage, limits and cost, with a per-category breakdown |
| `POST /billing/checkout` | `x-api-key` | Creates a Stripe Checkout session for the Pro plan and returns its URL |
| `GET /billing/success`, `GET /billing/cancel` | none | Landing pages after Checkout. They never change the plan |
| `POST /webhooks/stripe` | Stripe signature | Receives signed Stripe events |

Status codes: `201` created, `200` replay of a known request, `400` invalid input or bad signature, `401` missing or wrong API key, `402` plan not in good standing, `409` idempotency key reused with a different payload or already subscribed, `413` body too large, `429` usage quota exceeded, `502` Stripe unreachable.

## Plans and pricing

Quotas reset on the first day of each calendar month (UTC). The token quota counts input, cached input, output and reasoning tokens together.

| Plan | API calls / month | AI tokens / month |
| --- | --- | --- |
| Free | 1,000 | 100,000 |
| Pro | 50,000 | 5,000,000 |

A request is allowed when `used + requested <= limit`. With a limit of 1,000 calls, call 1,000 succeeds and call 1,001 returns `429`.

Money is stored as integer micro-dollars (1 USD = 1,000,000), never floats. The constants live in `src/config.js`:

| Item | Price (micro-dollars) |
| --- | --- |
| API call | 1,000 per call |
| Input token | 300,000 per 1M tokens |
| Cached input token | 75,000 per 1M tokens |
| Output token | 2,500,000 per 1M tokens |
| Reasoning token | billed as output |

Each category is priced separately and rounded up once per request, then summed. Each usage event stores its cost per category when it is created, so changing a price later never rewrites history. The price of the Pro subscription itself is set on the Stripe product in the Stripe dashboard.

## Stripe test mode

Everything works with the placeholder values from `.env.example`, except the real Checkout redirect. To try it:

1. Create a free Stripe sandbox (test mode, no real money, no card needed).
2. Create a product `Pro` with a monthly recurring price.
3. Put the secret key (`sk_test_...`) in `STRIPE_SECRET_KEY` and the price id (`price_...`) in `STRIPE_PRICE_ID_PRO` in `.env`.
4. Forward webhooks with the Stripe CLI and put the printed `whsec_...` secret in `STRIPE_WEBHOOK_SECRET`:

```bash
stripe listen --events checkout.session.completed,customer.subscription.updated,customer.subscription.deleted --forward-to localhost:3001/webhooks/stripe --api-key sk_test_your_key
```

1. Recreate the app so it reads the new values: `docker compose up -d app`.
2. Call `POST /billing/checkout`, open the returned URL and pay with the test card `4242 4242 4242 4242` (any future expiry, any CVC). The webhook flips the tenant from Free to Pro.

Never commit `.env`. It is git-ignored.

## Tests

All tests run inside the app container against the running system:

```bash
docker compose exec -T app node scripts/test-probes.js
docker compose exec -T app node scripts/test-quota.js
docker compose exec -T app node scripts/test-webhooks.js
docker compose exec -T app node scripts/test-usage.js
docker compose exec -T app node scripts/test-alerts.js
docker compose exec -T app node scripts/test-pricing.js
```

- `test-probes.js`: the five acceptance probes from the brief (idempotent replay, exact quota boundary, Checkout flips the plan, forged and replayed webhooks, pricing totals)
- `test-quota.js`: calls 1 to 1000 allowed, 1001 gets `429`, token boundary, parallel requests with one key, `402`
- `test-webhooks.js`: forged signature, replayed event, `past_due`, `active`, canceled
- `test-usage.js`: plan limits in `GET /usage` and the cost rollup
- `test-alerts.js`: 80% and 100% alerts. Run it with `ALERT_NOTIFIER_MODE=fail docker compose up -d --wait app` first to see the retries and the `ALERT` log line
- `test-pricing.js`: unit checks of the pricing rules

The webhook tests sign their own payloads with `STRIPE_WEBHOOK_SECRET`, so they need no Stripe account. `EVIDENCE.md` has the pasted output of every run.

## How this meets the shared requirements

| # | Requirement | Where |
| --- | --- | --- |
| 1 | Layered architecture | `src/routes`, `src/services`, `src/repositories` (HTTP, logic, SQL kept apart) |
| 2 | Validation at the boundary | Zod schemas on every body. Bad input gives a clean `4xx`, malformed JSON `400`, oversized body `413`, never a `500` |
| 3 | At least one background job | Usage alerts (`src/services/alertService.js`): runs after the response, 3 attempts with growing delays, `ALERT` log line on final failure |
| 4 | Real persistence | SQL migrations in `migrations/`, unique keys and indexes, every query scoped by `tenant_id` |
| 5 | Idempotency where it matters | `usage_events` is unique on `(tenant_id, idempotency_key)` behind a per-tenant lock. `stripe_events` has the event id as primary key |
| 6 | Secrets clean | `.env` is git-ignored, `.env.example` has placeholders, API keys are stored only as SHA-256 hashes |
| 7 | Cost tracked, with a budget guard | Cost per request in micro-dollars, attributed to the tenant. The plan quota is the guard: requests over it are rejected with `429` |

## Limitations

- Stripe is test mode only. There is no invoicing, proration or overage billing: a tenant over its quota is blocked, not charged more.
- AI tokens are simulated. The caller sends the token counts, no model is called.
- Webhook events that arrive out of order are not reordered. Subscription period dates stay empty until a `customer.subscription.updated` event arrives, and there is no reconciliation job against Stripe to repair a missed webhook.
- Quotas follow the calendar month (UTC), not the subscription's own billing cycle.
- `POST /tenants` is open and has no rate limit. API keys have no rotation or expiry. This is a demo, not a hardened signup flow.
- The alert notifier is simulated: it logs an `EMAIL` line and sends nothing. Alerts run in the app process, so if the process dies after an alert row is created and before it is delivered, that alert stays `pending` and is not retried after restart.
- Usage for one tenant is processed one request at a time (a per-tenant lock), which keeps quota checks exact but limits throughput for a single very busy tenant.
- Probe 3 uses a signed webhook so it can run unattended. The real browser payment with the test card was done by hand and is documented in `EVIDENCE.md`.

## Project layout

```text
src/
  app.js, server.js, config.js, stripe.js, errors.js
  routes/          HTTP handlers
  services/        meterService, usageService, billingService, webhookService,
                   alertService, notifier, pricing, period, tenantService
  repositories/    SQL: tenant, usage, plan, billing, alert
  middleware/      auth (API key), errorHandler
  db/              pool, migrate
migrations/        001_init, 002_cost_breakdown, 003_usage_alerts
scripts/           seed and the test scripts
DESIGN.md  EVIDENCE.md  BUILDLOG.md  capstone.yaml  .env.example
```

## Environment variables

See `.env.example`: `PORT`, `DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_PRO`, `PUBLIC_BASE_URL`, `ALERT_NOTIFIER_MODE` (`ok`, `flaky` or `fail`, for demonstrating the background job).
