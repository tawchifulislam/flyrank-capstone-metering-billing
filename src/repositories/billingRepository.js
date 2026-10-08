async function recordEvent(client, eventId, type) {
  const { rowCount } = await client.query(
    'INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
    [eventId, type]
  );
  return rowCount === 1;
}

async function findTenantId(client, { tenantId, customerId }) {
  const { rows } = await client.query(
    `SELECT id FROM tenants
     WHERE ($1::uuid IS NOT NULL AND id = $1::uuid)
        OR ($2::text IS NOT NULL AND stripe_customer_id = $2::text)
     LIMIT 1`,
    [tenantId || null, customerId || null]
  );
  return rows[0] ? rows[0].id : null;
}

async function setTenantPlan(client, tenantId, planId, planStatus, customerId) {
  await client.query(
    `UPDATE tenants
     SET plan_id = $2,
         plan_status = $3,
         stripe_customer_id = COALESCE(stripe_customer_id, $4::text)
     WHERE id = $1`,
    [tenantId, planId, planStatus, customerId || null]
  );
}

async function upsertSubscription(client, sub) {
  await client.query(
    `INSERT INTO subscriptions
       (tenant_id, stripe_subscription_id, plan_id, status, current_period_start, current_period_end)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       status = EXCLUDED.status,
       current_period_start = COALESCE(EXCLUDED.current_period_start, subscriptions.current_period_start),
       current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
       updated_at = now()`,
    [
      sub.tenantId,
      sub.stripeSubscriptionId,
      sub.planId,
      sub.status,
      sub.periodStart || null,
      sub.periodEnd || null,
    ]
  );
}

module.exports = { recordEvent, findTenantId, setTenantPlan, upsertSubscription };
