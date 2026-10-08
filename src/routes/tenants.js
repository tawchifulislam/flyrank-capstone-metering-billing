const express = require('express');
const tenantService = require('../services/tenantService');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

router.post('/', async (req, res, next) => {
  try {
    const tenant = await tenantService.createTenant(req.body);
    res.status(201).json(tenant);
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireApiKey, (req, res) => {
  res.json(req.tenant);
});

module.exports = router;
