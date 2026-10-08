const pool = require('../db/pool');
const planRepository = require('../repositories/planRepository');
const usageRepository = require('../repositories/usageRepository');
const { currentPeriod } = require('./period');

function formatUsd(micros) {
  const whole = Math.floor(micros / 1000000);
  const fraction = String(micros % 1000000).padStart(6, '0');
  return `${whole}.${fraction}`;
}

async function getUsage(tenant) {
  const plan = await planRepository.findById(pool, tenant.plan_id);
  const period = currentPeriod();
  const r = await usageRepository.rollupForPeriod(pool, tenant.id, period.start, period.end);
  const tokensUsed = r.inputTokens + r.cachedInputTokens + r.outputTokens + r.reasoningTokens;

  return {
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    plan: tenant.plan_id,
    plan_status: tenant.plan_status,
    api_calls: { used: r.apiCalls, limit: plan.apiCallLimit },
    tokens: {
      used: tokensUsed,
      limit: plan.tokenLimit,
      by_type: {
        input: r.inputTokens,
        cached_input: r.cachedInputTokens,
        output: r.outputTokens,
        reasoning: r.reasoningTokens,
      },
    },
    cost_micros: r.costMicros,
    cost_usd: formatUsd(r.costMicros),
    cost_breakdown: {
      api_calls: r.costApiCallsMicros,
      input: r.costInputMicros,
      cached_input: r.costCachedInputMicros,
      output_and_reasoning: r.costOutputMicros,
    },
  };
}

module.exports = { getUsage };
