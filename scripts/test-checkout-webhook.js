'use strict';

// Sends a synthetic, correctly-signed checkout.session.completed event to the
// /stripe-webhook endpoint, mimicking a purchase through the Paid Trial EN or
// Paid Trial NL Payment Link (metadata: plan=trial, language=en|nl), so
// onboarding can be exercised without a real Stripe payment.
//
// Usage:
//   STRIPE_WEBHOOK_SECRET=whsec_... node scripts/test-checkout-webhook.js <language> [url]
//
// Example:
//   STRIPE_WEBHOOK_SECRET=whsec_... node scripts/test-checkout-webhook.js en
//   STRIPE_WEBHOOK_SECRET=whsec_... node scripts/test-checkout-webhook.js nl
//   STRIPE_WEBHOOK_SECRET=whsec_... node scripts/test-checkout-webhook.js nl http://localhost:3000/stripe-webhook

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const [, , languageArg, urlArg] = process.argv;

const plan = 'trial';
const language = (languageArg || 'en').toLowerCase();
const endpoint = urlArg || process.env.WEBHOOK_URL || 'https://agents.veyrastudios.eu/stripe-webhook';
const secret = process.env.STRIPE_WEBHOOK_SECRET;

if (!secret) {
  console.error('Set STRIPE_WEBHOOK_SECRET in your environment before running this script.');
  process.exit(1);
}

if (!['en', 'nl'].includes(language)) {
  console.error(`Unknown language "${language}" — expected en or nl.`);
  process.exit(1);
}

const TEST_IDENTITIES = {
  en: { name: 'Test Customer EN', email: 'test-en@example.com' },
  nl: { name: 'Test Klant NL', email: 'test-nl@example.com' },
};
const who = TEST_IDENTITIES[language];

const now = Math.floor(Date.now() / 1000);

const payload = JSON.stringify({
  id: `evt_test_${now}`,
  object: 'event',
  type: 'checkout.session.completed',
  created: now,
  data: {
    object: {
      id: `cs_test_${now}`,
      object: 'checkout.session',
      customer: `cus_test_${now}`,
      created: now,
      customer_details: {
        name: who.name,
        email: who.email,
      },
      metadata: {
        plan,
        language,
      },
    },
  },
});

const signedPayload = `${now}.${payload}`;
const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
const stripeSignatureHeader = `t=${now},v1=${signature}`;

const target = new URL(endpoint);
const client = target.protocol === 'http:' ? http : https;

console.log(`Sending checkout.session.completed test event — Paid Trial ${language.toUpperCase()}`);
console.log(`Target: ${endpoint}`);

const req = client.request(
  {
    method: 'POST',
    hostname: target.hostname,
    port: target.port || (target.protocol === 'http:' ? 80 : 443),
    path: target.pathname + target.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Stripe-Signature': stripeSignatureHeader,
    },
  },
  (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      console.log(`Response: ${res.statusCode} ${res.statusMessage}`);
      if (data) console.log(data);
      console.log('\nCheck your server logs for [ONBOARDING] entries, and Slack/Notion for the result.');
    });
  }
);

req.on('error', (err) => {
  console.error('Request failed:', err.message);
  process.exit(1);
});

req.write(payload);
req.end();
