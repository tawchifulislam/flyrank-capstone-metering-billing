const alertRepository = require('../repositories/alertRepository');
const notifier = require('./notifier');

const THRESHOLDS = [80, 100];
const MAX_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function crossed(before, after, limit, threshold) {
  return before * 100 < threshold * limit && after * 100 >= threshold * limit;
}

async function deliver(payload, periodStart) {
  const id = await alertRepository.claim(payload.tenantId, payload.metric, payload.threshold, periodStart);
  if (!id) {
    return;
  }

  const baseDelay = Number(process.env.ALERT_RETRY_BASE_MS) || 100;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await notifier.send(payload, attempt);
      await alertRepository.update(id, { status: 'sent', attempts: attempt });
      return;
    } catch (err) {
      lastError = err.message;
      await alertRepository.update(id, { status: 'pending', attempts: attempt, error: lastError });
      if (attempt < MAX_ATTEMPTS) {
        await sleep(baseDelay * 2 ** (attempt - 1));
      }
    }
  }

  await alertRepository.update(id, { status: 'failed', attempts: MAX_ATTEMPTS, error: lastError });
  console.error(
    `ALERT usage alert delivery failed after ${MAX_ATTEMPTS} attempts: tenant=${payload.tenantId} metric=${payload.metric} threshold=${payload.threshold} error=${lastError}`
  );
}

function dispatch({ tenant, periodStart, before, requestedTokens, plan }) {
  try {
    const afterCalls = before.apiCalls + 1;
    const afterTokens = before.tokens + requestedTokens;
    const metrics = [
      { metric: 'api_calls', before: before.apiCalls, after: afterCalls, limit: plan.apiCallLimit },
      { metric: 'tokens', before: before.tokens, after: afterTokens, limit: plan.tokenLimit },
    ];

    for (const m of metrics) {
      for (const threshold of THRESHOLDS) {
        if (crossed(m.before, m.after, m.limit, threshold)) {
          const payload = {
            tenantId: tenant.id,
            tenantName: tenant.name,
            plan: plan.name,
            metric: m.metric,
            threshold,
            used: m.after,
            limit: m.limit,
          };
          setImmediate(() => {
            deliver(payload, periodStart).catch((err) => console.error('alert job error:', err.message));
          });
        }
      }
    }
  } catch (err) {
    console.error('alert dispatch error:', err.message);
  }
}

module.exports = { dispatch };
