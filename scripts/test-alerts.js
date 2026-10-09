require('dotenv').config({ quiet: true });
const assert = require('assert');
const pool = require('../src/db/pool');

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const MODE = process.env.ALERT_NOTIFIER_MODE || 'ok';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return res.status;
}

async function alertRows(tenantId) {
  const { rows } = await pool.query(
    'SELECT metric, threshold, status, attempts, last_error FROM usage_alerts WHERE tenant_id = $1 ORDER BY threshold',
    [tenantId]
  );
  return rows;
}

async function waitForAlerts(tenantId, count) {
  for (let i = 0; i < 60; i += 1) {
    const rows = await alertRows(tenantId);
    if (rows.length >= count && rows.every((r) => r.status !== 'pending')) {
      return rows;
    }
    await sleep(100);
  }
  throw new Error('alerts did not finish in time');
}

function pass(name, extra) {
  console.log(`ok  ${name}${extra ? `  ${extra}` : ''}`);
}

async function main() {
  const expectedStatus = MODE === 'fail' ? 'failed' : 'sent';
  const expectedAttempts = MODE === 'ok' ? 1 : 3;
  console.log(`notifier mode: ${MODE}`);

  const t = await createTenant('alerts-co');

  const started = Date.now();
  const first = await generate(t.apiKey, 'a1', { prompt: 'x', input_tokens: 80000 });
  const elapsed = Date.now() - started;
  assert.strictEqual(first, 201);
  pass('request that reaches 80% of the token quota is accepted', `${elapsed} ms, alert runs in the background`);

  const rows80 = await waitForAlerts(t.id, 1);
  assert.strictEqual(rows80.length, 1);
  assert.strictEqual(rows80[0].metric, 'tokens');
  assert.strictEqual(rows80[0].threshold, 80);
  assert.strictEqual(rows80[0].status, expectedStatus);
  assert.strictEqual(rows80[0].attempts, expectedAttempts);
  pass('80% alert recorded', `status=${rows80[0].status} attempts=${rows80[0].attempts}`);

  const second = await generate(t.apiKey, 'a2', { prompt: 'x', input_tokens: 20000 });
  assert.strictEqual(second, 201);
  const rows100 = await waitForAlerts(t.id, 2);
  assert.deepStrictEqual(rows100.map((r) => r.threshold), [80, 100]);
  assert.ok(rows100.every((r) => r.status === expectedStatus && r.attempts === expectedAttempts));
  pass('100% alert recorded', `status=${rows100[1].status} attempts=${rows100[1].attempts}`);

  const replay = await generate(t.apiKey, 'a1', { prompt: 'x', input_tokens: 80000 });
  assert.strictEqual(replay, 200);
  await sleep(500);
  assert.strictEqual((await alertRows(t.id)).length, 2);
  pass('a replayed request does not create another alert');

  const blocked = await generate(t.apiKey, 'a3', { prompt: 'x', input_tokens: 1 });
  assert.strictEqual(blocked, 429);
  await sleep(300);
  assert.strictEqual((await alertRows(t.id)).length, 2);
  pass('each threshold fires once per billing period');

  if (MODE === 'fail') {
    assert.ok(rows100[1].last_error);
    pass('failed delivery keeps the error', rows100[1].last_error);
  }

  console.log('all alert checks passed');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
