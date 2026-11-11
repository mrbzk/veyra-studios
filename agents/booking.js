'use strict';

// Handles kickoff call bookings sent from a GoHighLevel workflow
// ("Appointment Booked" trigger → Webhook action → POST /ghl-booking).
//
// Finds the client in the Notion Client DB by email, ticks
// "Kickoff Call Booked" (which stops the day 1/3/7 reminders), and posts
// a note to #production. Plain code, no AI: this has to be predictable.

const notion = require('../utils/notion');
const slack = require('../utils/slack');

const INTERNAL_CHANNEL = () => process.env.INTERNAL_SLACK_CHANNEL || 'production';

// GHL's webhook payload shape depends on the trigger and on any custom data
// added in the workflow, so look in the usual places.
function extractBooking(payload = {}) {
  const contact = payload.contact || {};
  const custom = payload.customData || payload.custom_data || {};
  const calendar = payload.calendar || payload.appointment || {};

  const email = (
    payload.email || contact.email || custom.email || payload.contact_email || ''
  ).trim();

  const name = (
    payload.full_name || contact.full_name || custom.name ||
    [payload.first_name || contact.first_name, payload.last_name || contact.last_name].filter(Boolean).join(' ') ||
    ''
  ).trim();

  const startTime = calendar.startTime || calendar.start_time || custom.startTime || custom.start_time || '';
  const timezone = calendar.selectedTimezone || calendar.timezone || custom.timezone || '';

  return { email, name, startTime, timezone };
}

async function findClientRowsByEmail(email) {
  const candidates = [...new Set([email, email.toLowerCase()])];
  for (const value of candidates) {
    const result = await notion.queryDatabase(process.env.NOTION_CLIENT_DB_ID, {
      property: 'Email',
      email: { equals: value },
    });
    if (result.results.length) return result.results;
  }
  return [];
}

function formatWhen(startTime, timezone) {
  if (!startTime) return 'time not included in the booking';
  return timezone ? `${startTime} (${timezone})` : startTime;
}

async function handleKickoffBooked(payload) {
  const { email, name, startTime, timezone } = extractBooking(payload);
  const when = formatWhen(startTime, timezone);

  if (!email) {
    console.warn('[BOOKING] GHL booking webhook had no email — keys:', Object.keys(payload || {}).join(', '));
    await slack.postMessage(
      INTERNAL_CHANNEL(),
      `⚠️ Kickoff call booked in GoHighLevel, but the booking had no email address.\nName: ${name || 'unknown'}\nWhen: ${when}\n\nPlease tick "Kickoff Call Booked" on the client's Client DB row manually.`
    ).catch(() => {});
    return;
  }

  console.log(`[BOOKING] Kickoff call booked: ${name || email} <${email}> — ${when}`);

  const rows = await findClientRowsByEmail(email);

  if (!rows.length) {
    console.warn(`[BOOKING] No Client DB row found for ${email}`);
    await slack.postMessage(
      INTERNAL_CHANNEL(),
      `⚠️ Kickoff call booked by ${name || email} (${email}), but no client with that email is in the Client DB.\nWhen: ${when}\n\nIf they booked with a different email, tick "Kickoff Call Booked" on their row manually so the reminders stop.`
    ).catch(() => {});
    return;
  }

  for (const row of rows) {
    const alreadyBooked = row.properties?.['Kickoff Call Booked']?.checkbox === true;
    const clientName = row.properties?.['Your Name']?.title?.[0]?.plain_text || name || email;
    const slackChannel = row.properties?.['Slack Channel']?.rich_text?.[0]?.plain_text || 'not set';

    if (!alreadyBooked) {
      await notion.updatePage(row.id, { 'Kickoff Call Booked': { checkbox: true } });
      console.log(`[BOOKING] Kickoff Call Booked → true for ${clientName} (${row.id})`);
    } else {
      console.log(`[BOOKING] ${clientName} already marked as booked (reschedule or duplicate)`);
    }

    await slack.postMessage(
      INTERNAL_CHANNEL(),
      `📅 Kickoff call ${alreadyBooked ? 'booked again (reschedule?)' : 'booked'}: ${clientName}\nWhen: ${when}\nSlack: ${slackChannel}\nClient DB: ${row.url}${alreadyBooked ? '' : '\n\nReminders stopped.'}`
    ).catch(err => console.error('[BOOKING] Failed to post to #production:', err.message));
  }
}

module.exports = { handleKickoffBooked, extractBooking };
