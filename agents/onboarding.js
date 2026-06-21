'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const notion = require('../utils/notion');
const slack = require('../utils/slack');
const frameio = require('../utils/frameio');

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
  {
    name: 'frameio_create_project',
    description: 'Create a new Frame.io project',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name' },
        team_id: { type: 'string', description: 'Frame.io team ID (optional — auto-detected if omitted)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'frameio_get_project',
    description: 'Get a Frame.io project by ID',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Frame.io project ID' },
      },
      required: ['project_id'],
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

    case 'frameio_create_project': {
      const result = await frameio.createProject(input.name, input.team_id);
      console.log(`[ONBOARDING] Frame.io project created: ${input.name}`);
      return JSON.stringify(result);
    }

    case 'frameio_get_project': {
      const result = await frameio.getProject(input.project_id);
      return JSON.stringify(result);
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

async function handleNewCustomer(customer) {
  console.log(`[ONBOARDING] Processing new customer: ${customer.name || customer.email}`);
  try {
    const userMessage = [
      'New Stripe customer received. Please process their full onboarding.',
      '',
      'Customer data:',
      JSON.stringify(customer, null, 2),
      '',
      'Environment:',
      `NOTION_CLIENT_DB_ID: ${process.env.NOTION_CLIENT_DB_ID}`,
      `SLACK_ADMIN_USER_ID: ${process.env.SLACK_ADMIN_USER_ID}`,
      `ONBOARDING_FORM_URL: ${process.env.ONBOARDING_FORM_URL || 'https://veyrastudios.eu'}`,
      '',
      'Follow Trigger 1 in your system prompt. Complete all 8 steps in order.',
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

async function handleFormSubmission(page) {
  const pageId = page.id || page.page_id || 'unknown';
  console.log(`[ONBOARDING] Processing form submission for page: ${pageId}`);
  try {
    const userMessage = [
      'A new Notion Client DB row has been detected — the onboarding form has been submitted.',
      '',
      'Page data:',
      JSON.stringify(page, null, 2),
      '',
      'Environment:',
      `NOTION_CLIENT_DB_ID: ${process.env.NOTION_CLIENT_DB_ID}`,
      `NOTION_PROJECT_TRACKER_ID: ${process.env.NOTION_PROJECT_TRACKER_ID}`,
      `INTERNAL_SLACK_CHANNEL: ${process.env.INTERNAL_SLACK_CHANNEL || 'production'}`,
      '',
      'Follow Trigger 2 in your system prompt. Complete all 5 steps.',
    ].join('\n');

    await runAgent(userMessage);
    console.log(`[ONBOARDING] Completed form submission processing for page: ${pageId}`);
  } catch (err) {
    console.error(`[ONBOARDING] handleFormSubmission failed: ${err.message}`);
    await slack.postMessage(
      process.env.INTERNAL_SLACK_CHANNEL || 'production',
      `🚨 Form submission agent failed for page: ${pageId}\nError: ${err.message}\nManual setup required.`
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

async function checkPendingOnboarding() {
  console.log('[SCHEDULER] Checking for pending onboarding follow-ups');

  const filter = {
    and: [
      { property: 'Onboarding Form Submitted', checkbox: { equals: false } },
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

      const formUrl = process.env.ONBOARDING_FORM_URL || 'https://veyrastudios.eu';
      let message;

      if (dayBucket === 1) {
        message = `Hey ${firstName} 👋\n\nJust a quick reminder to complete your onboarding form when you get a moment — it is the last step before we can kick off your project.\n\n🔗 ${formUrl}\n\nTakes about 10 minutes. Looking forward to getting started with you.`;
      } else if (dayBucket === 3) {
        message = `Hi ${firstName},\n\nWe noticed your onboarding form is still outstanding. We cannot begin production until it is complete, so whenever you have 10 minutes it would be great to get this done.\n\n🔗 ${formUrl}\n\nIf you have any questions or need help with any of the questions, just reply here and we will help you out.`;
      } else if (dayBucket === 7) {
        message = `Hi ${firstName},\n\nThis is our final reminder about your onboarding form. Your project start date is being held until this is complete.\n\n🔗 ${formUrl}\n\nIf something has come up or you would like to discuss your project, please reply here or email us directly. We want to make sure you get the most out of your Veyra 10-Pack.`;
      }

      try {
        await slack.postMessage(slackChannel, message);
        sentChases.add(chaseKey);
        chasedCount++;
        console.log(`[SCHEDULER] Day ${dayBucket} chase sent to ${name} in #${slackChannel}`);
      } catch (err) {
        console.error(`[SCHEDULER] Failed to send chase to ${name}: ${err.message}`);
      }
    }

    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);

  if (checkedCount === 0) {
    console.log('[SCHEDULER] No pending onboarding follow-ups');
  } else {
    console.log(`[SCHEDULER] Checked ${checkedCount} pending clients, sent ${chasedCount} chase messages`);
  }
}

module.exports = { handleNewCustomer, handleFormSubmission, checkPendingOnboarding };
