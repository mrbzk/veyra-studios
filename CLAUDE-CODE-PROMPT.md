# Claude Code Build Prompt — v2
# Veyra Studios — veyra-agent server
# Includes: Slack single-channel guest invite
# ================================================
# 1. Create a new empty folder called veyra-agent
# 2. Copy prompts/ folder into it (from this zip)
# 3. Open terminal in that folder
# 4. Run: claude
# 5. Paste everything below the dashed line
# ================================================

---

Build a production-ready Node.js Express webhook server
for Veyra Studios called veyra-agent. This server powers
two AI agents built on the Anthropic API. GHL is handled
separately via Zapier — do not include any GHL API calls.

Read the system prompts from:
  prompts/onboarding.md
  prompts/production.md
These files are already in the folder.
Use them verbatim as the system prompt for each agent.

PROJECT STRUCTURE:
  server.js
  agents/onboarding.js
  agents/production.js
  prompts/onboarding.md       (exists — do not overwrite)
  prompts/production.md       (exists — do not overwrite)
  utils/verify-stripe.js
  utils/verify-frameio.js
  utils/notion.js
  utils/slack.js
  utils/frameio.js
  .env.example                (exists — do not overwrite)
  .gitignore
  package.json
  README.md

DEPENDENCIES TO INSTALL:
  @anthropic-ai/sdk
  express
  stripe
  @notionhq/client
  axios
  dotenv
  node-cron

ENDPOINTS:

POST /stripe-webhook
  Verify Stripe signature using STRIPE_WEBHOOK_SECRET
  Only process event type: customer.created
  Filter: only continue if customer description or
  metadata contains "Veyra 10-Pack"
  Pass verified payload to agents/onboarding.js
  handleNewCustomer(customer)

POST /notion-webhook
  Accept Notion webhook payload
  Only process if page is from Client DB
  (check database_id matches NOTION_CLIENT_DB_ID)
  Filter: only continue if Onboarding Form Submitted
  is false or empty — this is a new form submission
  Pass payload to agents/onboarding.js
  handleFormSubmission(page)

POST /frameio-webhook
  Verify Frame.io signature using FRAMEIO_WEBHOOK_SECRET
  via HMAC SHA256
  Handle two event types:
    project.status_updated where status = "ready_for_review"
    → pass to agents/production.js handleReadyForReview(event)
    review_link.approved
    → pass to agents/production.js handleApproval(event)
  Return 200 immediately to acknowledge receipt
  Run agent logic asynchronously

POST /notion-storyboard
  Accept Notion webhook payload for Project Tracker updates
  Only process if Status = "Storyboard Review"
  AND Storyboard Sent to Client = false
  Pass to agents/production.js handleStoryboardReview(page)

GET /health
  Return 200 with JSON:
  { status: "ok", agents: ["onboarding", "production"],
    timestamp: new Date().toISOString() }

SCHEDULER:
  Use node-cron to run every 6 hours: 0 */6 * * *
  Call agents/onboarding.js checkPendingOnboarding()
  This function should:
    Query Notion Client DB for rows where:
      Onboarding Form Submitted = false
      Payment Date exists and is more than 24 hours ago
    For each row:
      Calculate days since payment
      If 1 day: send Day 1 chase to client Slack channel
      If 3 days: send Day 3 chase
      If 7 days: send Day 7 final chase
      If more than 7 days: skip
    Log results clearly

AGENT ARCHITECTURE:
  Each agent function should:
  1. Call the Claude API using @anthropic-ai/sdk
  2. Pass the relevant system prompt from prompts/
  3. Include the webhook payload as user message context
  4. Use tool_use with these tools:
     notion_create_page(database_id, properties)
     notion_update_page(page_id, properties)
     notion_query_database(database_id, filter)
     notion_get_page(page_id)
     slack_create_channel(name)
     slack_invite_admin(channel_id, user_id)
     slack_invite_guest(channel_id, email)
     slack_post_message(channel, text)
     frameio_create_project(name, team_id)
     frameio_get_project(project_id)
  5. Execute tool calls in a loop until stop_reason = "end_turn"
  6. Log each tool call and result

SLACK GUEST INVITE — CRITICAL IMPLEMENTATION:

Implement slack_invite_guest using the
conversations.inviteShared Slack API endpoint:

  POST https://slack.com/api/conversations.inviteShared
  Headers:
    Authorization: Bearer SLACK_BOT_TOKEN
    Content-Type: application/json
  Body:
    { "channel": "CHANNEL_ID", "emails": ["client@email.com"] }

This sends the client a direct email invitation to join
their dedicated channel as a single-channel guest.
They have no access to any other channels or workspace content.

Required Slack scope: channels:write
(already included in the scopes list)

Handle these response cases:
  ok: true → log success, continue
  error: "already_in_channel" → log and skip, continue
  error: "cant_invite_self" → log and skip, continue
  error: "paid_teams_only" → log warning, post manual
    invite alert to #production, continue
  any other error → log error, post manual invite
    alert to #production, continue

Manual invite alert format (post to INTERNAL_SLACK_CHANNEL):
  "⚠️ Manual Slack invite needed
   Client: [name]
   Email: [email]
   Channel: #[channel-name]
   Reason: [error message]"

The guest invite step should NEVER abort the full workflow.
Always continue even if the invite fails.

IMPLEMENTATION ORDER FOR handleNewCustomer:
  1. Format name to slug
  2. Check if #client-[slug] already exists
     If yes: use existing channel ID, skip creation
     If no: create new channel
  3. Invite admin user (SLACK_ADMIN_USER_ID) to channel
  4. Invite client as guest via conversations.inviteShared
     using the email from the Stripe customer object
  5. Post welcome message to channel
  6. Create Notion Client DB row
  7. Create Frame.io project
  8. Update Notion row with Frame.io project URL

Implement the tools as real API calls:
  Notion tools: use @notionhq/client
  Slack tools: use axios to call Slack Web API
    Base URL: https://slack.com/api/
    Auth: Bearer SLACK_BOT_TOKEN
  Frame.io tools: use axios to call Frame.io API v4
    Base URL: https://api.frame.io/v4/
    Auth: Bearer FRAMEIO_API_KEY

NOTION HELPER CONTEXT:
  Client DB ID: process.env.NOTION_CLIENT_DB_ID
  Project Tracker ID: process.env.NOTION_PROJECT_TRACKER_ID

  Key Client DB fields:
    Your Name (title), Email (email), Phone (phone_number),
    Slack Channel (rich_text), Status (select),
    Onboarding Form Submitted (checkbox),
    Onboarding Date (date), Payment Date (date),
    Client Type (select)

  Key Project Tracker fields:
    Name (title), Client Name (relation to Client DB),
    Status (select), Review Stage (select),
    Cycle Number (number), Is First Cycle (checkbox),
    Total Videos (number), Start Date (date),
    Storyboard Link (url),
    Storyboard Sent to Client (checkbox),
    Main Video Drive Link (url),
    Main Video Status (select),
    Main Video Approved (checkbox),
    Main Video Approved Date (date),
    Main Video Revisions (number),
    Hooks Drive Link (url),
    Hooks Status (select),
    Hooks Approved (checkbox),
    Hooks Approved Date (date),
    Hooks Revisions (number),
    Delivery Drive Link (url),
    Client Approved (checkbox),
    Delivered Date (date),
    Slack Notified (checkbox),
    Cycle Type (select)

LOGGING:
  Prefix all logs with agent name:
  [ONBOARDING] action description
  [PRODUCTION] action description
  [SCHEDULER] action description
  Log: webhook received, each tool call, each tool result,
  completion status, any errors

ERROR HANDLING:
  Wrap all agent runs in try/catch
  If a tool call fails: log the error and continue
    EXCEPTION: if Slack channel creation fails, abort
    and log — channel is required for all other steps
  If the agent run fails entirely: log full error
    and post alert to #production
  Always return 200 to webhooks even on internal errors

SECURITY:
  Verify Stripe signatures using stripe.webhooks.constructEvent
  Verify Frame.io signatures using HMAC SHA256 comparison
  Reject unverified requests with 401
  All secrets via process.env only — never hardcoded

GIT:
  git init
  git add .
  git commit -m "Initial commit — Veyra agent server v2"

README should include:
  1. Architecture overview
  2. Step by step Railway deployment
  3. Slack app setup including guest invite scopes
  4. How to configure Stripe webhook
  5. How to configure Frame.io webhook
  6. How to add environment variables in Railway
  7. curl examples for testing each endpoint
  8. How to read Railway logs
  9. Note on Slack plan requirement for guest invites
