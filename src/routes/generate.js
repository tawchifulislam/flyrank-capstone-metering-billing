const express = require('express');
const meterService = require('../services/meterService');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

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
    res.status(result.replayed ? 200 : 201).json(result.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
