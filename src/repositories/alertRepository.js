const pool = require('../db/pool');

async function claim(tenantId, metric, threshold, periodStart) {
  const { rows } = await pool.query(
    `INSERT INTO usage_alerts (tenant_id, metric, threshold, period_start)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, metric, threshold, period_start) DO NOTHING
     RETURNING id`,
    [tenantId, metric, threshold, periodStart]
  );
  return rows[0] ? rows[0].id : null;
}

async function update(id, { status, attempts, error }) {
  await pool.query(
    'UPDATE usage_alerts SET status = $2, attempts = $3, last_error = $4, updated_at = now() WHERE id = $1',
    [id, status, attempts, error || null]
  );
}

module.exports = { claim, update };
