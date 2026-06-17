'use strict';

require('dotenv').config();

const express = require('express');
const cron = require('node-cron');
const { verifyStripeSignature } = require('./utils/verify-stripe');
const { verifyFrameioSignature } = require('./utils/verify-frameio');
const onboardingAgent = require('./agents/onboarding');
const productionAgent = require('./agents/production');

const app = express();

// Raw body required for signature verification on these routes
app.use('/stripe-webhook', express.raw({ type: '*/*' }));
app.use('/frameio-webhook', express.raw({ type: '*/*' }));

// JSON parsing for all other routes
app.use(express.json());

// ─── POST /stripe-webhook ────────────────────────────────────────────────────
app.post('/stripe-webhook', async (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = verifyStripeSignature(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[ONBOARDING] Stripe signature verification failed:', err.message);
    return res.status(401).json({ error: 'Webhook signature verification failed' });
  }

  // Acknowledge immediately
  res.status(200).json({ received: true });

  if (event.type !== 'customer.created') return;

  const customer = event.data.object;
  const desc = (customer.description || '').toLowerCase();
  const meta = JSON.stringify(customer.metadata || {}).toLowerCase();

  if (!desc.includes('veyra 10-pack') && !meta.includes('veyra 10-pack')) {
    console.log('[ONBOARDING] Skipping non-Veyra-10-Pack customer:', customer.email);
    return;
  }

  console.log('[ONBOARDING] Webhook received — customer.created:', customer.name || customer.email);

  onboardingAgent.handleNewCustomer(customer).catch(err => {
    console.error('[ONBOARDING] Unhandled error in handleNewCustomer:', err.message);
  });
});

// ─── POST /notion-webhook ────────────────────────────────────────────────────
app.post('/notion-webhook', async (req, res) => {
  // Always return 200 — process async
  res.status(200).json({ received: true });

  const page = req.body;

  // Only process rows from the Client DB
  const dbId = page?.parent?.database_id;
  if (dbId && dbId !== process.env.NOTION_CLIENT_DB_ID) {
    console.log('[ONBOARDING] Notion webhook — wrong database, skipping');
    return;
  }

  // Skip if already processed (form already submitted)
  const formSubmitted = page?.properties?.['Onboarding Form Submitted']?.checkbox;
  if (formSubmitted === true) {
    console.log('[ONBOARDING] Notion webhook — form already submitted, skipping');
    return;
  }

  // Skip rows created by the Stripe agent — they already have Slack Channel set.
  // Real form submissions arrive without a Slack Channel (it's not a form field).
  const slackChannel = page?.properties?.['Slack Channel']?.rich_text?.[0]?.plain_text;
  if (slackChannel) {
    console.log('[ONBOARDING] Notion webhook — agent-created row (Slack Channel set), skipping');
    return;
  }

  console.log('[ONBOARDING] Notion webhook received — new Client DB row');

  onboardingAgent.handleFormSubmission(page).catch(err => {
    console.error('[ONBOARDING] Unhandled error in handleFormSubmission:', err.message);
  });
});

// ─── POST /frameio-webhook ───────────────────────────────────────────────────
app.post('/frameio-webhook', (req, res) => {
  const sig = req.headers['x-frameio-signature'] || req.headers['x-signature'];

  if (process.env.FRAMEIO_WEBHOOK_SECRET) {
    if (!verifyFrameioSignature(req.body, sig)) {
      console.error('[PRODUCTION] Frame.io signature verification failed');
      return res.status(401).json({ error: 'Webhook signature verification failed' });
    }
  } else {
    console.warn('[PRODUCTION] FRAMEIO_WEBHOOK_SECRET not set — accepting unverified request');
  }

  // Return 200 immediately per Frame.io requirements
  res.status(200).json({ received: true });

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (err) {
    console.error('[PRODUCTION] Failed to parse Frame.io payload:', err.message);
    return;
  }

  console.log('[PRODUCTION] Frame.io webhook received:', event.type);

  // project.updated fires for all project changes — filter for ready_for_review status
  if (event.type === 'project.updated' || event.type === 'project.status_updated') {
    const status = event.data?.status || event.resource?.status;
    if (status === 'ready_for_review') {
      productionAgent.handleReadyForReview(event).catch(err => {
        console.error('[PRODUCTION] Unhandled error in handleReadyForReview:', err.message);
      });
    } else {
      console.log('[PRODUCTION] Frame.io project update ignored — status:', status);
    }
  // asset_label.updated fires when someone clicks Approve on a review link
  } else if (event.type === 'asset_label.updated' || event.type === 'review_link.approved') {
    const label = event.data?.label || event.resource?.label;
    if (!label || label === 'approved') {
      productionAgent.handleApproval(event).catch(err => {
        console.error('[PRODUCTION] Unhandled error in handleApproval:', err.message);
      });
    } else {
      console.log('[PRODUCTION] Frame.io asset label ignored — label:', label);
    }
  } else {
    console.log('[PRODUCTION] Frame.io event type ignored:', event.type);
  }
});

// ─── POST /notion-storyboard ─────────────────────────────────────────────────
app.post('/notion-storyboard', async (req, res) => {
  // Always return 200
  res.status(200).json({ received: true });

  const page = req.body;
  const status = page?.properties?.['Status']?.select?.name;
  const storyboardSent = page?.properties?.['Storyboard Sent to Client']?.checkbox;

  if (status !== 'Storyboard Review') {
    console.log('[PRODUCTION] Storyboard webhook — status not Storyboard Review, skipping');
    return;
  }

  if (storyboardSent === true) {
    console.log('[PRODUCTION] Storyboard webhook — already sent, skipping');
    return;
  }

  console.log('[PRODUCTION] Storyboard webhook received — triggering review');

  productionAgent.handleStoryboardReview(page).catch(err => {
    console.error('[PRODUCTION] Unhandled error in handleStoryboardReview:', err.message);
  });
});

// ─── GET /health ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    agents: ['onboarding', 'production'],
    timestamp: new Date().toISOString(),
  });
});

// ─── Scheduler ───────────────────────────────────────────────────────────────
cron.schedule('0 */6 * * *', async () => {
  console.log('[SCHEDULER] Cron triggered — running pending onboarding check');
  try {
    await onboardingAgent.checkPendingOnboarding();
  } catch (err) {
    console.error('[SCHEDULER] checkPendingOnboarding failed:', err.message);
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Veyra Agent running on port ${PORT}`);
  console.log('Onboarding Agent ready');
  console.log('Production Agent ready');
  console.log('Scheduler running every 6 hours');
});
