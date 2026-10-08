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

async function rollupForPeriod(client, tenantId, start, end) {
  const { rows } = await client.query(
    `SELECT
       COALESCE(SUM(api_calls), 0) AS api_calls,
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
       COALESCE(SUM(cost_micros), 0) AS cost_micros,
       COALESCE(SUM(cost_api_calls_micros), 0) AS cost_api_calls_micros,
       COALESCE(SUM(cost_input_micros), 0) AS cost_input_micros,
       COALESCE(SUM(cost_cached_input_micros), 0) AS cost_cached_input_micros,
       COALESCE(SUM(cost_output_micros), 0) AS cost_output_micros
     FROM usage_events
     WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
    [tenantId, start, end]
  );
  const r = rows[0];
  return {
    apiCalls: Number(r.api_calls),
    inputTokens: Number(r.input_tokens),
    cachedInputTokens: Number(r.cached_input_tokens),
    outputTokens: Number(r.output_tokens),
    reasoningTokens: Number(r.reasoning_tokens),
    costMicros: Number(r.cost_micros),
    costApiCallsMicros: Number(r.cost_api_calls_micros),
    costInputMicros: Number(r.cost_input_micros),
    costCachedInputMicros: Number(r.cost_cached_input_micros),
    costOutputMicros: Number(r.cost_output_micros),
  };
}

async function insert(client, event) {
  const { rowCount } = await client.query(
    `INSERT INTO usage_events
       (id, tenant_id, idempotency_key, request_hash, api_calls, input_tokens,
        cached_input_tokens, output_tokens, reasoning_tokens, cost_micros,
        cost_api_calls_micros, cost_input_micros, cost_cached_input_micros,
        cost_output_micros, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
      event.costBreakdown.api_calls,
      event.costBreakdown.input,
      event.costBreakdown.cached_input,
      event.costBreakdown.output_and_reasoning,
      JSON.stringify(event.result),
    ]
  );
  return rowCount === 1;
}

module.exports = { lockTenant, findByKey, sumForPeriod, rollupForPeriod, insert };
