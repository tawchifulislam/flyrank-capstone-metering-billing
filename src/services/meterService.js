const crypto = require('crypto');
const { z } = require('zod');
const pool = require('../db/pool');
const { AppError } = require('../errors');
const usageRepository = require('../repositories/usageRepository');
const planRepository = require('../repositories/planRepository');
const { calculateCost } = require('./pricing');
const { currentPeriod } = require('./period');

const tokenField = z.number().int().min(0).max(10000000).default(0);

const bodySchema = z.object({
  prompt: z.string().min(1).max(4000),
  input_tokens: tokenField,
  cached_input_tokens: tokenField,
  output_tokens: tokenField,
  reasoning_tokens: tokenField,
});

const keySchema = z.string().trim().min(1).max(128);

function hashRequest(payload) {
  const canonical = JSON.stringify([
    payload.prompt,
    payload.input_tokens,
    payload.cached_input_tokens,
    payload.output_tokens,
    payload.reasoning_tokens,
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function replayFrom(existing, requestHash) {
  if (existing.request_hash !== requestHash) {
    throw new AppError(
      409,
      'idempotency_key_reused',
      'This Idempotency-Key was already used with a different request'
    );
  }
  return { replayed: true, body: existing.result };
}

async function record({ tenant, idempotencyKey, body }) {
  if (!idempotencyKey) {
    throw new AppError(400, 'missing_idempotency_key', 'Idempotency-Key header is required');
  }
  const key = keySchema.parse(idempotencyKey);
  const payload = bodySchema.parse(body);
  const requestHash = hashRequest(payload);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await usageRepository.lockTenant(client, tenant.id);

    const existing = await usageRepository.findByKey(client, tenant.id, key);
    if (existing) {
      const replay = replayFrom(existing, requestHash);
      await client.query('COMMIT');
      return replay;
    }

    if (tenant.plan_status !== 'active') {
      throw new AppError(
        402,
        'payment_required',
        `Your plan is ${tenant.plan_status}. Update your payment method or upgrade to continue`
      );
    }

    const plan = await planRepository.findById(client, tenant.plan_id);
    const period = currentPeriod();
    const used = await usageRepository.sumForPeriod(client, tenant.id, period.start, period.end);
    const requestedTokens =
      payload.input_tokens +
      payload.cached_input_tokens +
      payload.output_tokens +
      payload.reasoning_tokens;
    const retryAfter = Math.max(1, Math.ceil((period.end.getTime() - Date.now()) / 1000));
    const retryHeaders = { 'Retry-After': String(retryAfter) };

    if (used.apiCalls + 1 > plan.apiCallLimit) {
      throw new AppError(
        429,
        'api_call_quota_exceeded',
        `Monthly API call quota of ${plan.apiCallLimit} reached on the ${plan.name} plan`,
        { limit_type: 'api_calls', used: used.apiCalls, limit: plan.apiCallLimit, requested: 1 },
        retryHeaders
      );
    }

    if (used.tokens + requestedTokens > plan.tokenLimit) {
      throw new AppError(
        429,
        'token_quota_exceeded',
        `Monthly token quota of ${plan.tokenLimit} would be exceeded on the ${plan.name} plan`,
        { limit_type: 'tokens', used: used.tokens, limit: plan.tokenLimit, requested: requestedTokens },
        retryHeaders
      );
    }

    const cost = calculateCost({
      apiCalls: 1,
      inputTokens: payload.input_tokens,
      cachedInputTokens: payload.cached_input_tokens,
      outputTokens: payload.output_tokens,
      reasoningTokens: payload.reasoning_tokens,
    });

    const id = crypto.randomUUID();
    const result = {
      id,
      usage: {
        api_calls: 1,
        input_tokens: payload.input_tokens,
        cached_input_tokens: payload.cached_input_tokens,
        output_tokens: payload.output_tokens,
        reasoning_tokens: payload.reasoning_tokens,
      },
      cost_micros: cost.total,
    };

    const inserted = await usageRepository.insert(client, {
      id,
      tenantId: tenant.id,
      idempotencyKey: key,
      requestHash,
      apiCalls: 1,
      inputTokens: payload.input_tokens,
      cachedInputTokens: payload.cached_input_tokens,
      outputTokens: payload.output_tokens,
      reasoningTokens: payload.reasoning_tokens,
      costMicros: cost.total,
      result,
    });

    if (!inserted) {
      const again = await usageRepository.findByKey(client, tenant.id, key);
      const replay = replayFrom(again, requestHash);
      await client.query('COMMIT');
      return replay;
    }

    await client.query('COMMIT');
    return { replayed: false, body: result };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { record };
