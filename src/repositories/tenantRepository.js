const pool = require('../db/pool');

const COLUMNS = 'id, name, plan_id, plan_status, created_at';

async function create({ name, apiKeyHash }) {
  const { rows } = await pool.query(
    `INSERT INTO tenants (name, api_key_hash) VALUES ($1, $2) RETURNING ${COLUMNS}`,
    [name, apiKeyHash]
  );
  return rows[0];
}

async function findByApiKeyHash(apiKeyHash) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM tenants WHERE api_key_hash = $1`,
    [apiKeyHash]
  );
  return rows[0] || null;
}

async function getStripeCustomerId(tenantId) {
  const { rows } = await pool.query('SELECT stripe_customer_id FROM tenants WHERE id = $1', [tenantId]);
  return rows[0] ? rows[0].stripe_customer_id : null;
}

async function setStripeCustomerId(tenantId, customerId) {
  const { rows } = await pool.query(
    'UPDATE tenants SET stripe_customer_id = COALESCE(stripe_customer_id, $2) WHERE id = $1 RETURNING stripe_customer_id',
    [tenantId, customerId]
  );
  return rows[0].stripe_customer_id;
}

module.exports = { create, findByApiKeyHash, getStripeCustomerId, setStripeCustomerId };
