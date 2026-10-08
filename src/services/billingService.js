const config = require('../config');
const stripe = require('../stripe');
const { AppError } = require('../errors');
const tenantRepository = require('../repositories/tenantRepository');

async function createCheckout(tenant) {
  if (tenant.plan_id === 'pro' && tenant.plan_status === 'active') {
    throw new AppError(409, 'already_subscribed', 'This tenant is already on the Pro plan');
  }

  try {
    let customerId = await tenantRepository.getStripeCustomerId(tenant.id);
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: tenant.name,
        metadata: { tenant_id: tenant.id },
      });
      customerId = await tenantRepository.setStripeCustomerId(tenant.id, customer.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: tenant.id,
      line_items: [{ price: config.stripe.priceIdPro, quantity: 1 }],
      success_url: `${config.publicBaseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.publicBaseUrl}/billing/cancel`,
      metadata: { tenant_id: tenant.id },
      subscription_data: { metadata: { tenant_id: tenant.id } },
    });

    return { url: session.url };
  } catch (err) {
    console.error('stripe checkout error:', err.message);
    throw new AppError(502, 'stripe_error', 'Could not create the checkout session');
  }
}

module.exports = { createCheckout };
