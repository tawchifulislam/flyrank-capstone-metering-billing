async function send(payload, attempt) {
  const mode = process.env.ALERT_NOTIFIER_MODE || 'ok';
  if (mode === 'fail') {
    throw new Error('notifier unavailable');
  }
  if (mode === 'flaky' && attempt < 3) {
    throw new Error('notifier temporarily unavailable');
  }
  console.log(
    `EMAIL to ${payload.tenantName}: ${payload.metric} usage reached ${payload.threshold}% (${payload.used} of ${payload.limit}) on the ${payload.plan} plan`
  );
}

module.exports = { send };
