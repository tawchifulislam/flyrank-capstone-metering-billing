const assert = require('assert');
const pool = require('../src/db/pool');

const BASE = process.env.BASE_URL || 'http://localhost:3001';

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
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    replayed: res.headers.get('idempotent-replayed'),
    retryAfter: res.headers.get('retry-after'),
    text,
    json: JSON.parse(text),
  };
}

async function countEvents(tenantId, idempotencyKey) {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM usage_events WHERE tenant_id = $1 AND idempotency_key = $2',
    [tenantId, idempotencyKey]
  );
  return rows[0].n;
}

function pass(name, extra) {
  console.log(`ok  ${name}${extra ? `  ${extra}` : ''}`);
}

async function main() {
  const a = await createTenant('probe-a');

  const first = await generate(a.apiKey, 'same-key', { prompt: 'hi', input_tokens: 10 });
  const second = await generate(a.apiKey, 'same-key', { prompt: 'hi', input_tokens: 10 });
  assert.strictEqual(first.status, 201);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.replayed, 'true');
  assert.strictEqual(first.text, second.text);
  assert.strictEqual(await countEvents(a.id, 'same-key'), 1);
  pass('same request twice creates one event, second response mirrors the first', `id=${first.json.id}`);

  const changed = await generate(a.apiKey, 'same-key', { prompt: 'hi', input_tokens: 11 });
  assert.strictEqual(changed.status, 409);
  assert.strictEqual(changed.json.error.code, 'idempotency_key_reused');
  pass('same key with a different payload returns 409');

  const parallel = await Promise.all(
    Array.from({ length: 8 }, () => generate(a.apiKey, 'parallel-key', { prompt: 'p', input_tokens: 5 }))
  );
  const created = parallel.filter((r) => r.status === 201);
  const replays = parallel.filter((r) => r.status === 200);
  assert.strictEqual(created.length, 1);
  assert.strictEqual(replays.length, 7);
  assert.strictEqual(new Set(parallel.map((r) => r.json.id)).size, 1);
  assert.strictEqual(await countEvents(a.id, 'parallel-key'), 1);
  pass('8 parallel requests with one key create exactly one event', '1 x 201, 7 x 200');

  const b = await createTenant('probe-b');
  const other = await generate(b.apiKey, 'same-key', { prompt: 'hi', input_tokens: 10 });
  assert.strictEqual(other.status, 201);
  assert.notStrictEqual(other.json.id, first.json.id);
  pass('idempotency keys are scoped per tenant');

  const c = await createTenant('calls');
  for (let i = 1; i <= 1000; i += 1) {
    const r = await generate(c.apiKey, `call-${i}`, { prompt: 'x' });
    assert.strictEqual(r.status, 201, `call ${i} should be allowed, got ${r.status}`);
  }
  pass('calls 1 to 1000 are all allowed');

  const over = await generate(c.apiKey, 'call-1001', { prompt: 'x' });
  assert.strictEqual(over.status, 429);
  assert.strictEqual(over.json.error.code, 'api_call_quota_exceeded');
  assert.ok(over.retryAfter);
  pass('call 1001 returns 429', `${over.json.error.message} retry-after=${over.retryAfter}`);

  const retry = await generate(c.apiKey, 'call-1000', { prompt: 'x' });
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.replayed, 'true');
  pass('retrying the accepted call 1000 at the limit still returns 200');

  const t = await createTenant('tokens');
  const t1 = await generate(t.apiKey, 't1', { prompt: 'x', input_tokens: 99999 });
  const t2 = await generate(t.apiKey, 't2', { prompt: 'x', input_tokens: 1 });
  const t3 = await generate(t.apiKey, 't3', { prompt: 'x', input_tokens: 1 });
  assert.strictEqual(t1.status, 201);
  assert.strictEqual(t2.status, 201);
  assert.strictEqual(t3.status, 429);
  assert.strictEqual(t3.json.error.code, 'token_quota_exceeded');
  assert.strictEqual(t3.json.error.details.used, 100000);
  pass('token boundary: 99999 then 1 allowed (100000 total), next 1 returns 429', t3.json.error.message);

  const d = await createTenant('past-due');
  await pool.query("UPDATE tenants SET plan_status = 'past_due' WHERE id = $1", [d.id]);
  const blocked = await generate(d.apiKey, 'p1', { prompt: 'x' });
  assert.strictEqual(blocked.status, 402);
  assert.strictEqual(blocked.json.error.code, 'payment_required');
  pass('inactive plan returns 402', blocked.json.error.message);

  console.log('all quota and idempotency checks passed');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
