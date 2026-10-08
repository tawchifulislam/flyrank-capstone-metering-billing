# Design: Usage Metering & Billing Engine

## Problem

SaaS products need to answer three questions for every customer: how much have they used, how much do they owe, and have they hit their plan limit. This service meters usage per tenant, enforces plan quotas, calculates costs with correct money math, and keeps subscription plans in sync with Stripe through verified, idempotent webhooks. The hard part is correctness: a retried request must never be double-counted, and a replayed webhook must never be processed twice.

## Non-goals

- No real payments. Stripe test mode only.
- No invoicing, proration, or overage billing in the core build. These are stretch goals.
- No real AI model calls. Token counts are simulated, because this service meters numbers and does not run models.
- No frontend or dashboard UI. The API is the product.
