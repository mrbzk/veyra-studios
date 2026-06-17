'use strict';

const Stripe = require('stripe');

function verifyStripeSignature(rawBody, signature, webhookSecret) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_placeholder');
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

module.exports = { verifyStripeSignature };
