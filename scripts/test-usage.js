const assert = require('assert');
const crypto = require('crypto');
const pool = require('../src/db/pool');
const stripe = require('../src/stripe');
const config = require('../src/config');

const BASE = process.env.BASE_URL || 'http://localhost:3001';

function pass(name, extra) {
  console.log(`ok  ${name}${extra ? `  ${extra}` : ''}`);
}

async function createTenant(name) {
  const res = await fetch(`${BASE}/tenants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await res.json();
  return { id: body.id, apiKey: body.api_key };
}

async function generate(apiKey, idempotencyKey, body) {
  const res = await fetch(`${BASE}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function usage(apiKey) {
  const res = await fetch(`${BASE}/usage`, { headers: { 'x-api-key': apiKey } });
  return { status: res.status, json: await res.json() };
}

async function sendSigned(event) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: config.stripe.webhookSecret });
  const res = await fetch(`${BASE}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
    body: payload,
  });
  return res.status;
}

async function main() {
  const noKey = await fetch(`${BASE}/usage`);
  assert.strictEqual(noKey.status, 401);
  pass('GET /usage without an API key returns 401');

  const t = await createTenant('usage-co');
  const other = await createTenant('usage-other');

  const free = await usage(t.apiKey);
  assert.strictEqual(free.status, 200);
  assert.strictEqual(free.json.plan, 'free');
  assert.deepStrictEqual(free.json.api_calls, { used: 0, limit: 1000 });
  assert.strictEqual(free.json.tokens.limit, 100000);
  pass('Free plan limits', `api_calls limit ${free.json.api_calls.limit}, tokens limit ${free.json.tokens.limit}`);

  const customer = `cus_test_${crypto.randomBytes(6).toString('hex')}`;
  const status = await sendSigned({
    id: `evt_test_${crypto.randomBytes(8).toString('hex')}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_usage',
        object: 'checkout.session',
        mode: 'subscription',
        client_reference_id: t.id,
        customer,
        subscription: `sub_test_${crypto.randomBytes(6).toString('hex')}`,
        metadata: { tenant_id: t.id },
      },
    },
  });
  assert.strictEqual(status, 200);

  const pro = await usage(t.apiKey);
  assert.strictEqual(pro.json.plan, 'pro');
  assert.deepStrictEqual(pro.json.api_calls, { used: 0, limit: 50000 });
  assert.strictEqual(pro.json.tokens.limit, 5000000);
  pass('after the Checkout webhook, GET /usage shows the Pro limits', `api_calls limit ${pro.json.api_calls.limit}, tokens limit ${pro.json.tokens.limit}`);

  const r1 = await generate(t.apiKey, 'u1', {
    prompt: 'a',
    input_tokens: 1000000,
    cached_input_tokens: 1000000,
    output_tokens: 1000000,
  });
  const r2 = await generate(t.apiKey, 'u2', { prompt: 'b', output_tokens: 500000, reasoning_tokens: 500000 });
  const r3 = await generate(t.apiKey, 'u3', { prompt: 'c', input_tokens: 1 });
  assert.strictEqual(r1.json.cost_micros, 2876000);
  assert.strictEqual(r2.json.cost_micros, 2501000);
  assert.strictEqual(r3.json.cost_micros, 1001);

  const replay = await generate(t.apiKey, 'u1', {
    prompt: 'a',
    input_tokens: 1000000,
    cached_input_tokens: 1000000,
    output_tokens: 1000000,
  });
  assert.strictEqual(replay.status, 200);

  const u = await usage(t.apiKey);
  assert.strictEqual(u.json.api_calls.used, 3);
  assert.deepStrictEqual(u.json.tokens.by_type, {
    input: 1000001,
    cached_input: 1000000,
    output: 1500000,
    reasoning: 500000,
  });
  assert.strictEqual(u.json.tokens.used, 4000001);
  assert.deepStrictEqual(u.json.cost_breakdown, {
    api_calls: 3000,
    input: 300001,
    cached_input: 75000,
    output_and_reasoning: 5000000,
  });
  assert.strictEqual(u.json.cost_micros, 5378001);
  assert.strictEqual(u.json.cost_usd, '5.378001');
  pass('rollup matches the pinned pricing rules', JSON.stringify(u.json.cost_breakdown));
  pass('replayed request is not counted twice', `api_calls used ${u.json.api_calls.used}`);
  pass('total cost', `${u.json.cost_micros} micro-dollars = ${u.json.cost_usd} USD`);

  const o = await usage(other.apiKey);
  assert.strictEqual(o.json.api_calls.used, 0);
  assert.strictEqual(o.json.cost_micros, 0);
  pass('another tenant sees none of this usage');

  console.log('all usage checks passed');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
