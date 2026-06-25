'use strict';

require('dotenv').config();

const express = require('express');
const cron = require('node-cron');
const { verifyStripeSignature } = require('./utils/verify-stripe');
const { verifyFrameioSignature } = require('./utils/verify-frameio');
const { verifySlackSignature } = require('./utils/verify-slack');
const onboardingAgent = require('./agents/onboarding');
const productionAgent = require('./agents/production');

const app = express();

// Raw body required for signature verification on these routes
app.use('/stripe-webhook', express.raw({ type: '*/*' }));
app.use('/frameio-webhook', express.raw({ type: '*/*' }));
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

  if (event.type !== 'customer.created') return;

  const customer = event.data.object;
  const desc = (customer.description || '').toLowerCase();
  const meta = JSON.stringify(customer.metadata || {}).toLowerCase();

  const isVeyra10Pack = desc.includes('veyra 10-pack') || meta.includes('veyra 10-pack');
  const isVeyraBrandVideo = desc.includes('veyra brand video') || meta.includes('veyra brand video');

  if (!isVeyra10Pack && !isVeyraBrandVideo) {
    console.log('[ONBOARDING] Skipping non-Veyra customer:', customer.email);
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

  const payload = req.body;

  // Notion automations send a minimal payload — extract the page ID from wherever it lives
  const pageId = payload?.id || payload?.page_id || payload?.data?.page_id || payload?.data?.id;

  if (!pageId) {
    console.log('[ONBOARDING] Notion webhook — no page ID in payload, skipping. Keys:', Object.keys(payload || {}).join(', '));
    return;
  }

  // Fetch the full page from Notion so we have all properties regardless of payload format
  let page;
  try {
    const notion = require('./utils/notion');
    page = await notion.getPage(pageId);
  } catch (err) {
    console.error('[ONBOARDING] Notion webhook — failed to fetch page:', err.message);
    return;
  }

  // Only process rows from the Client DB
  const dbId = page?.parent?.database_id?.replace(/-/g, '');
  const clientDbId = (process.env.NOTION_CLIENT_DB_ID || '').replace(/-/g, '');
  if (clientDbId && dbId && dbId !== clientDbId) {
    console.log('[ONBOARDING] Notion webhook — wrong database, skipping');
    return;
  }

  // Skip if already processed
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

  console.log(`[PRODUCTION] Approval detected in ${channelId} (name: "${channelName}") — triggering storyboard approval`);
  productionAgent.handleStoryboardApproval(channelId, channelName).catch(err => {
    console.error('[PRODUCTION] Unhandled error in handleStoryboardApproval:', err.message);
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

  productionAgent.handleStoryboardApproval(projectTrackerPageId, channelName).catch(err => {
    console.error('[PRODUCTION] Unhandled error in handleStoryboardApproval:', err.message);
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
