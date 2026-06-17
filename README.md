# Veyra Agent

Production-ready Node.js webhook server powering two AI agents for Veyra Studios.

## Architecture

```
server.js               Express HTTP server — 5 endpoints + cron scheduler
agents/onboarding.js    Onboarding Agent (Stripe → Slack → Notion → Frame.io)
agents/production.js    Production Agent (Frame.io reviews → Slack → Notion)
utils/notion.js         Notion API helper (@notionhq/client)
utils/slack.js          Slack Web API helper (axios)
utils/frameio.js        Frame.io API v4 helper (axios)
utils/verify-stripe.js  Stripe webhook HMAC verification
utils/verify-frameio.js Frame.io webhook HMAC SHA256 verification
prompts/onboarding.md   System prompt for the Onboarding Agent
prompts/production.md   System prompt for the Production Agent
```

**Endpoints:**
- `POST /stripe-webhook` — Stripe customer.created → triggers onboarding
- `POST /notion-webhook` — Notion Client DB new row → processes form submission
- `POST /frameio-webhook` — Frame.io project status / review approval → production actions
- `POST /notion-storyboard` — Notion Project Tracker storyboard trigger
- `GET /health` — Health check

**Scheduler:** runs every 6 hours, chases clients who haven't submitted the onboarding form.

Both agents use `claude-sonnet-4-6` via the Anthropic API with a tool-use loop.

---

## Railway Deployment

1. Push this repo to GitHub.

2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo → select `veyra-agent`.

3. Railway detects Node.js and deploys automatically (~2 minutes). You'll get a URL like:
   ```
   https://veyra-agent-production.up.railway.app
   ```

4. Go to your Railway project → **Variables** → add every variable from `.env.example`.

5. Railway redeploys after each variable change.

6. Verify deployment:
   ```bash
   curl https://veyra-agent-production.up.railway.app/health
   # → { "status": "ok", "agents": ["onboarding", "production"], "timestamp": "..." }
   ```

---

## Slack App Setup

> **Slack plan requirement:** Single-channel guest invites (`conversations.inviteShared`) require a **Slack Pro plan or above**. On the free plan, the agent will log a warning and post a manual invite alert to `#production`.

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From Scratch.
2. Name: **Veyra Agent** → select your workspace → Create App.
3. Go to **OAuth & Permissions** → Bot Token Scopes → add all of these:

   | Scope | Purpose |
   |---|---|
   | `channels:manage` | Create client channels |
   | `channels:join` | Join channels |
   | `channels:read` | List channels (dedup check) |
   | `chat:write` | Post messages |
   | `groups:write` | Create private channels |
   | `users:read` | Look up user profiles |
   | `users:read.email` | Find users by email |
   | `channels:write` | **Required for guest invites** |

4. Click **Install to Workspace** → Allow.
5. Copy the **Bot User OAuth Token** (starts with `xoxb-`) → paste into `.env` as `SLACK_BOT_TOKEN`.
6. Get your own Slack user ID: Slack → click your name → Profile → `···` → Copy member ID → paste as `SLACK_ADMIN_USER_ID`.
7. Create a `#production` channel in Slack and invite the bot: `/invite @Veyra Agent`.

---

## Stripe Webhook Configuration

1. Stripe Dashboard → **Developers** → **Webhooks** → Add endpoint.
2. URL: `https://[your-railway-url]/stripe-webhook`
3. Event: `customer.created`
4. After creating, click the endpoint → **Reveal signing secret** → copy.
5. Add to Railway variables: `STRIPE_WEBHOOK_SECRET=whsec_...`

The server only processes `customer.created` events where the customer description or metadata contains `"Veyra 10-Pack"`.

---

## Frame.io Webhook Configuration

1. [developer.frame.io](https://developer.frame.io) → Apps → your app → **Webhooks** → Add Webhook.
2. URL: `https://[your-railway-url]/frameio-webhook`
3. Select events: `project.status_updated`, `review_link.approved`
4. Copy the webhook secret shown after creation.
5. Add to Railway: `FRAMEIO_WEBHOOK_SECRET=...`

---

## Environment Variables (Railway)

Go to your Railway project → **Variables** → add each one:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (`sk-ant-...`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_...`) |
| `FRAMEIO_API_KEY` | Frame.io developer token |
| `FRAMEIO_WEBHOOK_SECRET` | Frame.io webhook secret |
| `NOTION_API_KEY` | Notion integration token (`secret_...`) |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `SLACK_ADMIN_USER_ID` | Your Slack user ID (`U0XXXXXXX`) |
| `NOTION_CLIENT_DB_ID` | `36d8e2ee-ae0c-8028-a00b-f15951998479` |
| `NOTION_PROJECT_TRACKER_ID` | `36d8e2ee-ae0c-80f4-9158-fffc22de55e2` |
| `INTERNAL_SLACK_CHANNEL` | `production` |
| `ONBOARDING_FORM_URL` | `https://veyrastudios.eu` |
| `PORT` | `3000` |

---

## Testing Endpoints (curl)

**Health check:**
```bash
curl https://[railway-url]/health
```

**Stripe test event** (from Stripe Dashboard → Developers → Webhooks → Send test event → customer.created):
Check Railway logs for `[ONBOARDING]` entries.

**Notion webhook:**
```bash
curl -X POST https://[railway-url]/notion-webhook \
  -H "Content-Type: application/json" \
  -d '{"parent":{"database_id":"36d8e2ee-ae0c-8028-a00b-f15951998479"},"properties":{"Your Name":{"title":[{"plain_text":"Test Client"}]},"Email":{"email":"test@example.com"},"Onboarding Form Submitted":{"checkbox":false}}}'
```

**Frame.io webhook (requires valid HMAC signature in `x-frameio-signature` header):**
```bash
# Test from Frame.io developer dashboard → Webhooks → Send test event
```

**Storyboard webhook:**
```bash
curl -X POST https://[railway-url]/notion-storyboard \
  -H "Content-Type: application/json" \
  -d '{"properties":{"Status":{"select":{"name":"Storyboard Review"}},"Storyboard Sent to Client":{"checkbox":false}}}'
```

---

## Reading Railway Logs

Go to your Railway project → **Deployments** → click the active deployment → **View logs**.

Filter by agent:
- `[ONBOARDING]` — onboarding agent events
- `[PRODUCTION]` — production agent events
- `[SCHEDULER]` — 6-hour cron job events

Each tool call and result is logged. Example:
```
[ONBOARDING] New customer received: John Smith
[ONBOARDING] Tool call: slack_create_channel {"name":"client-john-smith"}
[ONBOARDING] Slack channel ready: #client-john-smith (C123ABC456)
[ONBOARDING] Tool call: slack_invite_guest {"channel_id":"C123ABC456","email":"john@company.com"}
[ONBOARDING] Slack guest invite sent to: john@company.com
[ONBOARDING] Tool call: notion_create_page {...}
[ONBOARDING] Notion page created: abc-123-def-456
[ONBOARDING] Frame.io project created: John Smith
[ONBOARDING] Completed onboarding for: John Smith
```

---

## If a Guest Invite Fails

Check `#production` in Slack — the agent automatically posts a manual invite alert:
```
⚠️ Manual Slack invite needed
Client: John Smith
Email: john@company.com
Channel: #client-john-smith
Reason: paid_teams_only
```

To send manually: Slack → workspace → **Members** → Invite people → Single-channel guest → paste client email → select their channel → Send.

---

## Notion Integration Setup

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) → New integration → Name: **Veyra Agent**.
2. Copy the Internal Integration Token → paste as `NOTION_API_KEY`.
3. Share each database with the integration:
   - Open Client DB in Notion → `···` (top right) → Connections → Veyra Agent
   - Repeat for Project Tracker
