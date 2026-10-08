const express = require('express');
const webhookService = require('../services/webhookService');

const router = express.Router();

router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const result = await webhookService.handle(req.body, req.get('stripe-signature'));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
