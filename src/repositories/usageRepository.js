async function lockTenant(client, tenantId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tenantId]);
}

async function findByKey(client, tenantId, idempotencyKey) {
  const { rows } = await client.query(
    'SELECT id, request_hash, result FROM usage_events WHERE tenant_id = $1 AND idempotency_key = $2',
    [tenantId, idempotencyKey]
  );
  return rows[0] || null;
}

async function sumForPeriod(client, tenantId, start, end) {
  const { rows } = await client.query(
    `SELECT
       COALESCE(SUM(api_calls), 0) AS api_calls,
       COALESCE(SUM(input_tokens + cached_input_tokens + output_tokens + reasoning_tokens), 0) AS tokens
     FROM usage_events
     WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
    [tenantId, start, end]
  );
  return { apiCalls: Number(rows[0].api_calls), tokens: Number(rows[0].tokens) };
}

async function insert(client, event) {
  const { rowCount } = await client.query(
    `INSERT INTO usage_events
       (id, tenant_id, idempotency_key, request_hash, api_calls, input_tokens,
        cached_input_tokens, output_tokens, reasoning_tokens, cost_micros, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [
      event.id,
      event.tenantId,
      event.idempotencyKey,
      event.requestHash,
      event.apiCalls,
      event.inputTokens,
      event.cachedInputTokens,
      event.outputTokens,
      event.reasoningTokens,
      event.costMicros,
      JSON.stringify(event.result),
    ]
  );
  return rowCount === 1;
}

module.exports = { lockTenant, findByKey, sumForPeriod, insert };
