'use strict';

require('dotenv').config();

const express = require('express');
const cron = require('node-cron');
const { verifyStripeSignature } = require('./utils/verify-stripe');
const { verifySlackSignature } = require('./utils/verify-slack');
const onboardingAgent = require('./agents/onboarding');
const productionAgent = require('./agents/production');
const bookingAgent = require('./agents/booking');
const crypto = require('crypto');

const app = express();

// ─── Onboarding trigger: Paid Trial only ────────────────────────────────────
const TRIAL_PLAN = 'Paid Trial';

// Accepts metadata.plan values like "trial", "paid trial", "paid-trial",
// "paid_trial" (case-insensitive).
function isPaidTrial(meta) {
  const plan = (meta?.plan || '').toLowerCase().replace(/[\s_-]+/g, '');
  return plan === 'trial' || plan === 'paidtrial';
}

// Raw body required for signature verification on these routes
app.use('/stripe-webhook', express.raw({ type: '*/*' }));
app.use('/slack-events', express.raw({ type: '*/*' }));
app.use('/slack-interactive', express.raw({ type: '*/*' }));

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

  // Onboarding is triggered ONLY by the two Paid Trial Payment Links
  // ("Paid Trial EN" / "Paid Trial NL"). Each link carries metadata:
  //   plan     = trial
  //   language = en | nl
  // Any other checkout (Spark/Scale/System/Story links, one-off invoices,
  // etc.) is ignored here.
  //
  // Manual test lane: a customer created by hand in the Stripe Dashboard
  // ("+ Add customer") with "test" in the description. Add "NL" as a
  // separate word for a Dutch test (e.g. "test NL"), otherwise English.
  if (event.type === 'customer.created') {
    const customer = event.data.object;
    const description = (customer.description || '').toLowerCase();

    if (!/\btest\b/.test(description)) {
      console.log('[ONBOARDING] customer.created received — ignoring (not a manual test customer)');
      return;
    }

    const language = /\bnl\b/.test(description) ? 'nl' : 'en';

    console.log('[ONBOARDING] Manual test customer.created:', customer.name || customer.email, `(${TRIAL_PLAN}, ${language})`);

    onboardingAgent.handleNewCustomer(customer, TRIAL_PLAN, language).catch(err => {
      console.error('[ONBOARDING] Unhandled error in handleNewCustomer:', err.message);
    });
    return;
  }

  if (event.type !== 'checkout.session.completed') return;

  const session = event.data.object;
  const meta = session.metadata || {};
  const details = session.customer_details || {};

  if (!isPaidTrial(meta)) {
    console.log('[ONBOARDING] Skipping checkout session — not a Paid Trial link:', details.email, `(metadata.plan: "${meta.plan || ''}")`);
    return;
  }

  const languageMeta = (meta.language || '').toLowerCase().trim();
  if (languageMeta !== 'en' && languageMeta !== 'nl') {
    console.warn(`[ONBOARDING] Paid Trial checkout has missing/unknown metadata.language ("${meta.language || ''}") — defaulting to English`);
  }
  const language = languageMeta === 'nl' ? 'nl' : 'en';

  console.log('[ONBOARDING] Webhook received — checkout.session.completed:', details.name || details.email, `(${TRIAL_PLAN}, ${language})`);

  // Reshape into the customer-like object handleNewCustomer expects
  const customer = {
    id: session.customer,
    name: details.name || '',
    email: details.email || '',
    created: session.created,
    description: '',
    metadata: meta,
  };

  onboardingAgent.handleNewCustomer(customer, TRIAL_PLAN, language).catch(err => {
    console.error('[ONBOARDING] Unhandled error in handleNewCustomer:', err.message);
  });
});

// ─── POST /notion-webhook ────────────────────────────────────────────────────
// Previously processed onboarding form submissions. The form is retired:
// clients now go straight to booking their kickoff call, and the Cycle 1
// project is set up at payment time. Kept as a no-op so any leftover Notion
// automation pointing here gets a 200 instead of retrying.
app.post('/notion-webhook', (req, res) => {
  res.status(200).json({ received: true });
  console.log('[ONBOARDING] Notion webhook received — onboarding form is retired, ignoring');
});

// ─── POST /ghl-booking ───────────────────────────────────────────────────────
// Called by a GoHighLevel workflow when a client books their kickoff call
// (trigger: Appointment Booked → action: Webhook, POST to
// https://<server>/ghl-booking?secret=<GHL_WEBHOOK_SECRET>). The secret can
// also be sent as an "x-veyra-secret" header.
function hasValidGhlSecret(req) {
  const expected = process.env.GHL_WEBHOOK_SECRET || '';
  const given = String(req.headers['x-veyra-secret'] || req.query.secret || '');
  if (!expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

app.post('/ghl-booking', (req, res) => {
  if (!process.env.GHL_WEBHOOK_SECRET) {
    console.error('[BOOKING] GHL_WEBHOOK_SECRET is not set — rejecting booking webhook');
    return res.status(503).json({ error: 'Booking webhook not configured' });
  }
  if (!hasValidGhlSecret(req)) {
    console.error('[BOOKING] Invalid or missing secret on /ghl-booking');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(200).json({ received: true });

  bookingAgent.handleKickoffBooked(req.body).catch(err => {
    console.error('[BOOKING] Unhandled error in handleKickoffBooked:', err.message);
  });
});

// ─── POST /notion-storyboard ─────────────────────────────────────────────────
app.post('/notion-storyboard', async (req, res) => {
  // Always return 200
  res.status(200).json({ received: true });

  const payload = req.body;
  const pageId = payload?.id || payload?.page_id || payload?.data?.page_id || payload?.data?.id;

  if (!pageId) {
    console.log('[PRODUCTION] Storyboard webhook — no page ID in payload, keys:', Object.keys(payload || {}).join(', '));
    return;
  }

  // Fetch full page so we have all properties regardless of what Notion sends
  let page;
  try {
    const notion = require('./utils/notion');
    page = await notion.getPage(pageId);
  } catch (err) {
    console.error('[PRODUCTION] Storyboard webhook — failed to fetch page:', err.message);
    return;
  }

  const status = page?.properties?.['Status']?.select?.name;
  const storyboardSent = page?.properties?.['Storyboard Sent to Client']?.checkbox;

  if (status !== 'Storyboard Review') {
    console.log(`[PRODUCTION] Storyboard webhook — status not Storyboard Review, got: "${status}", skipping`);
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

// ─── POST /notion-video-review ───────────────────────────────────────────────
app.post('/notion-video-review', async (req, res) => {
  res.status(200).json({ received: true });

  const payload = req.body;
  const pageId = payload?.id || payload?.page_id || payload?.data?.page_id || payload?.data?.id;

  if (!pageId) {
    console.log('[PRODUCTION] Video review webhook — no page ID in payload, keys:', Object.keys(payload || {}).join(', '));
    return;
  }

  let page;
  try {
    const notion = require('./utils/notion');
    page = await notion.getPage(pageId);
  } catch (err) {
    console.error('[PRODUCTION] Video review webhook — failed to fetch page:', err.message);
    return;
  }

  const reviewStage = page?.properties?.['Review Stage']?.select?.name;
  const mainVideoStatus = page?.properties?.['Main Video Status']?.select?.name;
  const hooksStatus = page?.properties?.['Hooks Status']?.select?.name;

  const isMainVideoReady = reviewStage === 'Main Video' && mainVideoStatus === 'Ready for Review';
  const isHooksReady = reviewStage === 'Hooks' && hooksStatus === 'Ready for Review';

  if (!isMainVideoReady && !isHooksReady) {
    console.log(`[PRODUCTION] Video review webhook — not ready for review (stage: "${reviewStage}", main: "${mainVideoStatus}", hooks: "${hooksStatus}"), skipping`);
    return;
  }

  console.log(`[PRODUCTION] Video review webhook received — stage: ${reviewStage}`);

  productionAgent.handleVideoReview(page).catch(err => {
    console.error('[PRODUCTION] Unhandled error in handleVideoReview:', err.message);
  });
});

// ─── POST /slack-events ──────────────────────────────────────────────────────
app.post('/slack-events', async (req, res) => {
  const rawBody = req.body.toString();
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Slack URL verification challenge (sent when you first save the endpoint)
  if (payload.type === 'url_verification') {
    return res.json({ challenge: payload.challenge });
  }

  // Verify Slack signature
  const sig = req.headers['x-slack-signature'];
  const ts = req.headers['x-slack-request-timestamp'];
  if (!verifySlackSignature(rawBody, sig, ts)) {
    console.error('[SLACK] Signature verification failed');
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  // Acknowledge immediately
  res.status(200).json({ ok: true });

  const event = payload.event;
  if (!event || event.type !== 'message') return;
  if (event.subtype || event.bot_id) return; // ignore edits, deletions, bot messages

  const text = (event.text || '').toLowerCase().trim();
  if (!text.includes('approved') && !text.includes('approve')) return;

  const channelId = event.channel;

  // Resolve channel ID → channel name so the agent can match the Notion row
  let channelName = '';
  try {
    const axios = require('axios');
    const resp = await axios.get('https://slack.com/api/conversations.info', {
      params: { channel: channelId },
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    if (resp.data?.ok) {
      channelName = resp.data.channel?.name || '';
    } else {
      console.error(`[SLACK] conversations.info failed: ${resp.data?.error} (need channels:read scope?)`);
    }
  } catch (err) {
    console.error('[SLACK] conversations.info error:', err.message);
  }

  console.log(`[PRODUCTION] Approval detected in ${channelId} (name: "${channelName}") — triggering client approval`);
  productionAgent.handleClientApproval(channelId, channelName).catch(err => {
    console.error('[PRODUCTION] Unhandled error in handleClientApproval:', err.message);
  });
});

// ─── POST /slack-interactive ─────────────────────────────────────────────────
app.post('/slack-interactive', async (req, res) => {
  const rawBody = req.body.toString();

  // Verify Slack signature
  const sig = req.headers['x-slack-signature'];
  const ts = req.headers['x-slack-request-timestamp'];
  if (!verifySlackSignature(rawBody, sig, ts)) {
    console.error('[SLACK] Interactive signature verification failed');
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  // Slack sends payload as URL-encoded form: payload=<JSON>
  let payload;
  try {
    const params = new URLSearchParams(rawBody);
    payload = JSON.parse(params.get('payload'));
  } catch {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // Acknowledge immediately — Slack requires a response within 3 seconds
  res.status(200).send('');

  if (payload.type !== 'block_actions') return;

  const action = payload.actions?.[0];
  if (!action || action.action_id !== 'approve_storyboard') return;

  const projectTrackerPageId = action.value;
  const responseUrl = payload.response_url;
  const channelName = payload.channel?.name || 'unknown';
  const userName = payload.user?.name || 'the client';

  console.log(`[PRODUCTION] Storyboard approval button clicked in #${channelName} by ${userName}`);

  // Replace the button with a confirmation so it can't be clicked twice
  if (responseUrl) {
    const axios = require('axios');
    axios.post(responseUrl, {
      replace_original: true,
      text: `✅ Storyboard approved by ${userName}`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `✅ *Storyboard approved* by <@${payload.user?.id}> — production starting now.` },
        },
      ],
    }, { headers: { 'Content-Type': 'application/json' } }).catch(() => {});
  }

  productionAgent.handleClientApproval(projectTrackerPageId, channelName).catch(err => {
    console.error('[PRODUCTION] Unhandled error in handleClientApproval:', err.message);
  });
});

// ─── GET /diagnostic ─────────────────────────────────────────────────────────
app.get('/diagnostic', async (req, res) => {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const testClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await Promise.race([
      testClient.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say OK.' }],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 15s')), 15000)),
    ]);
    return res.json({ ok: true, text: response.content[0]?.text, stop_reason: response.stop_reason });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
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
  console.log('[SCHEDULER] Cron triggered — running kickoff call reminder check');
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
