const crypto = require('crypto');
const pool = require('../src/db/pool');

const DEMO_TENANTS = [
  { name: 'Demo Free Co', apiKey: 'mb_demo_free_0000000000000000', planId: 'free' },
  { name: 'Demo Pro Co', apiKey: 'mb_demo_pro_00000000000000000', planId: 'pro' },
];

function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

async function seed() {
  for (const tenant of DEMO_TENANTS) {
    await pool.query(
      `INSERT INTO tenants (name, api_key_hash, plan_id, plan_status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (api_key_hash) DO UPDATE SET plan_id = EXCLUDED.plan_id, plan_status = 'active'`,
      [tenant.name, hashApiKey(tenant.apiKey), tenant.planId]
    );
    console.log(`${tenant.name} (${tenant.planId}) api key: ${tenant.apiKey}`);
  }
}

seed()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
