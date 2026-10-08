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

async function sendSigned(event) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: config.stripe.webhookSecret,
  });
  const res = await fetch(`${BASE}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
    body: payload,
  });
  return { status: res.status, json: await res.json() };
}

async function sendRaw(payload, signature) {
  const res = await fetch(`${BASE}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
    body: payload,
  });
  return { status: res.status, json: await res.json() };
}

async function tenantRow(tenantId) {
  const { rows } = await pool.query('SELECT plan_id, plan_status FROM tenants WHERE id = $1', [tenantId]);
  return rows[0];
}

async function count(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows[0].n;
}

async function generate(apiKey, key) {
  const res = await fetch(`${BASE}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'Idempotency-Key': key },
    body: JSON.stringify({ prompt: 'x' }),
  });
  return res.status;
}

function eventId() {
  return `evt_test_${crypto.randomBytes(8).toString('hex')}`;
}

async function main() {
  const t = await createTenant('webhook-co');
  const customer = `cus_test_${crypto.randomBytes(6).toString('hex')}`;
  const subscription = `sub_test_${crypto.randomBytes(6).toString('hex')}`;

  const forgedId = eventId();
  const forged = await sendRaw(
    JSON.stringify({ id: forgedId, type: 'checkout.session.completed', data: { object: {} } }),
    't=1,v1=forged'
  );
  assert.strictEqual(forged.status, 400);
  assert.strictEqual(forged.json.error.code, 'invalid_signature');
  assert.strictEqual(await count('SELECT count(*)::int AS n FROM stripe_events WHERE id = $1', [forgedId]), 0);
  assert.deepStrictEqual(await tenantRow(t.id), { plan_id: 'free', plan_status: 'active' });
  pass('forged signature returns 400 and nothing changes');

  const checkoutId = eventId();
  const checkout = {
    id: checkoutId,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_x',
        object: 'checkout.session',
        mode: 'subscription',
        client_reference_id: t.id,
        customer,
        subscription,
        metadata: { tenant_id: t.id },
      },
    },
  };

  const first = await sendSigned(checkout);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.json.duplicate, false);
  assert.deepStrictEqual(await tenantRow(t.id), { plan_id: 'pro', plan_status: 'active' });
  pass('signed checkout.session.completed flips the tenant Free to Pro', JSON.stringify(first.json));

  const replay = await sendSigned(checkout);
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.json.duplicate, true);
  assert.strictEqual(await count('SELECT count(*)::int AS n FROM stripe_events WHERE id = $1', [checkoutId]), 1);
  assert.strictEqual(
    await count('SELECT count(*)::int AS n FROM subscriptions WHERE stripe_subscription_id = $1', [subscription]),
    1
  );
  pass('replaying the same event is ignored and processed once', JSON.stringify(replay.json));

  const subscriptionEvent = (status) => ({
    id: eventId(),
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: subscription,
        object: 'subscription',
        status,
        customer,
        metadata: { tenant_id: t.id },
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      },
    },
  });

  const pastDue = await sendSigned(subscriptionEvent('past_due'));
  assert.strictEqual(pastDue.status, 200);
  assert.deepStrictEqual(await tenantRow(t.id), { plan_id: 'pro', plan_status: 'past_due' });
  assert.strictEqual(await generate(t.apiKey, 'wh-1'), 402);
  pass('subscription past_due sets plan_status past_due and /generate returns 402');

  const active = await sendSigned(subscriptionEvent('active'));
  assert.strictEqual(active.status, 200);
  assert.deepStrictEqual(await tenantRow(t.id), { plan_id: 'pro', plan_status: 'active' });
  assert.strictEqual(await generate(t.apiKey, 'wh-2'), 201);
  pass('subscription active restores access and /generate returns 201');

  const deleted = await sendSigned({
    id: eventId(),
    object: 'event',
    type: 'customer.subscription.deleted',
    data: {
      object: { id: subscription, object: 'subscription', status: 'canceled', customer, metadata: { tenant_id: t.id } },
    },
  });
  assert.strictEqual(deleted.status, 200);
  assert.deepStrictEqual(await tenantRow(t.id), { plan_id: 'free', plan_status: 'active' });
  const subRow = await pool.query('SELECT status FROM subscriptions WHERE stripe_subscription_id = $1', [subscription]);
  assert.strictEqual(subRow.rows[0].status, 'canceled');
  pass('subscription deleted returns the tenant to Free and marks the subscription canceled');

  const unknown = await sendSigned({
    id: eventId(),
    object: 'event',
    type: 'invoice.paid',
    data: { object: {} },
  });
  assert.strictEqual(unknown.status, 200);
  pass('unrelated event types are accepted and ignored');

  console.log('all webhook checks passed');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
