# Veyra Agent

Node.js server that runs two Claude-powered agents for Veyra Studios:

- **Onboarding agent**: turns a Paid Trial payment into a ready-to-go client: Slack channel, welcome message, Notion records and an alert for the team. Then it chases the kickoff call booking.
- **Production agent**: sends storyboard and video reviews to the client in Slack, handles their approvals, and delivers the final files.
- **Subscriptions** (plain code): when a Launch, Core or Growth subscription is paid, upgrades the trial client or onboards a new one, and creates a new cycle on every monthly renewal.

**Live at:** `https://srv.veyrastudios.agency` (Hostinger VPS, run with pm2)

For a from-scratch setup, see [SETUP-INSTRUCTIONS.md](SETUP-INSTRUCTIONS.md).

---

## How a client moves through the system

```
Stripe (Paid Trial EN / NL / FR link)
   │  checkout.session.completed
   ▼
Onboarding agent ──► Slack #client-<name>: invite + welcome (EN/NL/FR) with kickoff booking link
                 ──► Notion Client DB row (Client Type = Trial, Kickoff Call Booked = false)
                 ──► Notion Project Tracker row "<Name> — Cycle 1" (Total Videos = 4)
                 ──► #production alert
   │
   ▼  every 6 hours
Reminders (day 1, 3, 7) ──► "book your kickoff call", until someone types /booked
   │
   ▼  team updates Notion as production progresses
Production agent ──► storyboard review ─► client replies "Approved"
                 ──► main video review ─► "Approved"
                 ──► hooks review      ─► "Approved" ─► final delivery + trial follow-up
```

### 1. Payment → onboarding
- Only the three **Paid Trial** Payment Links start onboarding. Each carries Stripe metadata `plan: trial` and `language: EN`, `NL` or `FR`. Every other checkout is ignored.
- The Paid Trial is the client's **Cycle 1**: 1 core video + 3 hooks (4 videos).
- There is **no onboarding form**. The welcome message asks the client to book their kickoff call at `KICKOFF_BOOKING_URL`.

### 2. Kickoff call reminders
- Every 6 hours the server checks the Client DB for clients (trial or package) whose **Kickoff Call Booked** is unticked, and posts a reminder in their channel on day 1, 3 and 7 after payment (EN, NL or FR). This runs in code, not through the AI.
- When the client has booked, someone on the team types **`/booked`** in the client's channel. That ticks the box and the reminders stop. See [Slack commands](#slack-commands).

### 3. Upgrade to a monthly package

The packages are Stripe Products with metadata `plan` (`launch`, `core`, `growth`) and `language` (`EN`, `NL`, `FR`):

| Plan | Videos per month | Also |
|---|---|---|
| Launch | 8 (2 concepts × 4 hooks) | 3 static ads |
| Core | 16 (4 concepts × 4 hooks) | 5 static ads with copy variants |
| Growth | 24 (6 concepts × 4 hooks) | 10 static ads, YouTube Shorts |

Everything runs on Stripe's **`invoice.paid`** event, so nothing happens until the client has paid. The client is matched to the Client DB by **email**, so the Stripe customer's email must be the same as on their Notion row.

| What happened in Stripe | What the server does |
|---|---|
| A subscription is added to an existing client (e.g. a trial client, via the Stripe dashboard) and its first invoice is paid | Client DB: **Plan Purchased** → the package, **Client Type** → `Recurring`. Project Tracker: next cycle row (`<Name> — Cycle 2`, Status `Briefing`, Total Videos 8/16/24). Confirmation in the client's channel (in their Language), `🚀 Trial converted` in #production. No call, no reminders |
| Someone with no Client DB row buys a package through a package Payment Link | Full onboarding, as for the Paid Trial but for the package: Slack channel, package welcome message with the kickoff booking link, Client DB (`Recurring`), Cycle 1 with the right Total Videos, day 1/3/7 reminders until `/booked` |
| A monthly renewal invoice is paid | Next cycle row in the Project Tracker, `🔁 New monthly cycle` in #production. Nothing is sent to the client |

Code: `agents/subscriptions.js` and `utils/plans.js` (video counts and the wording of each package's monthly scope).

**Not automated yet:** reviews for Launch, Core and Growth cycles (several concepts plus static ads). If a Notion automation fires for one of those rows, the production agent sends nothing to the client and asks the team in #production to handle it by hand.

### 4. Production
Triggered by Notion automations on the Project Tracker:

| When this happens in Notion | The production agent |
|---|---|
| **Status** → `Storyboard Review` | Posts the **Storyboard Link** to the client, ticks **Storyboard Sent to Client** |
| **Main Video Status** or **Hooks Status** → `Ready for Review` | Posts the matching Drive link to the client, sets the status to `In Review` |
| Client types **"Approved"** (or "approuvé") in their channel (or clicks the storyboard button) | Advances the stage: storyboard → `In Production`; main video → Review Stage `Hooks`; hooks → sends the **Delivery Drive Link**, marks the cycle `Delivered` |

After delivery, the follow-up depends on **Client Type**:
- **Trial**: "When you are ready to scale up…" to the client, plus a conversion alert in #production
- **Recurring**: "When you are ready to kick off your next cycle…"
- **One-off**: #production alert only

All client messages are in the client's **Language** (English, Nederlands or Français) and follow the Veyra brand voice: no em dashes, emoji or exclamation marks. Internal #production alerts are always in English.

**French coverage:** FR templates exist for the whole Paid Trial journey (welcome, reminders, storyboard, main video, hooks, delivery, follow-ups). The older Spark/Scale/System/Story review templates are EN/NL only; if a French client hits one, the agent sends English and flags it in #production.

---

## Slack commands

Typed by the Veyra team inside a client channel. Clients (guests) can't use them.

| Command | Effect |
|---|---|
| `/booked` | Ticks **Kickoff Call Booked** on the client's Notion row, stops the reminders, posts to #production |
| `/booked <any text>` | Same, and adds the text as "When:" in the #production post, in any format (`Thu 14:00`, `14/11 2pm`, `donderdag 14u`) |
| `/booked undo` | Unticks it, so the reminders resume |

The client is found by the channel's name matching **Slack Channel** on their Client DB row.

---

## Code map

```
server.js               Express server: webhook endpoints, signature checks, 6-hour scheduler
agents/onboarding.js    Onboarding agent (Claude tool-use loop) + kickoff call reminders
agents/production.js    Production agent (Claude tool-use loop)
agents/booking.js       /booked Slack command
agents/subscriptions.js Package upgrades, direct package purchases, renewals (invoice.paid)
prompts/onboarding.md   Onboarding agent instructions and EN/NL message templates
prompts/production.md   Production agent instructions, review state machine and templates
utils/plans.js          Package catalogue: video counts and monthly scope per language
utils/notion.js         Notion API helpers
utils/slack.js          Slack API helpers (channels, invites, messages)
utils/verify-stripe.js  Stripe webhook signature check
utils/verify-slack.js   Slack request signature check
scripts/test-checkout-webhook.js   Sends a signed test checkout event
```

**Changing message wording or process steps:** edit `prompts/*.md`. The agents follow those files, so most changes need no code. The reminder texts are the exception: they are in `agents/onboarding.js` (`CHASE_MESSAGES`).

Both agents use `claude-sonnet-4-6`. The model name appears in `agents/onboarding.js`, `agents/production.js` and `server.js` (`/diagnostic`).

---

## Endpoints

| Method | Path | Called by | Purpose |
|---|---|---|---|
| POST | `/stripe-webhook` | Stripe | `checkout.session.completed` (Paid Trial), `invoice.paid` (packages: upgrade, direct purchase, renewal) and the `customer.created` test lane |
| POST | `/notion-storyboard` | Notion automation | Storyboard ready for the client |
| POST | `/notion-video-review` | Notion automation | Main video or hooks ready for the client |
| POST | `/slack-events` | Slack Events API | Client replies containing "approved" |
| POST | `/slack-interactive` | Slack interactivity | Storyboard approve button |
| POST | `/slack-commands` | Slack slash commands | `/booked` (requires `SLACK_SIGNING_SECRET`) |
| POST | `/notion-webhook` | (retired) | Old onboarding form; now logs and ignores |
| GET | `/health` | You | Returns `{"status":"ok"}` |
| GET | `/diagnostic` | You | Checks the Anthropic API key works |

---

## Environment variables

Set in `/var/www/veyra-agent/.env` on the VPS. See [env.example](env.example) for where to find each value.

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `STRIPE_WEBHOOK_SECRET` | Yes | Signing secret of the Stripe webhook endpoint (`whsec_…`) |
| `STRIPE_SECRET_KEY` | Yes, for packages | Restricted read-only key (`rk_live_…`): Customers Read, Products Read. Without it, package payments post a 🚨 alert in #production instead of being processed |
| `NOTION_API_KEY` | Yes | Notion integration token |
| `NOTION_CLIENT_DB_ID` | Yes | `36d8e2ee-ae0c-8028-a00b-f15951998479` |
| `NOTION_PROJECT_TRACKER_ID` | Yes | `36d8e2ee-ae0c-80f4-9158-fffc22de55e2` |
| `SLACK_BOT_TOKEN` | Yes | Slack bot token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | Yes | Slack app signing secret. Without it `/booked` is off and the other Slack routes skip verification |
| `SLACK_ADMIN_USER_ID` | Yes | Your Slack member ID, invited to every client channel |
| `SLACK_TEAM_MEMBER_IDS` | No | Extra member IDs to invite, comma-separated |
| `INTERNAL_SLACK_CHANNEL` | No | Team alerts channel, default `production` |
| `KICKOFF_BOOKING_URL` | No | Kickoff call booking page, default `https://veyrastudios.eu/onboarding` |
| `PORT` | No | Default `3000` (nginx proxies to it) |

After changing `.env`: `pm2 restart veyra-agent --update-env`.

---

## Notion setup

The Notion integration must be connected to both databases (database `···` → **Connections**). Property names must match exactly.

**Client DB**

| Property | Type | Values / notes |
|---|---|---|
| Your Name | Title | |
| Email | Email | |
| Plan Purchased | Select | `Paid Trial`, `Launch`, `Core`, `Growth` (older rows may have Spark, Scale, System, Story) |
| Language | **Select** | `English`, `Nederlands`, `Français` |
| Slack Channel | Text | e.g. `#client-jane-doe`; `/booked` matches on this |
| Status | Select | `Active` |
| Client Type | Select | `Trial`, `Recurring`, `One-off`. Upgrades set `Recurring` |
| Kickoff Call Booked | Checkbox | Ticked by `/booked`; stops the reminders |
| Payment Date | Date | |
| Onboarding Date | Date | |

**Project Tracker**

| Property | Type | Values / notes |
|---|---|---|
| Name | Title | `<Client> — Cycle 1` |
| Client Name | Relation | → Client DB |
| Cycle Number | Number | |
| Is First Cycle | Checkbox | |
| Total Videos | Number | Identifies the plan: 4 Paid Trial, 8 Launch, 16 Core, 24 Growth (older: 6 Spark, 11 Scale, 22 System, 5 Story) |
| Status | Select | `Briefing`, `Storyboard Review`, `In Production`, `Delivered` |
| Review Stage | Select | `Main Video`, `Hooks`, `Complete` |
| Start Date | Date | |
| Storyboard Link | URL | Sent to the client for storyboard review |
| Storyboard Sent to Client, Storyboard Approved | Checkbox | |
| Storyboard Approved Date | Date | |
| Main Video Status, Hooks Status | Select | `Not Started`, `Ready for Review`, `In Review`, `Approved` |
| Main Video Drive Link, Hooks Drive Link, Delivery Drive Link | URL | |
| Main Video Approved, Hooks Approved, Client Approved, Slack Notified | Checkbox | |
| Main Video Approved Date, Hooks Approved Date, Delivered Date | Date | |

**Automations** (Project Tracker → Automations, action **Send webhook**):
- Status changes to `Storyboard Review` → `https://srv.veyrastudios.agency/notion-storyboard`
- Main Video Status or Hooks Status changes to `Ready for Review` → `https://srv.veyrastudios.agency/notion-video-review`

---

## Stripe setup

- **Webhook endpoint:** `https://srv.veyrastudios.agency/stripe-webhook`, events `checkout.session.completed`, `customer.created` and `invoice.paid`. Its signing secret is `STRIPE_WEBHOOK_SECRET`.
- **Restricted key** for `STRIPE_SECRET_KEY`: Developers → API keys → Create restricted key, Customers **Read**, Products **Read**, nothing else.
- **Package Products** (Launch, Core, Growth in EN/NL/FR) must keep their metadata `plan` and `language`. A subscription to a product without a known `plan` is ignored.
- **Paid Trial EN** Payment Link metadata: `plan` = `trial`, `language` = `EN`
- **Paid Trial NL** Payment Link metadata: `plan` = `trial`, `language` = `NL`
- **Paid Trial FR** Payment Link metadata: `plan` = `trial`, `language` = `FR`

A Payment Link without `plan: trial` does not start onboarding.

---

## Slack app setup

App: **Veyra Agent** at [api.slack.com/apps](https://api.slack.com/apps).

- **Bot token scopes:** `channels:manage`, `channels:read`, `channels:join`, `groups:read`, `chat:write`, `users:read`, `users:read.email`, `commands`, plus the scope Slack asks for to invite external guests with `conversations.inviteShared`. Single-channel guest invites need a paid Slack plan; if an invite fails, #production gets a "Manual Slack invite needed" alert.
- **Event Subscriptions:** Request URL `https://srv.veyrastudios.agency/slack-events`, bot events `message.channels` (and `message.groups` if client channels are private).
- **Interactivity:** Request URL `https://srv.veyrastudios.agency/slack-interactive`.
- **Slash Commands:** `/booked`, Request URL `https://srv.veyrastudios.agency/slack-commands`.
- After changing scopes or commands, **reinstall the app** to the workspace.
- The bot must be a member of `#production`.

---

## Running the server (VPS)

The app lives in `/var/www/veyra-agent` and runs under pm2 as `veyra-agent`. nginx terminates HTTPS for `srv.veyrastudios.agency` and proxies to port 3000. Do not touch the other pm2 app on the same server (`spark-clip-agent`).

**Deploy the latest `master`:**

```bash
cd /var/www/veyra-agent && git pull origin master && npm install
```

```bash
pm2 restart veyra-agent --update-env
```

**Logs:**

```bash
pm2 logs veyra-agent
```

Log lines are prefixed `[ONBOARDING]`, `[PRODUCTION]`, `[SCHEDULER]`, `[BOOKING]` and `[SLACK]`. Errors go to `/root/.pm2/logs/veyra-agent-error.log`.

**Health checks:**

```bash
curl -s localhost:3000/health
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://srv.veyrastudios.agency/stripe-webhook
```

The second should print `401` (reachable, rejected for having no Stripe signature). `000` means HTTPS or nginx is broken.

**SSL certificate:** Let's Encrypt via certbot with the nginx plugin; renews automatically (`systemctl list-timers | grep certbot`). Check with `certbot renew --dry-run`.

---

## Testing

**Manual test lane (no payment):** Stripe → Customers → **+ Add customer**, with `test` in the description (`test NL` for Dutch, `test FR` for French) and an email you control. This runs the full Paid Trial onboarding, including a real Slack invite. Clean up afterwards: archive the Slack channel, delete the Notion rows and the Stripe customer.

**Signed checkout event:**

```bash
STRIPE_WEBHOOK_SECRET=whsec_... node scripts/test-checkout-webhook.js nl https://srv.veyrastudios.agency/stripe-webhook
```

`en`, `nl` or `fr`. Without the URL argument it targets the default in the script.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Nothing in the log after a purchase; Stripe shows the event as pending | Stripe can't reach the server. Check the public curl above; an expired SSL certificate shows as `000` |
| `Language is expected to be rich_text` (or similar) from Notion | A Client DB or Project Tracker property has the wrong type or name; compare with the tables above |
| `/booked failed because the app did not respond` | `SLACK_SIGNING_SECRET` missing or wrong, or the app wasn't restarted after changing `.env`. The log shows `Slash command signature verification failed` |
| "No client in the Client DB has Slack Channel …" after `/booked` | Run it in the client's own channel, or fix **Slack Channel** on their Notion row |
| "Manual Slack invite needed" in #production | Slack refused the guest invite; invite the client by hand as a single-channel guest |
| 🚨 "Subscription automation failed" in #production | Usually `STRIPE_SECRET_KEY` missing or without Products/Customers read access. The error text says why. Update Notion and Slack for that client by hand |
| ⚠️ "renewal paid … but no Client DB row has that email" | The Stripe customer's email differs from the Client DB **Email**. Fix one of them, then create the cycle row by hand |
| 🚨 "Onboarding agent failed" in #production | The agent stopped mid-way; the error text says why. Finish that client's setup by hand |
