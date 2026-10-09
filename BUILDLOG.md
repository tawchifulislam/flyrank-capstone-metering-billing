# BUILDLOG

An honest log of where AI helped, where it was wrong, and what I changed.

## Phase 1: Design

- AI helped draft DESIGN.md: problem, non-goals, plans and quotas, money rules, data model, API contract, idempotency strategy.
- Change I made: I added `request_hash` to `usage_events` so the same idempotency key with a different payload returns 409 instead of silently replaying.

## Phase 2: Core billing logic

- AI helped write the project setup, migrations, tenant and API key auth, the integer pricing calculator, and the idempotent `POST /generate`.
- Where it was wrong or I had to fix it:
  - A command that piped `curl` into `node -pe` failed in Git Bash (`stdin is not a tty`), so the API key came out empty. I switched to extracting the key with `grep`.
  - The replay response had its JSON keys in a different order than the first response, because Postgres JSONB reorders keys. The content was the same but not byte-identical. I fixed it by formatting the response body in one place in the route, and the test now compares the two responses as exact strings.
- What I verified myself: the quota boundary (call 1000 allowed, call 1001 gets 429), the token boundary (99999 then 1 allowed, next 1 gets 429), 8 parallel requests with one key creating one row, and 402 for an inactive plan.
- Something I can explain in my own words: why a per-tenant advisory lock is taken before the quota check. Two parallel requests at 999 of 1,000 would both read "999 used" and both be allowed, giving 1,001. The lock makes them run one after the other.

## Phase 3: Stripe integration

- AI helped write the checkout endpoint, the webhook handler (raw body, signature check, dedupe table, plan sync) and a script that signs its own test payloads.
- Where it was wrong or I had to fix it:
  - The first `stripe listen` command failed with "must specify events to forward". The newer CLI needs `--events`, so I pass the three events the handler uses.
  - My Stripe CLI was already logged in to a different project's account. Checkout would have run in one account while `stripe listen` listened to another, so no webhook would ever arrive. I created a separate sandbox and pass its key to the CLI with `--api-key`, then checked with `stripe products list` that the `Pro` product shows up.
- What I verified myself: a real test-card payment in the sandbox flipped the tenant from Free to Pro through the forwarded webhook, a second checkout returned 409, and the forged and replayed events were rejected and ignored by the signed test script.
- Something I can explain in my own words: the webhook route is mounted before `express.json()` and uses the raw body. The signature is computed over the exact bytes Stripe sent. If JSON parsing runs first and the body is re-serialized, the bytes change and every valid signature would fail.
- Known gaps: subscription period dates stay empty until a `customer.subscription.updated` event arrives, and events that arrive out of order are not reordered. A reconciliation job against Stripe is the stretch goal that would close this.

## Phase 4: Cost rollup, packaging and docs

- AI helped write `GET /usage`, the monthly rollup query, and the test that upgrades a tenant through a signed webhook and checks the totals.
- Where the design was wrong: my first schema stored only the total `cost_micros` per usage event, so the rollup could not show a per-category breakdown that adds up exactly (rounding happens per event). I added migration 002 with four cost columns, store them when the event is created, and backfill old rows with the same constants.
- What I verified myself: the expected totals in the test were worked out by hand first (2,876,000 + 2,501,000 + 1,001 = 5,378,001), and the breakdown sums to the same number.

### Usage alerts (the background job)

- The first plan had no background job. I only caught it when I compared the build against the shared requirements table in Section 12: requirement 3 asks for at least one background job with retries and a failure alert. I added usage alerts (the stretch goal) as that job.
- AI helped write the migration, the notifier, the alert service and the test. The notifier has three modes (`ok`, `flaky`, `fail`) so I can prove the retries and the failure alert without a real email service.
- What I checked myself: the 80% alert fires at exactly 80% (80,000 of 100,000), the 100% alert fires at 100,000 and not before, a replayed request creates no extra alert, and with the notifier down the request still returns in about 15 ms while the log shows the `ALERT` line after 3 attempts.
- Something I can explain in my own words: the alert row is inserted first with a unique key on tenant, metric, threshold and billing period, and the job only continues if that insert created a row. That is what makes each threshold fire once per period even if several requests cross it at nearly the same time. The job starts after the database transaction commits, so a failing alert can never roll back or block a billable request.
