const config = require('../config');

const MILLION = 1000000;

function ceilDiv(numerator, denominator) {
  return Math.floor((numerator + denominator - 1) / denominator);
}

function calculateCost(usage, pricing = config.pricing) {
  const apiCalls = usage.apiCalls === undefined ? 1 : usage.apiCalls;
  const inputTokens = usage.inputTokens || 0;
  const cachedInputTokens = usage.cachedInputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const reasoningTokens = usage.reasoningTokens || 0;

  const breakdown = {
    api_calls: apiCalls * pricing.apiCallMicros,
    input: ceilDiv(inputTokens * pricing.inputPerMillionMicros, MILLION),
    cached_input: ceilDiv(cachedInputTokens * pricing.cachedInputPerMillionMicros, MILLION),
    output_and_reasoning: ceilDiv(
      (outputTokens + reasoningTokens) * pricing.outputPerMillionMicros,
      MILLION
    ),
  };

  const total =
    breakdown.api_calls +
    breakdown.input +
    breakdown.cached_input +
    breakdown.output_and_reasoning;

  return { total, breakdown };
}

module.exports = { calculateCost };
