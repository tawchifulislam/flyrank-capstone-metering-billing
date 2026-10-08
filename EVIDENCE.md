# EVIDENCE

One proof per requirement from the brief. Boxes are ticked only when the proof is pasted below.

## Metering

- [x] A billable action creates exactly one usage event, even under retries, deduplicated by idempotency key.
- [x] Proof that double-counting cannot happen: the same request sent twice, and 8 parallel requests with one key.

Command: `npm run test:quota`

```
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

```
ok  calls 1 to 1000 are all allowed
ok  call 1001 returns 429  Monthly API call quota of 1000 reached on the Free plan retry-after=2044661
ok  retrying the accepted call 1000 at the limit still returns 200
ok  token boundary: 99999 then 1 allowed (100000 total), next 1 returns 429  Monthly token quota of 100000 would be exceeded on the Free plan
ok  inactive plan returns 402  Your plan is past_due. Update your payment method or upgrade to continue
all quota and idempotency checks passed
```

Boundary rule: a request is allowed when `used + requested <= limit`. At 999 used, call 1000 succeeds. At 1000 used, call 1001 returns 429.

Raw 429 response for a request that would exceed the token quota (header `Retry-After` is the number of seconds until the next UTC month starts):

```
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
|---|---|
| API call | 1,000 per call |
| Input token | 300,000 per 1M tokens |
| Cached input token | 75,000 per 1M tokens |
| Output token | 2,500,000 per 1M tokens |
| Reasoning token | billed as output |

Command: `npm run test:pricing`

```
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

- [ ] Subscription checkout works end-to-end in Stripe test mode.
- [ ] Webhooks verify signatures, ignore duplicate events, and update tenant plan and status.

Pending (Phase 3).

## Data model, tests and documentation

- [x] Database includes tenants, plans, subscriptions and usage events, with customer data isolated per tenant (every query filters by the `tenant_id` of the authenticated API key).
- [ ] README, architecture diagram and setup instructions.

Pending (Phase 4).
