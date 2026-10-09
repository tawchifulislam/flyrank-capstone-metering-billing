require('dotenv').config({ quiet: true });
const assert = require('assert');
const crypto = require('crypto');
const Stripe = require('stripe');

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_replace_me';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_replace_me');

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
  const text = await res.text();
  return { status: res.status, replayed: res.headers.get('idempotent-replayed'), text, json: JSON.parse(text) };
}

async function usage(apiKey) {
  const res = await fetch(`${BASE}/usage`, { headers: { 'x-api-key': apiKey } });
  return res.json();
}

async function postWebhook(payload, signature) {
  const res = await fetch(`${BASE}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
    body: payload,
  });
  return { status: res.status, json: await res.json() };
}

async function postSigned(event) {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return postWebhook(payload, signature);
}

function checkoutEvent(tenantId, eventId) {
  return {
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_probe',
        object: 'checkout.session',
        mode: 'subscription',
        client_reference_id: tenantId,
        customer: `cus_probe_${crypto.randomBytes(6).toString('hex')}`,
        subscription: `sub_probe_${crypto.randomBytes(6).toString('hex')}`,
        metadata: { tenant_id: tenantId },
      },
    },
  };
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

async function probe1() {
  const t = await createTenant('probe1');
  const body = { prompt: 'hello', input_tokens: 100 };
  const first = await generate(t.apiKey, 'probe1-key', body);
  const second = await generate(t.apiKey, 'probe1-key', body);
  assert.strictEqual(first.status, 201);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.replayed, 'true');
  assert.strictEqual(second.text, first.text);
  const u = await usage(t.apiKey);
  assert.strictEqual(u.api_calls.used, 1);
  return `201 then 200, identical bodies, usage shows api_calls.used = ${u.api_calls.used}`;
}

async function probe2() {
  const t = await createTenant('probe2');
  for (let i = 1; i <= 1000; i += 1) {
    const r = await generate(t.apiKey, `p2-${i}`, { prompt: 'x' });
    assert.strictEqual(r.status, 201, `call ${i} should be allowed, got ${r.status}`);
  }
  const over = await generate(t.apiKey, 'p2-1001', { prompt: 'x' });
  assert.strictEqual(over.status, 429);
  assert.ok(over.json.error.message.length > 0);
  const u = await usage(t.apiKey);
  assert.strictEqual(u.api_calls.used, 1000);
  return `call 1000 allowed, call 1001 gives 429: "${over.json.error.message}"`;
}

async function probe3() {
  const t = await createTenant('probe3');
  const before = await usage(t.apiKey);
  assert.strictEqual(before.plan, 'free');
  assert.strictEqual(before.api_calls.limit, 1000);
  const hook = await postSigned(checkoutEvent(t.id, newId('evt_probe')));
  assert.strictEqual(hook.status, 200);
  const after = await usage(t.apiKey);
  assert.strictEqual(after.plan, 'pro');
  assert.strictEqual(after.api_calls.limit, 50000);
  assert.strictEqual(after.tokens.limit, 5000000);
  return `Free (${before.api_calls.limit} calls) to Pro (${after.api_calls.limit} calls, ${after.tokens.limit} tokens) after the signed checkout webhook`;
}

async function probe4() {
  const t = await createTenant('probe4');
  const forgedEvent = JSON.stringify(checkoutEvent(t.id, newId('evt_forged')));
  const forged = await postWebhook(forgedEvent, 't=1,v1=forged');
  assert.strictEqual(forged.status, 400);
  const unchanged = await usage(t.apiKey);
  assert.strictEqual(unchanged.plan, 'free');

  const eventId = newId('evt_replay');
  const first = await postSigned(checkoutEvent(t.id, eventId));
  const again = await postSigned(checkoutEvent(t.id, eventId));
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.json.duplicate, false);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.duplicate, true);
  const after = await usage(t.apiKey);
  assert.strictEqual(after.plan, 'pro');
  return `forged signature gives 400 and the plan stays ${unchanged.plan}; a real event replayed twice is processed once`;
}

async function probe5() {
  const t = await createTenant('probe5');
  const a = await generate(t.apiKey, 'p5-a', { prompt: 'a', input_tokens: 10000, cached_input_tokens: 10000, output_tokens: 10000 });
  const b = await generate(t.apiKey, 'p5-b', { prompt: 'b', output_tokens: 5000, reasoning_tokens: 5000 });
  const c = await generate(t.apiKey, 'p5-c', { prompt: 'c', input_tokens: 1 });
  assert.strictEqual(a.json.cost_micros, 29750);
  assert.strictEqual(b.json.cost_micros, 26000);
  assert.strictEqual(c.json.cost_micros, 1001);
  const u = await usage(t.apiKey);
  assert.deepStrictEqual(u.tokens.by_type, { input: 10001, cached_input: 10000, output: 15000, reasoning: 5000 });
  assert.deepStrictEqual(u.cost_breakdown, { api_calls: 3000, input: 3001, cached_input: 750, output_and_reasoning: 50000 });
  assert.strictEqual(u.cost_micros, 56751);
  assert.strictEqual(u.cost_usd, '0.056751');
  return `cached input and reasoning tokens priced correctly, GET /usage total ${u.cost_micros} micro-dollars (${u.cost_usd} USD)`;
}

async function main() {
  const probes = [
    ['PROBE 1', 'same request twice, one usage event, second response mirrors the first', probe1],
    ['PROBE 2', 'exact quota boundary returns 429 with a clear message', probe2],
    ['PROBE 3', 'Checkout webhook flips Free to Pro and GET /usage shows the new limits', probe3],
    ['PROBE 4', 'forged webhook returns 400, replayed event processed once', probe4],
    ['PROBE 5', 'pinned pricing rules produce the exact totals', probe5],
  ];

  let failed = 0;
  for (const [label, title, run] of probes) {
    try {
      const detail = await run();
      console.log(`${label} PASS  ${title}\n         ${detail}`);
    } catch (err) {
      failed += 1;
      console.log(`${label} FAIL  ${title}\n         ${err.message}`);
    }
  }

  console.log(failed === 0 ? 'all 5 probes passed' : `${failed} probe(s) failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
