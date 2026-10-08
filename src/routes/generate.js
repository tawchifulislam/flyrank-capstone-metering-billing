const express = require('express');
const meterService = require('../services/meterService');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

function formatResult(result) {
  return {
    id: result.id,
    usage: {
      api_calls: result.usage.api_calls,
      input_tokens: result.usage.input_tokens,
      cached_input_tokens: result.usage.cached_input_tokens,
      output_tokens: result.usage.output_tokens,
      reasoning_tokens: result.usage.reasoning_tokens,
    },
    cost_micros: result.cost_micros,
  };
}

router.post('/', requireApiKey, async (req, res, next) => {
  try {
    const result = await meterService.record({
      tenant: req.tenant,
      idempotencyKey: req.get('idempotency-key'),
      body: req.body,
    });
    if (result.replayed) {
      res.set('Idempotent-Replayed', 'true');
    }
    res.status(result.replayed ? 200 : 201).json(formatResult(result.body));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
