'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const notion = require('../utils/notion');
const slack = require('../utils/slack');

const _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60000 });

// Warm up the TLS connection on module load
_client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 5,
  messages: [{ role: 'user', content: 'Hi' }],
}).then(() => {
  console.log('[ONBOARDING] Anthropic connection warmed up');
}).catch(err => {
  console.warn('[ONBOARDING] Anthropic warm-up failed:', err.message);
});

const systemPrompt = fs.readFileSync(
  path.join(__dirname, '../prompts/onboarding.md'),
  'utf-8'
);

const TOOLS = [
  {
    name: 'notion_create_page',
    description: 'Create a new page in a Notion database',
    input_schema: {
      type: 'object',
      properties: {
        database_id: { type: 'string', description: 'The Notion database ID' },
        properties: { type: 'object', description: 'Page properties matching the database schema' },
      },
      required: ['database_id', 'properties'],
    },
  },
  {
    name: 'notion_update_page',
    description: 'Update an existing Notion page',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The Notion page ID to update' },
        properties: { type: 'object', description: 'Properties to update' },
      },
      required: ['page_id', 'properties'],
    },
  },
  {
    name: 'notion_query_database',
    description: 'Query a Notion database with optional filters',
    input_schema: {
      type: 'object',
      properties: {
        database_id: { type: 'string', description: 'The Notion database ID' },
        filter: { type: 'object', description: 'Optional Notion filter object' },
        start_cursor: { type: 'string', description: 'Pagination cursor for next page of results' },
      },
      required: ['database_id'],
    },
  },
  {
    name: 'notion_get_page',
    description: 'Get a Notion page by ID',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The Notion page ID' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'slack_create_channel',
    description: 'Create a new Slack channel. If the channel name already exists, returns the existing channel ID instead of creating a duplicate. Throws on failure — channel creation is required for all subsequent steps.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Channel name (lowercase, hyphens only, no #)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'slack_invite_admin',
    description: 'Invite the admin user to a Slack channel',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Slack channel ID' },
        user_id: { type: 'string', description: 'Admin Slack user ID' },
      },
      required: ['channel_id', 'user_id'],
    },
  },
  {
    name: 'slack_invite_guest',
    description: 'Invite a client as a single-channel guest via email using conversations.inviteShared. NEVER aborts the workflow — always returns a result even on failure. Automatically posts a manual invite alert to #production if the invite fails.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Slack channel ID' },
        email: { type: 'string', description: 'Client email address' },
        client_name: { type: 'string', description: 'Client full name (used in error alerts)' },
        channel_name: { type: 'string', description: 'Channel name without # (used in error alerts)' },
      },
      required: ['channel_id', 'email'],
    },
  },
  {
    name: 'slack_post_message',
    description: 'Post a message to a Slack channel',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID or channel name' },
        text: { type: 'string', description: 'Message text (supports Slack markdown)' },
      },
      required: ['channel', 'text'],
    },
  },
];

async function executeTool(name, input) {
  switch (name) {
    case 'notion_create_page': {
      const result = await notion.createPage(input.database_id, input.properties);
      console.log(`[ONBOARDING] Notion page created: ${result.id}`);
      return JSON.stringify({ page_id: result.id, url: result.url });
    }

    case 'notion_update_page': {
      const result = await notion.updatePage(input.page_id, input.properties);
      console.log(`[ONBOARDING] Notion page updated: ${input.page_id}`);
      return JSON.stringify({ page_id: result.id, url: result.url });
    }

    case 'notion_query_database': {
      const result = await notion.queryDatabase(input.database_id, input.filter, input.start_cursor);
      return JSON.stringify({
        results: result.results,
        has_more: result.has_more,
        next_cursor: result.next_cursor,
      });
    }

    case 'notion_get_page': {
      const result = await notion.getPage(input.page_id);
      return JSON.stringify(result);
    }

    case 'slack_create_channel': {
      // Throws on failure — channel is required for all subsequent steps
      const result = await slack.createChannel(input.name);
      console.log(`[ONBOARDING] Slack channel ready: #${result.channel.name} (${result.channel.id})`);
      return JSON.stringify({ channel_id: result.channel.id, channel_name: result.channel.name });
    }

    case 'slack_invite_admin': {
      const teamIds = (process.env.SLACK_TEAM_MEMBER_IDS || '').split(',').filter(Boolean);
      const allUserIds = [input.user_id, ...teamIds].join(',');
      const result = await slack.inviteAdmin(input.channel_id, allUserIds);
      if (!result.ok && result.error !== 'already_in_channel') {
        console.warn(`[ONBOARDING] Admin invite issue: ${result.error}`);
      }
      console.log(`[ONBOARDING] Team members invited: ${allUserIds}`);
      return JSON.stringify({ ok: result.ok, error: result.error });
    }

    case 'slack_invite_guest': {
      // Never throws — always returns a result
      const result = await slack.inviteGuest(
        input.channel_id,
        input.email,
        input.client_name,
        input.channel_name
      );
      return JSON.stringify(result);
    }

    case 'slack_post_message': {
      const result = await slack.postMessage(input.channel, input.text);
      return JSON.stringify({ ok: result.ok, ts: result.ts });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function runAgent(userMessage) {
  const client = _client;
  const messages = [{ role: 'user', content: userMessage }];
  let turn = 0;

  while (true) {
    turn++;
    console.log(`[ONBOARDING] Anthropic API call — turn ${turn}`);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    console.log(`[ONBOARDING] Anthropic responded — stop_reason: ${response.stop_reason}`);
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') break;

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        console.log(`[ONBOARDING] Tool call: ${block.name}`, JSON.stringify(block.input));

        try {
          const result = await executeTool(block.name, block.input);
          console.log(`[ONBOARDING] Tool result: ${block.name} →`, result.slice(0, 200));
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        } catch (err) {
          if (block.name === 'slack_create_channel') {
            // Abort — channel is required for all subsequent steps
            console.error(`[ONBOARDING] ABORT — Slack channel creation failed: ${err.message}`);
            throw err;
          }
          console.error(`[ONBOARDING] Tool error (${block.name}): ${err.message}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Error: ${err.message}`,
            is_error: true,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }
  }
}

// Where clients book their kickoff call (welcome message + reminders)
const KICKOFF_BOOKING_URL = process.env.KICKOFF_BOOKING_URL || 'https://veyrastudios.eu/onboarding';

async function handleNewCustomer(customer, plan = 'Paid Trial', language = 'en') {
  const languageLabel = language === 'nl' ? 'Nederlands' : 'English';
  console.log(`[ONBOARDING] Processing new customer: ${customer.name || customer.email} (${plan}, ${languageLabel})`);
  try {
    const userMessage = [
      'New Stripe customer received. Please process their full onboarding.',
      '',
      'Customer data:',
      JSON.stringify(customer, null, 2),
      '',
      `Plan: ${plan}`,
      `Language: ${languageLabel}`,
      '',
      'Environment:',
      `NOTION_CLIENT_DB_ID: ${process.env.NOTION_CLIENT_DB_ID}`,
      `NOTION_PROJECT_TRACKER_ID: ${process.env.NOTION_PROJECT_TRACKER_ID}`,
      `SLACK_ADMIN_USER_ID: ${process.env.SLACK_ADMIN_USER_ID}`,
      `INTERNAL_SLACK_CHANNEL: ${process.env.INTERNAL_SLACK_CHANNEL || 'production'}`,
      `KICKOFF_BOOKING_URL: ${KICKOFF_BOOKING_URL}`,
      '',
      'Follow Trigger 1 in your system prompt. Complete all steps in order.',
    ].join('\n');

    await runAgent(userMessage);
    console.log(`[ONBOARDING] Completed onboarding for: ${customer.name || customer.email}`);
  } catch (err) {
    console.error(`[ONBOARDING] handleNewCustomer failed: ${err.message}`);
    await slack.postMessage(
      process.env.INTERNAL_SLACK_CHANNEL || 'production',
      `🚨 Onboarding agent failed for: ${customer.name || customer.email}\nError: ${err.message}\nManual onboarding required.`
    ).catch(() => {});
  }
}

// Tracks sent chases this server session — prevents duplicates across cron ticks
const sentChases = new Set();

function getPageTitle(page) {
  const titleProp = page.properties?.['Your Name'] || page.properties?.['Name'];
  if (!titleProp) return '';
  if (titleProp.type === 'title') {
    return titleProp.title?.[0]?.plain_text || '';
  }
  return '';
}

// Reminds Paid Trial clients to book their kickoff call on day 1, 3 and 7
// after payment, until "Kickoff Call Booked" is ticked on their Client DB row.
async function checkPendingOnboarding() {
  console.log('[SCHEDULER] Checking for unbooked kickoff calls');

  const filter = {
    and: [
      { property: 'Client Type', select: { equals: 'Trial' } },
      { property: 'Kickoff Call Booked', checkbox: { equals: false } },
      { property: 'Payment Date', date: { is_not_empty: true } },
    ],
  };

  const today = new Date().toISOString().split('T')[0];
  let cursor;
  let checkedCount = 0;
  let chasedCount = 0;

  do {
    const result = await notion.queryDatabase(
      process.env.NOTION_CLIENT_DB_ID,
      filter,
      cursor
    );

    for (const page of result.results) {
      checkedCount++;
      const name = getPageTitle(page) || 'Unknown';
      const firstName = name.split(' ')[0];
      const email = page.properties?.['Email']?.email || '';
      const slackChannel = page.properties?.['Slack Channel']?.rich_text?.[0]?.plain_text || '';
      const paymentDateStr = page.properties?.['Payment Date']?.date?.start;
      const language = page.properties?.['Language']?.select?.name === 'Nederlands' ? 'nl' : 'en';

      if (!paymentDateStr) continue;

      const paymentDate = new Date(paymentDateStr);
      const now = new Date();
      const daysSincePayment = (now - paymentDate) / (1000 * 60 * 60 * 24);

      // Determine which chase bucket this client is in
      let dayBucket = null;
      if (daysSincePayment >= 1 && daysSincePayment < 2) dayBucket = 1;
      else if (daysSincePayment >= 3 && daysSincePayment < 4) dayBucket = 3;
      else if (daysSincePayment >= 7 && daysSincePayment < 8) dayBucket = 7;
      else if (daysSincePayment >= 8) {
        console.log(`[SCHEDULER] Skipping ${name} — past chase window (${Math.floor(daysSincePayment)} days)`);
        continue;
      }

      if (!dayBucket) continue; // Not in a chase bucket

      const chaseKey = `${email}:day${dayBucket}:${today}`;
      if (sentChases.has(chaseKey)) {
        console.log(`[SCHEDULER] ${name} — Day ${dayBucket} chase already sent today, skipping`);
        continue;
      }

      if (!slackChannel) {
        console.warn(`[SCHEDULER] ${name} — no Slack channel set, cannot send Day ${dayBucket} chase`);
        continue;
      }

      const url = KICKOFF_BOOKING_URL;
      const CHASE_MESSAGES = {
        en: {
          1: `Hey ${firstName} 👋\n\nJust a quick reminder to book your kickoff call when you get a moment — it's the last step before we can start on your project.\n\n🔗 ${url}\n\nLooking forward to speaking with you.`,
          3: `Hi ${firstName},\n\nWe noticed your kickoff call isn't booked yet. We can't begin production until we've walked through your brief together, so whenever you have a moment it would be great to get it in the diary.\n\n🔗 ${url}\n\nIf none of the times work for you, just reply here and we'll find one that does.`,
          7: `Hi ${firstName},\n\nThis is our final reminder to book your kickoff call. Your project start date is being held until we've spoken.\n\n🔗 ${url}\n\nIf something has come up or you would like to discuss your project, please reply here or email us directly. We want to make sure you get the most out of your Paid Trial.`,
        },
        nl: {
          1: `Hey ${firstName} 👋\n\nEven een korte herinnering om je kickoffgesprek in te plannen wanneer het je uitkomt — het is de laatste stap voor we met je project kunnen starten.\n\n🔗 ${url}\n\nWe kijken ernaar uit om je te spreken.`,
          3: `Hoi ${firstName},\n\nWe zien dat je kickoffgesprek nog niet is ingepland. We kunnen pas starten met de productie zodra we je brief samen hebben doorgenomen, dus als je even tijd hebt zou het top zijn om dit in te plannen.\n\n🔗 ${url}\n\nPast geen enkel moment? Laat het hier gewoon weten en we zoeken samen een tijdstip dat wel lukt.`,
          7: `Hoi ${firstName},\n\nDit is onze laatste herinnering om je kickoffgesprek in te plannen. De startdatum van je project staat on hold tot we elkaar gesproken hebben.\n\n🔗 ${url}\n\nAls er iets is tussengekomen of je wil je project bespreken, reageer dan hier of mail ons rechtstreeks. We willen dat je het maximum uit je proefpakket haalt.`,
        },
      };
      const message = CHASE_MESSAGES[language][dayBucket];

      try {
        await slack.postMessage(slackChannel, message);
        sentChases.add(chaseKey);
        chasedCount++;
        console.log(`[SCHEDULER] Day ${dayBucket} chase sent to ${name} in #${slackChannel} (${language})`);
      } catch (err) {
        console.error(`[SCHEDULER] Failed to send chase to ${name}: ${err.message}`);
      }
    }

    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);

  if (checkedCount === 0) {
    console.log('[SCHEDULER] No unbooked kickoff calls to chase');
  } else {
    console.log(`[SCHEDULER] Checked ${checkedCount} pending clients, sent ${chasedCount} kickoff reminders`);
  }
}

module.exports = { handleNewCustomer, checkPendingOnboarding };
