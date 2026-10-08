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
