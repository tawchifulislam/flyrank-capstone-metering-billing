const { AppError } = require('../errors');
const tenantService = require('../services/tenantService');

async function requireApiKey(req, res, next) {
  try {
    const apiKey = req.get('x-api-key');
    if (!apiKey) {
      throw new AppError(401, 'missing_api_key', 'x-api-key header is required');
    }
    const tenant = await tenantService.authenticate(apiKey);
    if (!tenant) {
      throw new AppError(401, 'invalid_api_key', 'Invalid API key');
    }
    req.tenant = tenant;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireApiKey };
