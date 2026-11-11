'use strict';

// Marks a client's kickoff call as booked from the /booked Slack command.
// Ticks "Kickoff Call Booked" on the Notion Client DB row (which stops the
// day 1/3/7 reminders) and posts a note to #production. Plain code, no AI:
// this has to be predictable.

const axios = require('axios');
const notion = require('../utils/notion');
const slack = require('../utils/slack');

const INTERNAL_CHANNEL = () => process.env.INTERNAL_SLACK_CHANNEL || 'production';

// ─── /booked Slack command ───────────────────────────────────────────────────
// Typed by a team member inside a client channel. Matches the client by the
// channel (not by email), so it works whatever email they booked with.
//   /booked                → tick "Kickoff Call Booked"
//   /booked Thu 14:00      → same, with the time noted in #production
//   /booked undo           → untick it (reminders resume)

const SLACK_API = 'https://slack.com/api';
const slackHeaders = () => ({ Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` });

async function replyEphemeral(responseUrl, text) {
  if (!responseUrl) return;
  await axios.post(responseUrl, { response_type: 'ephemeral', text })
    .catch(err => console.error('[BOOKING] Failed to reply to /booked:', err.message));
}

async function isGuest(userId) {
  const resp = await axios.get(`${SLACK_API}/users.info`, { params: { user: userId }, headers: slackHeaders() });
  if (!resp.data?.ok) throw new Error(`users.info failed: ${resp.data?.error}`);
  const u = resp.data.user || {};
  return Boolean(u.is_restricted || u.is_ultra_restricted);
}

async function resolveChannelName(channelId, channelNameFromSlack) {
  if (channelNameFromSlack && !['privategroup', 'directmessage', 'mpdm'].includes(channelNameFromSlack)) {
    return channelNameFromSlack;
  }
  const resp = await axios.get(`${SLACK_API}/conversations.info`, { params: { channel: channelId }, headers: slackHeaders() });
  if (!resp.data?.ok) throw new Error(`conversations.info failed: ${resp.data?.error}`);
  return resp.data.channel?.name || '';
}

async function findClientRowByChannel(channelName) {
  const target = channelName.replace(/^#/, '').toLowerCase();
  const result = await notion.queryDatabase(process.env.NOTION_CLIENT_DB_ID, {
    property: 'Slack Channel',
    rich_text: { contains: target },
  });
  // "contains" would also match #client-test-client-01 for #client-test-client,
  // so keep exact matches only.
  return result.results.filter(row => {
    const stored = row.properties?.['Slack Channel']?.rich_text?.[0]?.plain_text || '';
    return stored.replace(/^#/, '').trim().toLowerCase() === target;
  });
}

async function handleBookedCommand({ channelId, channelName, userId, userName, text, responseUrl }) {
  const arg = (text || '').trim();
  const undo = /^undo$/i.test(arg);

  try {
    if (await isGuest(userId)) {
      console.warn(`[BOOKING] /booked refused for guest ${userName} (${userId})`);
      await replyEphemeral(responseUrl, 'Sorry, /booked is only available to the Veyra team.');
      return;
    }

    const name = await resolveChannelName(channelId, channelName);
    const rows = name ? await findClientRowByChannel(name) : [];

    if (!rows.length) {
      console.warn(`[BOOKING] /booked in #${name || channelId}: no Client DB row with that Slack Channel`);
      await replyEphemeral(responseUrl, `No client in the Client DB has Slack Channel "#${name || channelId}". Run /booked inside the client's own channel, or tick "Kickoff Call Booked" in Notion by hand.`);
      return;
    }

    for (const row of rows) {
      const clientName = row.properties?.['Your Name']?.title?.[0]?.plain_text || name;
      const wasBooked = row.properties?.['Kickoff Call Booked']?.checkbox === true;

      await notion.updatePage(row.id, { 'Kickoff Call Booked': { checkbox: !undo } });
      console.log(`[BOOKING] /booked${undo ? ' undo' : ''} by ${userName}: Kickoff Call Booked → ${!undo} for ${clientName} (${row.id})`);

      if (undo) {
        await replyEphemeral(responseUrl, `Done. ${clientName} is marked as not booked, so the kickoff call reminders will resume.`);
        await slack.postMessage(INTERNAL_CHANNEL(), `↩️ Kickoff call unmarked: ${clientName}
By: ${userName}
Client DB: ${row.url}

Reminders will resume.`).catch(() => {});
      } else {
        await replyEphemeral(responseUrl, wasBooked
          ? `${clientName} was already marked as booked. Nothing changed.`
          : `Done. ${clientName} is marked as booked in Notion and the reminders have stopped.`);
        if (!wasBooked) {
          await slack.postMessage(
            INTERNAL_CHANNEL(),
            `📅 Kickoff call booked: ${clientName}${arg ? `
When: ${arg}` : ''}
Marked by: ${userName}
Slack: #${name}
Client DB: ${row.url}

Reminders stopped.`
          ).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('[BOOKING] /booked failed:', err.message);
    await replyEphemeral(responseUrl, `Something went wrong: ${err.message}. Please tick "Kickoff Call Booked" in Notion by hand.`);
  }
}

module.exports = { handleBookedCommand };
