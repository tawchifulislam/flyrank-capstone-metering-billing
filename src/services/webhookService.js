const config = require('../config');
const stripe = require('../stripe');
const pool = require('../db/pool');
const { AppError } = require('../errors');
const billingRepository = require('../repositories/billingRepository');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

function toDate(seconds) {
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}

function planForStatus(status) {
  if (status === 'active' || status === 'trialing') {
    return { planId: 'pro', planStatus: 'active' };
  }
  if (status === 'past_due' || status === 'unpaid') {
    return { planId: 'pro', planStatus: 'past_due' };
  }
  if (status === 'canceled') {
    return { planId: 'free', planStatus: 'active' };
  }
  return null;
}

async function handleCheckoutCompleted(client, session) {
  if (session.mode !== 'subscription') {
    return 'ignored';
  }
  const tenantId = await billingRepository.findTenantId(client, {
    tenantId: validUuid(session.client_reference_id) || validUuid(session.metadata && session.metadata.tenant_id),
    customerId: session.customer,
  });
  if (!tenantId) {
    return 'no_tenant';
  }
  await billingRepository.setTenantPlan(client, tenantId, 'pro', 'active', session.customer);
  if (session.subscription) {
    await billingRepository.upsertSubscription(client, {
      tenantId,
      stripeSubscriptionId: session.subscription,
      planId: 'pro',
      status: 'active',
    });
  }
  return 'upgraded';
}

async function handleSubscriptionChange(client, subscription, deleted) {
  const tenantId = await billingRepository.findTenantId(client, {
    tenantId: validUuid(subscription.metadata && subscription.metadata.tenant_id),
    customerId: subscription.customer,
  });
  if (!tenantId) {
    return 'no_tenant';
  }

  const status = deleted ? 'canceled' : subscription.status;
  const mapped = planForStatus(status);
  if (!mapped) {
    return 'ignored';
  }

  await billingRepository.setTenantPlan(client, tenantId, mapped.planId, mapped.planStatus, subscription.customer);

  const item = subscription.items && subscription.items.data && subscription.items.data[0];
  const start = subscription.current_period_start !== undefined
    ? subscription.current_period_start
    : item && item.current_period_start;
  const end = subscription.current_period_end !== undefined
    ? subscription.current_period_end
    : item && item.current_period_end;

  await billingRepository.upsertSubscription(client, {
    tenantId,
    stripeSubscriptionId: subscription.id,
    planId: 'pro',
    status,
    periodStart: toDate(start),
    periodEnd: toDate(end),
  });
  return `plan_${mapped.planId}_${mapped.planStatus}`;
}

async function applyEvent(client, event) {
  if (event.type === 'checkout.session.completed') {
    return handleCheckoutCompleted(client, event.data.object);
  }
  if (event.type === 'customer.subscription.updated') {
    return handleSubscriptionChange(client, event.data.object, false);
  }
  if (event.type === 'customer.subscription.deleted') {
    return handleSubscriptionChange(client, event.data.object, true);
  }
  return 'ignored';
}

async function handle(rawBody, signature) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
  } catch (err) {
    console.warn('webhook rejected: invalid signature');
    throw new AppError(400, 'invalid_signature', 'Webhook signature verification failed');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const firstTime = await billingRepository.recordEvent(client, event.id, event.type);
    if (!firstTime) {
      await client.query('COMMIT');
      console.log(`webhook ${event.type} ${event.id} duplicate, ignored`);
      return { received: true, duplicate: true };
    }
    const outcome = await applyEvent(client, event);
    await client.query('COMMIT');
    console.log(`webhook ${event.type} ${event.id} processed: ${outcome}`);
    return { received: true, duplicate: false, outcome };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { handle };
