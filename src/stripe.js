const Stripe = require('stripe');
const config = require('./config');

const stripe = new Stripe(config.stripe.secretKey);

module.exports = stripe;
