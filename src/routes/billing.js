const express = require('express');
const billingService = require('../services/billingService');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

router.post('/checkout', requireApiKey, async (req, res, next) => {
  try {
    const session = await billingService.createCheckout(req.tenant);
    res.status(201).json(session);
  } catch (err) {
    next(err);
  }
});

router.get('/success', (req, res) => {
  res.json({ message: 'Payment received. Your plan updates when Stripe confirms it by webhook.' });
});

router.get('/cancel', (req, res) => {
  res.json({ message: 'Checkout canceled. Your plan is unchanged.' });
});

module.exports = router;
