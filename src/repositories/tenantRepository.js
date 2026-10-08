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

module.exports = { create, findByApiKeyHash };
