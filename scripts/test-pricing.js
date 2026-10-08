const assert = require('assert');
const { calculateCost } = require('../src/services/pricing');
const { currentPeriod } = require('../src/services/period');

function check(name, usage, expectedTotal) {
  const result = calculateCost(usage);
  assert.strictEqual(result.total, expectedTotal, name);
  console.log(`ok  ${name}  total=${result.total}  ${JSON.stringify(result.breakdown)}`);
}

check(
  'all categories at 1M tokens',
  { apiCalls: 1, inputTokens: 1000000, cachedInputTokens: 1000000, outputTokens: 1000000, reasoningTokens: 0 },
  2876000
);

check(
  'reasoning tokens are billed as output',
  { apiCalls: 1, outputTokens: 500000, reasoningTokens: 500000 },
  2501000
);

check('fresh input costs more than cached input (input)', { apiCalls: 1, inputTokens: 1000000 }, 301000);
check('fresh input costs more than cached input (cached)', { apiCalls: 1, cachedInputTokens: 1000000 }, 76000);

check(
  'categories are priced separately, not added together',
  { apiCalls: 1, inputTokens: 1000, cachedInputTokens: 1000 },
  1375
);

check('one token rounds up to one micro-dollar', { apiCalls: 1, inputTokens: 1 }, 1001);
check('no tokens costs only the api call', { apiCalls: 1 }, 1000);

const period = currentPeriod(new Date('2026-12-15T10:00:00Z'));
assert.strictEqual(period.start.toISOString(), '2026-12-01T00:00:00.000Z');
assert.strictEqual(period.end.toISOString(), '2027-01-01T00:00:00.000Z');
console.log(`ok  period December ${period.start.toISOString()} to ${period.end.toISOString()}`);

console.log('all pricing checks passed');
