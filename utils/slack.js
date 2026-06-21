'use strict';

const axios = require('axios');

const SLACK_BASE = 'https://slack.com/api';

function headers() {
  return {
    Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function findChannelByName(name) {
  let cursor;
  do {
    const params = { types: 'public_channel,private_channel', limit: 200, exclude_archived: true };
    if (cursor) params.cursor = cursor;
    const response = await axios.get(`${SLACK_BASE}/conversations.list`, {
      params,
      headers: headers(),
    });
    if (!response.data.ok) return null;
    const found = response.data.channels.find(c => c.name === name);
    if (found) return found;
    cursor = response.data.response_metadata?.next_cursor || null;
  } while (cursor);
  return null;
}

async function createChannel(name) {
  const response = await axios.post(`${SLACK_BASE}/conversations.create`, {
    name,
    is_private: false,
  }, { headers: headers() });

  if (response.data.ok) return response.data;

  if (response.data.error === 'name_taken') {
    const existing = await findChannelByName(name);
    if (existing) {
      return { ok: true, channel: existing };
    }
    throw new Error(`Channel name taken but could not locate existing channel: ${name}`);
  }

  throw new Error(`Failed to create Slack channel "${name}": ${response.data.error}`);
}

async function inviteAdmin(channel_id, user_id) {
  const response = await axios.post(`${SLACK_BASE}/conversations.invite`, {
    channel: channel_id,
    users: user_id,
  }, { headers: headers() });
  return response.data;
}

async function inviteGuest(channel_id, email, client_name, channel_name) {
  try {
    const response = await axios.post(`${SLACK_BASE}/conversations.inviteShared`, {
      channel: channel_id,
      emails: [email],
    }, { headers: headers() });

    const data = response.data;

    if (data.ok) {
      console.log(`[ONBOARDING] Slack guest invite sent to: ${email}`);
      return { ok: true, status: 'invited' };
    }

    if (data.error === 'already_in_channel' || data.error === 'cant_invite_self') {
      console.log(`[ONBOARDING] Slack guest invite skipped (${data.error}): ${email}`);
      return { ok: true, status: 'skipped', reason: data.error };
    }

    console.warn(`[ONBOARDING] Slack guest invite failed — manual invite needed: ${email} — ${data.error}`);
    const alertText = `⚠️ Manual Slack invite needed\nClient: ${client_name || 'Unknown'}\nEmail: ${email}\nChannel: #${channel_name || channel_id}\nReason: ${data.error}`;
    await postMessage(process.env.INTERNAL_SLACK_CHANNEL || 'production', alertText).catch(() => {});

    return { ok: false, status: 'failed', error: data.error };
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error(`[ONBOARDING] Slack guest invite error: ${errMsg}`);

    const alertText = `⚠️ Manual Slack invite needed\nClient: ${client_name || 'Unknown'}\nEmail: ${email}\nChannel: #${channel_name || channel_id}\nReason: ${errMsg}`;
    await postMessage(process.env.INTERNAL_SLACK_CHANNEL || 'production', alertText).catch(() => {});

    return { ok: false, status: 'error', error: errMsg };
  }
}

async function postMessage(channel, text, blocks) {
  const body = { channel, text };
  if (blocks) body.blocks = blocks;
  const response = await axios.post(`${SLACK_BASE}/chat.postMessage`, body, { headers: headers() });
  return response.data;
}

async function updateInteractiveMessage(responseUrl, text, blocks) {
  const body = { replace_original: true, text };
  if (blocks) body.blocks = blocks;
  await axios.post(responseUrl, body, { headers: { 'Content-Type': 'application/json' } });
}

module.exports = { createChannel, findChannelByName, inviteAdmin, inviteGuest, postMessage, updateInteractiveMessage };
