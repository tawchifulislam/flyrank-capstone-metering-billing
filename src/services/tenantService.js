const crypto = require('crypto');
const { z } = require('zod');
const tenantRepository = require('../repositories/tenantRepository');

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

async function createTenant(input) {
  const { name } = createSchema.parse(input);
  const apiKey = `mb_${crypto.randomBytes(24).toString('hex')}`;
  const tenant = await tenantRepository.create({ name, apiKeyHash: hashApiKey(apiKey) });
  return { ...tenant, api_key: apiKey };
}

async function authenticate(apiKey) {
  return tenantRepository.findByApiKeyHash(hashApiKey(apiKey));
}

module.exports = { createTenant, authenticate };
