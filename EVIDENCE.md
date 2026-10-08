# EVIDENCE

One proof per requirement from the brief. Boxes are ticked only when the proof is pasted below.

## Metering

- [x] A billable action creates exactly one usage event, even under retries, deduplicated by idempotency key.
- [x] Proof that double-counting cannot happen: the same request sent twice, and 8 parallel requests with one key.

Command: `npm run test:quota`

```text
ok  same request twice creates one event, second response mirrors the first  id=53558195-4f90-4858-a9c5-f2751b19aa39
ok  same key with a different payload returns 409
ok  8 parallel requests with one key create exactly one event  1 x 201, 7 x 200
ok  idempotency keys are scoped per tenant
```

The test also counts rows in `usage_events` for the key and asserts the count is 1. The replay response has the header `Idempotent-Replayed: true` and a body byte-identical to the first response.

## Quotas

- [x] Usage is checked against the tenant's plan, and requests over the limit are rejected.
- [x] Responses carry the correct status codes (429 / 402) and a message explaining why.

Command: `npm run test:quota`

```text
ok  calls 1 to 1000 are all allowed
ok  call 1001 returns 429  Monthly API call quota of 1000 reached on the Free plan retry-after=2044661
ok  retrying the accepted call 1000 at the limit still returns 200
ok  token boundary: 99999 then 1 allowed (100000 total), next 1 returns 429  Monthly token quota of 100000 would be exceeded on the Free plan
ok  inactive plan returns 402  Your plan is past_due. Update your payment method or upgrade to continue
all quota and idempotency checks passed
```

Boundary rule: a request is allowed when `used + requested <= limit`. At 999 used, call 1000 succeeds. At 1000 used, call 1001 returns 429.

Raw 429 response for a request that would exceed the token quota (header `Retry-After` is the number of seconds until the next UTC month starts):

```text
HTTP/1.1 429 Too Many Requests
Retry-After: 2044777
Content-Type: application/json; charset=utf-8

{"error":{"code":"token_quota_exceeded","message":"Monthly token quota of 100000 would be exceeded on the Free plan","details":{"limit_type":"tokens","used":1500,"limit":100000,"requested":100001}}}
```

## Cost calculation

- [x] AI token pricing handles cached input tokens, reasoning tokens, and output tokens correctly.
- [x] Pricing constants are pinned in config, with proof of correct totals.

Pricing constants live in `src/config.js` (micro-dollars, 1 USD = 1,000,000):

| Item | Price |
| --- | --- |
| API call | 1,000 per call |
| Input token | 300,000 per 1M tokens |
| Cached input token | 75,000 per 1M tokens |
| Output token | 2,500,000 per 1M tokens |
| Reasoning token | billed as output |

Command: `npm run test:pricing`

```text
ok  all categories at 1M tokens  total=2876000  {"api_calls":1000,"input":300000,"cached_input":75000,"output_and_reasoning":2500000}
ok  reasoning tokens are billed as output  total=2501000  {"api_calls":1000,"input":0,"cached_input":0,"output_and_reasoning":2500000}
ok  fresh input costs more than cached input (input)  total=301000  {"api_calls":1000,"input":300000,"cached_input":0,"output_and_reasoning":0}
ok  fresh input costs more than cached input (cached)  total=76000  {"api_calls":1000,"input":0,"cached_input":75000,"output_and_reasoning":0}
ok  categories are priced separately, not added together  total=1375  {"api_calls":1000,"input":300,"cached_input":75,"output_and_reasoning":0}
ok  one token rounds up to one micro-dollar  total=1001  {"api_calls":1000,"input":1,"cached_input":0,"output_and_reasoning":0}
ok  no tokens costs only the api call  total=1000  {"api_calls":1000,"input":0,"cached_input":0,"output_and_reasoning":0}
ok  period December 2026-12-01T00:00:00.000Z to 2027-01-01T00:00:00.000Z
all pricing checks passed
```

A real request: 1,000 input tokens and 500 output tokens returned `"cost_micros":2550` (1,000 call + 300 input + 1,250 output).

## Stripe integration

- [x] Subscription checkout works end-to-end in Stripe test mode.
- [x] Webhooks verify signatures, ignore duplicate events, and update tenant plan and status.

### Checkout end to end (Stripe sandbox, test mode)

Setup: a Stripe sandbox with a `Pro` monthly product, `stripe listen --events checkout.session.completed,customer.subscription.updated,customer.subscription.deleted --forward-to localhost:3001/webhooks/stripe`, and the server running.

Before payment, a new tenant is on Free:

```text
GET /tenants/me
{"id":"079d0677-6317-4126-a866-9f79589aa6aa","name":"Real Pay Co","plan_id":"free","plan_status":"active","created_at":"2026-10-08T08:37:12.657Z"}
```

`POST /billing/checkout` returned `201` with a Stripe Checkout URL (`https://checkout.stripe.com/c/pay/cs_test_...`). I paid with the test card `4242 4242 4242 4242`. The browser landed on the success page, which only says the plan updates when Stripe confirms it by webhook:

```text
{"message":"Payment received. Your plan updates when Stripe confirms it by webhook."}
```

After the webhook arrived, the same tenant is on Pro:

```text
GET /tenants/me
{"id":"079d0677-6317-4126-a866-9f79589aa6aa","name":"Real Pay Co","plan_id":"pro","plan_status":"active","created_at":"2026-10-08T08:37:12.657Z"}
```

A second checkout attempt for the same tenant is refused:

```text
HTTP/1.1 409 Conflict
{"error":{"code":"already_subscribed","message":"This tenant is already on the Pro plan"}}
```

Database state:

```text
    name     | plan_id | plan_status | sub_status
-------------+---------+-------------+------------
 Real Pay Co | pro     | active      | active

              id              |             type              |         processed_at
------------------------------+-------------------------------+-------------------------------
 evt_1UOCqkDwFHTXIqmPzEPCEDZj | checkout.session.completed    | 2026-10-08 08:38:52.373867+00
```

The plan changes only through a verified webhook event. The success page and the checkout endpoint never change the plan.

### Webhook signature, duplicates and status sync

Command: `npm run test:webhooks` (signs its own payloads with the webhook secret).

```text
ok  forged signature returns 400 and nothing changes
ok  signed checkout.session.completed flips the tenant Free to Pro  {"received":true,"duplicate":false,"outcome":"upgraded"}
ok  replaying the same event is ignored and processed once  {"received":true,"duplicate":true}
ok  subscription past_due sets plan_status past_due and /generate returns 402
ok  subscription active restores access and /generate returns 201
ok  subscription deleted returns the tenant to Free and marks the subscription canceled
ok  unrelated event types are accepted and ignored
all webhook checks passed
```

How it works: the raw request body is verified against the `Stripe-Signature` header before anything else. A bad signature returns `400` and writes nothing. The event id is inserted into `stripe_events` (primary key) inside the same transaction as the plan update, so a replayed event hits the conflict, returns `200` and changes nothing.

Still to add in Phase 4: `GET /usage` showing the new Pro limits after the upgrade.

## Data model, tests and documentation

- [x] Database includes tenants, plans, subscriptions and usage events, with customer data isolated per tenant (every query filters by the `tenant_id` of the authenticated API key).
- [ ] README, architecture diagram and setup instructions.

Pending (Phase 4).
