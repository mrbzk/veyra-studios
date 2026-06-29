'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const notion = require('../utils/notion');
const slack = require('../utils/slack');

const systemPrompt = fs.readFileSync(
  path.join(__dirname, '../prompts/production.md'),
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
    description: 'Create a new Slack channel',
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
    description: 'Invite a client as a single-channel guest via email using conversations.inviteShared',
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
      console.log(`[PRODUCTION] Notion page created: ${result.id}`);
      return JSON.stringify({ page_id: result.id, url: result.url });
    }

    case 'notion_update_page': {
      const result = await notion.updatePage(input.page_id, input.properties);
      console.log(`[PRODUCTION] Notion page updated: ${input.page_id}`);
      return JSON.stringify({ page_id: result.id, url: result.url });
    }

    case 'notion_query_database': {
      const result = await notion.queryDatabase(input.database_id, input.filter, input.start_cursor);
      // Slim each row to just id, url, and properties — strip verbose metadata
      const slim = (result.results || []).map(r => ({
        id: r.id,
        url: r.url,
        properties: r.properties,
      }));
      const str = JSON.stringify({ results: slim, has_more: result.has_more, next_cursor: result.next_cursor });
      return str.length > 12000 ? str.slice(0, 12000) + '...[truncated]' : str;
    }

    case 'notion_get_page': {
      const result = await notion.getPage(input.page_id);
      const str = JSON.stringify(result);
      // Truncate very large responses to avoid bloating context
      return str.length > 8000 ? str.slice(0, 8000) + '...[truncated]' : str;
    }

    case 'slack_create_channel': {
      const result = await slack.createChannel(input.name);
      return JSON.stringify({ channel_id: result.channel.id, channel_name: result.channel.name });
    }

    case 'slack_invite_admin': {
      const result = await slack.inviteAdmin(input.channel_id, input.user_id);
      return JSON.stringify({ ok: result.ok, error: result.error });
    }

    case 'slack_invite_guest': {
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
      console.log(`[PRODUCTION] Message posted to: ${input.channel}`);
      return JSON.stringify({ ok: result.ok, ts: result.ts });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60000 });

// Warm up the TLS connection on module load so it's ready when the first webhook arrives
_client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 5,
  messages: [{ role: 'user', content: 'Hi' }],
}).then(() => {
  console.log('[PRODUCTION] Anthropic connection warmed up');
}).catch(err => {
  console.warn('[PRODUCTION] Anthropic warm-up failed:', err.message);
});

async function runAgent(userMessage) {
  const client = _client;
  const messages = [{ role: 'user', content: userMessage }];
  let turn = 0;

  while (true) {
    turn++;
    const msgSize = JSON.stringify(messages).length;
    console.log(`[PRODUCTION] Anthropic API call — turn ${turn}, messages size: ${msgSize} chars`);

    const controller = new AbortController();
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      console.log(`[PRODUCTION] …turn ${turn} still waiting (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    }, 5000);
    const timeoutId = setTimeout(() => {
      console.error(`[PRODUCTION] Aborting turn ${turn} — no response after 30s`);
      controller.abort();
    }, 30000);

    let response;
    try {
      response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      }, { signal: controller.signal, maxRetries: 0 });
      clearTimeout(timeoutId);
      clearInterval(heartbeat);
    } catch (apiErr) {
      clearTimeout(timeoutId);
      clearInterval(heartbeat);
      console.error(`[PRODUCTION] Anthropic API error on turn ${turn}:`, apiErr.message);
      throw apiErr;
    }

    console.log(`[PRODUCTION] Anthropic responded — stop_reason: ${response.stop_reason}`);
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') break;

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        console.log(`[PRODUCTION] Tool call: ${block.name}`, JSON.stringify(block.input));

        try {
          const result = await executeTool(block.name, block.input);
          console.log(`[PRODUCTION] Tool result: ${block.name} →`, result.slice(0, 200));
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        } catch (err) {
          console.error(`[PRODUCTION] Tool error (${block.name}): ${err.message}`);
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

async function handleStoryboardReview(page) {
  const pageId = page.id || page.page_id || 'unknown';
  console.log(`[PRODUCTION] Storyboard review triggered for page: ${pageId}`);
  try {
    const userMessage = [
      'A Notion Project Tracker row status has changed to Storyboard Review.',
      '',
      'Page data:',
      JSON.stringify(page, null, 2),
      '',
      'Environment:',
      `NOTION_PROJECT_TRACKER_ID: ${process.env.NOTION_PROJECT_TRACKER_ID}`,
      `NOTION_CLIENT_DB_ID: ${process.env.NOTION_CLIENT_DB_ID}`,
      '',
      'Follow Trigger 1 in your system prompt.',
      'Get the client Slack channel from the Client DB and post the storyboard review message.',
      'Update Storyboard Sent to Client → true after posting.',
    ].join('\n');

    await runAgent(userMessage);
    console.log(`[PRODUCTION] Completed storyboard review for page: ${pageId}`);
  } catch (err) {
    console.error(`[PRODUCTION] handleStoryboardReview failed: ${err.message}`);
    await slack.postMessage(
      process.env.INTERNAL_SLACK_CHANNEL || 'production',
      `🚨 Production agent failed on storyboard review\nPage: ${pageId}\nError: ${err.message}\nManual storyboard notification required.`
    ).catch(() => {});
  }
}

async function handleVideoReview(page) {
  const pageId = page.id || page.page_id || 'unknown';
  const reviewStage = page?.properties?.['Review Stage']?.select?.name || 'unknown';
  console.log(`[PRODUCTION] Video review triggered for page: ${pageId} (stage: ${reviewStage})`);
  try {
    const userMessage = [
      'A Notion Project Tracker row has a video ready for client review.',
      '',
      'Page data:',
      JSON.stringify(page, null, 2),
      '',
      'Environment:',
      `NOTION_PROJECT_TRACKER_ID: ${process.env.NOTION_PROJECT_TRACKER_ID}`,
      `NOTION_CLIENT_DB_ID: ${process.env.NOTION_CLIENT_DB_ID}`,
      `INTERNAL_SLACK_CHANNEL: ${process.env.INTERNAL_SLACK_CHANNEL || 'production'}`,
      '',
      'Follow Trigger 2 in your system prompt.',
      'Read Review Stage and Total Videos first, then post the correct review message.',
      'If the Drive link field is empty, post an alert to #production and stop.',
    ].join('\n');

    await runAgent(userMessage);
    console.log(`[PRODUCTION] Completed video review for page: ${pageId}`);
  } catch (err) {
    console.error(`[PRODUCTION] handleVideoReview failed: ${err.message}`);
    await slack.postMessage(
      process.env.INTERNAL_SLACK_CHANNEL || 'production',
      `🚨 Production agent failed on video review\nPage: ${pageId}\nError: ${err.message}\nManual review notification required.`
    ).catch(() => {});
  }
}

async function handleClientApproval(channelId, channelName) {
  console.log(`[PRODUCTION] Client approval received in channel: ${channelId} (${channelName || 'no name'})`);
  try {
    const userMessage = [
      'A client has replied "Approved" in their Slack channel.',
      '',
      `Channel ID: ${channelId}`,
      `Channel name: ${channelName || '(not resolved — scan rows where Slack Channel is not empty)'}`,
      '',
      'Environment:',
      `NOTION_PROJECT_TRACKER_ID: ${process.env.NOTION_PROJECT_TRACKER_ID}`,
      `NOTION_CLIENT_DB_ID: ${process.env.NOTION_CLIENT_DB_ID}`,
      `INTERNAL_SLACK_CHANNEL: ${process.env.INTERNAL_SLACK_CHANNEL || 'production'}`,
      '',
      'Follow Trigger 4 in your system prompt.',
      'Read the client\'s current Project Tracker state to determine what is being approved.',
      'When posting the client confirmation, use the Channel ID as the channel.',
    ].join('\n');

    await runAgent(userMessage);
    console.log(`[PRODUCTION] Completed client approval for channel: ${channelId}`);
  } catch (err) {
    console.error(`[PRODUCTION] handleClientApproval failed: ${err.message}`);
    await slack.postMessage(
      process.env.INTERNAL_SLACK_CHANNEL || 'production',
      `🚨 Client approval agent failed for channel: ${channelId}\nError: ${err.message}\nManual update required.`
    ).catch(() => {});
  }
}

module.exports = { handleStoryboardReview, handleVideoReview, handleClientApproval };
