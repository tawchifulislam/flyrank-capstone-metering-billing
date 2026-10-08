const express = require('express');
const usageService = require('../services/usageService');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireApiKey, async (req, res, next) => {
  try {
    res.json(await usageService.getUsage(req.tenant));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
