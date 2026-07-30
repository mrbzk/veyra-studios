# Veyra Agent

Production-ready Node.js webhook server powering two AI agents for Veyra Studios.

**Live at:** `https://agents.veyrastudios.eu`

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
- `POST /stripe-webhook` — Stripe checkout.session.completed → triggers onboarding
- `POST /notion-webhook` — Notion Client DB new row → processes form submission
- `POST /frameio-webhook` — Frame.io project status / review approval → production actions
- `POST /notion-storyboard` — Notion Project Tracker storyboard trigger
- `GET /health` — Health check

**Scheduler:** runs every 6 hours, chases clients who haven't submitted the onboarding form.

Both agents use `claude-sonnet-4-6` via the Anthropic API with a tool-use loop.

---

## Webhook URLs

| Endpoint | URL |
|---|---|
| Stripe | `https://agents.veyrastudios.eu/stripe-webhook` |
| Frame.io | `https://agents.veyrastudios.eu/frameio-webhook` |
| Notion (Zapier) | `https://agents.veyrastudios.eu/notion-webhook` |
| Storyboard trigger | `https://agents.veyrastudios.eu/notion-storyboard` |
| Health check | `https://agents.veyrastudios.eu/health` |

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
5. Copy the **Bot User OAuth Token** (starts with `xoxb-`) → paste as `SLACK_BOT_TOKEN` in hPanel.
6. Get your own Slack user ID: Slack → click your name → Profile → `···` → Copy member ID → paste as `SLACK_ADMIN_USER_ID`.
7. Create a `#production` channel in Slack and invite the bot: `/invite @Veyra Agent`.

---

## Stripe Webhook Configuration

1. Stripe Dashboard → **Developers** → **Webhooks** → Add endpoint.
2. URL: `https://agents.veyrastudios.eu/stripe-webhook`
3. Event: `checkout.session.completed`
4. After creating, click the endpoint → **Reveal signing secret** → copy.
5. Add to hPanel environment variables: `STRIPE_WEBHOOK_SECRET=whsec_...`

The server processes `checkout.session.completed` events, reading `plan`
and `language` off the Checkout Session's `metadata` (set on the Payment
Link — see below). It falls back to keyword-matching the customer name/
metadata for "spark"/"scale"/"system"/"story" if a link hasn't been
tagged. `customer.created` events are received but ignored, since
`checkout.session.completed` already carries everything onboarding needs
and firing on both would start onboarding twice.

### Tagging Payment Links for plan + language

Each plan needs one Payment Link per language (e.g. "Spark — English",
"Spark — Nederlands"). Metadata can't be set from the Payment Links
Dashboard UI — use the Stripe CLI:

```bash
stripe payment_links update plink_XXXXXXXX \
  -d "metadata[plan]=spark" \
  -d "metadata[language]=nl"
```

Valid `plan` values: `spark`, `scale`, `system`, `story`.
Valid `language` values: `en`, `nl`. Untagged links, or links missing
one of these keys, default to English.

Send clients the Payment Link matching their plan and language — the
agent stores the `Language` property ("English" / "Nederlands") on their
Client DB row during onboarding, and every later client-facing message
(reviews, delivery, chase messages) is composed in that language.

---

## Frame.io Webhook Configuration

1. [developer.frame.io](https://developer.frame.io) → Apps → your app → **Webhooks** → Add Webhook.
2. URL: `https://agents.veyrastudios.eu/frameio-webhook`
3. Select events: `project.status_updated`, `review_link.approved`
4. Copy the webhook secret shown after creation.
5. Add to hPanel environment variables: `FRAMEIO_WEBHOOK_SECRET=...`

---

## Environment Variables (hPanel)

Set these in hPanel → **Advanced** → **Node.js** → your app → **Environment variables**:

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

---

## Testing Endpoints

**Health check:**
```bash
curl https://agents.veyrastudios.eu/health
```

**Stripe checkout webhook (any plan/language, no real payment):**
```bash
STRIPE_WEBHOOK_SECRET=whsec_... node scripts/test-checkout-webhook.js spark en
STRIPE_WEBHOOK_SECRET=whsec_... node scripts/test-checkout-webhook.js spark nl
```
Sends a synthetic, correctly-signed `checkout.session.completed` event straight
to `/stripe-webhook` — this is what triggers onboarding for the 4 live plans.
Pass a third argument to target a different URL, e.g.
`http://localhost:3000/stripe-webhook` for local testing.

**Manual test customer (quicker, no signing needed):** Stripe Dashboard →
Customers → **+ Add customer** → set the description to something like
`Veyra 10-Pack EN` or `Veyra 10-Pack NL`. This uses the legacy Veyra 10-Pack
product as a dedicated test lane on `customer.created` — real customers from
the 4 live plans never match "10-pack"/"test" in their description, so this
can't double-fire onboarding for them. Include `spark`/`scale`/`system`/`story`
in the description too if you want a plan other than the default (Spark).

**Notion webhook:**
```bash
curl -X POST https://agents.veyrastudios.eu/notion-webhook \
  -H "Content-Type: application/json" \
  -d '{"parent":{"database_id":"36d8e2ee-ae0c-8028-a00b-f15951998479"},"properties":{"Your Name":{"title":[{"plain_text":"Test Client"}]},"Email":{"email":"test@example.com"},"Onboarding Form Submitted":{"checkbox":false}}}'
```

**Storyboard webhook:**
```bash
curl -X POST https://agents.veyrastudios.eu/notion-storyboard \
  -H "Content-Type: application/json" \
  -d '{"properties":{"Status":{"select":{"name":"Storyboard Review"}},"Storyboard Sent to Client":{"checkbox":false}}}'
```

**Frame.io webhook:** Test from Frame.io developer dashboard → Webhooks → Send test event (requires valid HMAC signature).

---

## Reading Logs (Hostinger)

Via SSH:
```bash
ssh u123456789@agents.veyrastudios.eu -p 65002
tail -f ~/logs/nodejs.log
# or check your app root for veyra-agent.log
```

Filter by prefix to trace a specific workflow:
- `[ONBOARDING]` — onboarding agent events
- `[PRODUCTION]` — production agent events
- `[SCHEDULER]` — 6-hour cron job events

Example log output:
```
[ONBOARDING] New customer received: John Smith
[ONBOARDING] Tool call: slack_create_channel {"name":"client-john-smith"}
[ONBOARDING] Slack channel ready: #client-john-smith (C123ABC456)
[ONBOARDING] Tool call: slack_invite_guest {"channel_id":"C123ABC456","email":"john@company.com"}
[ONBOARDING] Slack guest invite sent to: john@company.com
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
4. Add a **Language** select property to the Client DB, with options
   **English** and **Nederlands**. The onboarding agent sets this
   automatically from the Payment Link metadata — it just needs to
   exist on the database first.
