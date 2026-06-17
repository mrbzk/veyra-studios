# Veyra Studios — Agent Setup Instructions
# From zero to live
# ================================================


## Overview

You are deploying two AI agents to a Node.js server
hosted on Railway. The agents handle:

  Onboarding Agent
    Stripe payment → Slack channel + guest invite
    → Notion setup → Frame.io project

  Production Agent
    Storyboard review → Frame.io review → delivery

Total setup time: approximately 2-3 hours.


## What you need before starting

  ☐ Anthropic account (console.anthropic.com)
  ☐ GitHub account (already have)
  ☐ Railway account (railway.app — free to sign up)
  ☐ Stripe account (already have)
  ☐ Slack workspace (Pro plan or above for guest invites)
  ☐ Frame.io account (Pro plan for approval feature)
  ☐ Notion workspace (already set up)
  ☐ Node.js installed locally (nodejs.org)


## Part 1 — Get your Anthropic API key

1. Go to https://console.anthropic.com
2. Sign up or log in
3. Click API Keys in the left sidebar
4. Click Create Key → name it veyra-production
5. Add a payment method under Billing to activate
6. Copy the key — starts with sk-ant-
   Save it somewhere safe. You only see it once.


## Part 2 — Install Claude Code and build the server

1. Open your terminal

2. Install Claude Code:
   npm install -g @anthropic/claude-code

3. Authenticate:
   claude
   Follow the login prompt using your Anthropic account.

4. Create the project folder:
   mkdir veyra-agent
   cd veyra-agent

5. Create the prompts folder and copy in your prompt files:
   mkdir prompts
   Copy prompt-onboarding-agent.md → prompts/onboarding.md
   Copy prompt-production-agent.md → prompts/production.md

6. Start the Claude Code session:
   claude

7. Paste the full contents of CLAUDE-CODE-PROMPT.md
   into the session. Claude Code will build everything.

8. When complete, confirm these files exist:
   server.js
   agents/onboarding.js
   agents/production.js
   prompts/onboarding.md
   prompts/production.md
   utils/verify-stripe.js
   utils/verify-frameio.js
   utils/notion.js
   utils/slack.js
   utils/frameio.js
   .env.example
   .gitignore
   package.json
   README.md

9. Create your local .env file:
   cp .env.example .env

10. Open .env and fill in what you have now:
    ANTHROPIC_API_KEY=sk-ant-...
    PORT=3000
    NOTION_CLIENT_DB_ID=36d8e2ee-ae0c-8028-a00b-f15951998479
    NOTION_PROJECT_TRACKER_ID=36d8e2ee-ae0c-80f4-9158-fffc22de55e2
    INTERNAL_SLACK_CHANNEL=production
    ONBOARDING_FORM_URL=https://veyrastudios.eu
    Leave all other keys blank for now.

11. Test it runs locally:
    node server.js
    You should see:
    Veyra Agent running on port 3000
    Onboarding Agent ready
    Production Agent ready
    Scheduler running every 6 hours
    Press Ctrl+C to stop.


## Part 3 — Connect Notion

1. Go to https://www.notion.so/my-integrations
2. Click New integration
3. Name: Veyra Agent
4. Associated workspace: your Notion workspace
5. Click Submit
6. Copy the Internal Integration Token
   Paste into .env as NOTION_API_KEY=secret_...

7. Share your databases with the integration:
   Open Client DB in Notion
   → click ··· (top right) → Connections → Veyra Agent
   Repeat for Project Tracker
   Repeat for Script & Board Library


## Part 4 — Connect Slack

1. Go to https://api.slack.com/apps
2. Click Create New App → From Scratch
3. Name: Veyra Agent
4. Select your workspace → Create App

5. Go to OAuth & Permissions
6. Under Bot Token Scopes, add ALL of these:
   channels:manage
   channels:join
   channels:read
   channels:write
   chat:write
   groups:write
   users:read
   users:read.email

   NOTE: channels:write is required for guest invites.
   If you see "paid_teams_only" errors when testing,
   your Slack workspace needs to be on Pro plan or above.
   Guest invites are not available on the free Slack plan.

7. Click Install to Workspace → Allow
8. Copy the Bot User OAuth Token (starts with xoxb-)
   Paste into .env as SLACK_BOT_TOKEN=xoxb-...

9. Get your own Slack user ID:
   Open Slack → click your name → View profile
   Click ··· → Copy member ID
   Paste into .env as SLACK_ADMIN_USER_ID=U0XXXXXXX

10. Create your internal production channel in Slack:
    Create a channel called #production
    Invite the Veyra Agent bot to it:
    In Slack, type: /invite @Veyra Agent in #production


## Part 5 — Connect Frame.io

1. Go to https://developer.frame.io
2. Sign in with your Frame.io account
3. Click Apps → New App
4. Name: Veyra Agent

5. Generate a Developer Token with these scopes:
   asset.read
   project.read
   project.create
   review_link.read
   team.read
   Paste into .env as FRAMEIO_API_KEY=...

6. NOTE: Webhook secret comes after Railway deployment.
   Leave FRAMEIO_WEBHOOK_SECRET blank for now.

7. NOTE: The Approve button requires Frame.io Pro plan
   or above. Confirm this is available in your account
   before testing Zap 5.


## Part 6 — Deploy to Railway

1. Push your code to GitHub:
   git remote add origin https://github.com/[username]/veyra-agent.git
   git push -u origin main

2. Go to https://railway.app
3. Click New Project
4. Click Deploy from GitHub repo
5. Select veyra-agent
6. Railway detects Node.js and deploys automatically
   Wait ~2 minutes.
7. Click your project → Settings → Domains
   Generate a domain. You will get a URL like:
   https://veyra-agent-production.up.railway.app
   Copy this URL — you need it for the next steps.

8. Go to Variables in Railway
   Add every variable from your .env file:
   ANTHROPIC_API_KEY
   NOTION_API_KEY
   SLACK_BOT_TOKEN
   SLACK_ADMIN_USER_ID
   FRAMEIO_API_KEY
   NOTION_CLIENT_DB_ID
   NOTION_PROJECT_TRACKER_ID
   INTERNAL_SLACK_CHANNEL
   ONBOARDING_FORM_URL
   PORT (set to 3000)
   Leave Stripe and Frame.io webhook secrets blank for now.

9. Railway redeploys automatically after adding variables.

10. Test the health endpoint:
    curl https://veyra-agent-production.up.railway.app/health
    Should return:
    { "status": "ok", "agents": ["onboarding", "production"] }


## Part 7 — Connect Stripe webhook

1. Go to https://dashboard.stripe.com
2. Click Developers → Webhooks
3. Click Add endpoint
4. Endpoint URL:
   https://veyra-agent-production.up.railway.app/stripe-webhook
5. Click Select events → search for customer.created → Add
6. Click Add endpoint
7. Click the endpoint you just created
8. Click Reveal under Signing secret
9. Copy the whsec_... key
10. Go to Railway → Variables
    Add: STRIPE_WEBHOOK_SECRET=whsec_...
11. Railway redeploys automatically.


## Part 8 — Connect Frame.io webhooks

1. Go to https://developer.frame.io → Apps → Veyra Agent
2. Click Webhooks → Add Webhook
3. URL:
   https://veyra-agent-production.up.railway.app/frameio-webhook
4. Select events:
   project.status_updated
   review_link.approved
5. Copy the webhook secret shown
6. Go to Railway → Variables
   Add: FRAMEIO_WEBHOOK_SECRET=...
7. Railway redeploys automatically.


## Part 9 — Connect Notion webhook

Notion does not have native outbound webhooks.
Use one of these two options:

OPTION A — Zapier (recommended, you already have it):

  Zap: Notion new item in Client DB
       → HTTP POST to Railway URL

  Build this Zap in Zapier:
  Trigger: Notion → New Database Item → Client DB
  Action: Webhooks by Zapier → POST
    URL: https://veyra-agent-production.up.railway.app/notion-webhook
    Payload type: JSON
    Data: map all fields from the Notion trigger

  This fires when the onboarding form is submitted
  and Notion creates a new Client DB row.

OPTION B — Notion native automation:

  Open Client DB in Notion
  → ··· → Automations → New automation
  Trigger: Page added to database
  Action: Send webhook
    URL: https://veyra-agent-production.up.railway.app/notion-webhook


## Part 10 — Test end to end

TEST 1 — Health check:
  curl https://[railway-url]/health
  Expected: { "status": "ok" }

TEST 2 — Stripe (use test mode):
  Go to Stripe Dashboard → switch to Test mode
  Developers → Webhooks → your endpoint
  → Send test event → customer.created
  Check Railway logs (your project → Deployments → View logs)
  Expected logs:
    [ONBOARDING] New customer received: Test Customer
    [ONBOARDING] Creating Slack channel: client-test-customer
    [ONBOARDING] Sending guest invite to: test@example.com
    [ONBOARDING] Welcome message posted
    [ONBOARDING] Notion row created
    [ONBOARDING] Frame.io project created
  Check Slack: #client-test-customer channel should exist
  Check Notion: new Client DB row should exist

TEST 3 — Storyboard review:
  Open a Project Tracker row in Notion
  Change Status to Storyboard Review
  This triggers your Notion automation or Zapier Zap
  Check the client's Slack channel for the storyboard message

TEST 4 — Frame.io review:
  Upload a test video to Frame.io
  Set project status to Ready for Review
  Check Railway logs for [PRODUCTION] entries
  Check client Slack channel for review link message

TEST 5 — Frame.io approval:
  Open the Frame.io review link
  Click the Approve button
  Check Railway logs for approval handling
  Check client Slack channel for delivery message
  Check Notion: Status should be Delivered


## Part 11 — Go live

1. Switch Stripe from Test mode to Live mode
2. Confirm Frame.io is using your real workspace
3. Brief your team on the new workflow:
   - Client channels are created automatically
   - Clients are invited via email automatically
   - Set Frame.io project status to Ready for Review
     when videos are ready (not just upload)
   - The Approve button triggers final delivery

4. You are live. 🚀


## Ongoing operations

RAILWAY LOGS:
  Your project → Deployments → View logs
  Filter by [ONBOARDING] or [PRODUCTION] to trace
  any specific workflow run.

IF A GUEST INVITE FAILS:
  Check #production in Slack for the manual invite alert
  Go to Slack → your workspace → Members → Invite people
  → Single-channel guest → paste client email
  → Select their channel → Send invite

IF AN AGENT FAILS:
  Check Railway logs for the error
  Most failures are API rate limits or temporary outages
  All webhooks from Stripe and Frame.io retry automatically
  If Notion writes failed, manually update the row

ADDING A NEW CLIENT MANUALLY:
  If a client paid outside Stripe (invoice, etc.):
  Create a Client DB row manually in Notion with their
  email and name, then trigger the Notion webhook manually
  by saving the row — Zapier or the automation will fire.
