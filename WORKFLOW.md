# Veyra Studios — Client Workflow (current)

Step-by-step breakdown of how a Paid Trial client moves from payment to
delivery, as the code works today. Each step says **who acts** (the team,
the client, or the agent automatically) and **what triggers the next step**.

> Replaces the flow in `SETUP-INSTRUCTIONS.md` Part 10/11, which still
> describes the retired onboarding form, `customer.created` and Frame.io.

`<server>` below is the live agent host (the one the Stripe webhook points at).

---

## At a glance

| # | Stage | Who acts | Trigger | Agent does |
|---|---|---|---|---|
| 1 | Payment | Client | Pays via **Paid Trial EN** or **Paid Trial NL** Payment Link | — |
| 2 | Onboarding | Automatic | Stripe `checkout.session.completed` → `/stripe-webhook` | Slack channel + invites + welcome, Client DB row, Cycle 1 Project Tracker row, alert to #production |
| 3 | Kickoff reminders | Automatic | Every 6 h | Day 1 / 3 / 7 reminder in client channel until call is booked |
| 4 | Kickoff booked | Client | Books in GoHighLevel → `/ghl-booking` | Ticks **Kickoff Call Booked**, posts to #production, reminders stop |
| 5 | Kickoff call + storyboard | Team | — | — |
| 6 | Send storyboard | Team | Project Tracker **Status → Storyboard Review** → `/notion-storyboard` | Posts storyboard link to client |
| 7 | Storyboard approval | Client | Replies **Approved** in Slack → `/slack-events` | Status → In Production, confirms to client + #production |
| 8 | Main video review | Team | **Main Video Status → Ready for Review** → `/notion-video-review` | Posts main video link to client, status → In Review |
| 9 | Main video approval | Client | Replies **Approved** | Review Stage → Hooks, alerts #production to start hooks |
| 10 | Hooks review | Team | **Hooks Status → Ready for Review** → `/notion-video-review` | Posts hooks link to client, status → In Review |
| 11 | Hooks approval + delivery | Client | Replies **Approved** | Sends delivery link, marks Delivered, post-delivery messages |
| 12 | Conversion follow-up | Team | #production "Trial cycle delivered" alert | — |

---

## Step by step

### 1. Client pays (client)
- Send the client the Payment Link that matches their language:
  **Paid Trial EN** or **Paid Trial NL**.
- Each link must carry metadata `plan=trial` and `language=en|nl`
  (set with the Stripe CLI — see README). Missing/unknown language → English.
- Any other checkout (Spark, Scale, System, Story, invoices) is **ignored**
  by the agent — those clients must be onboarded manually.

### 2. Onboarding runs (automatic, ~1 min)
Triggered by `checkout.session.completed`. The Onboarding Agent, in order:
1. Creates Slack channel `#client-<first-last>`.
2. Invites the admin (`SLACK_ADMIN_USER_ID`) plus `SLACK_TEAM_MEMBER_IDS`.
3. Invites the client as a single-channel guest by email.
   *If this fails, a "Manual Slack invite needed" alert lands in #production.*
4. Posts the welcome message (EN/NL) with the kickoff booking link
   (`KICKOFF_BOOKING_URL`).
5. Creates the **Client DB** row: Your Name, Email, Plan Purchased = Paid Trial,
   Language, Slack Channel, Status = Active, Client Type = Trial,
   Kickoff Call Booked = false, Payment Date, Onboarding Date.
6. Creates the **Project Tracker** row `<Name> — Cycle 1`: Status = Briefing,
   Review Stage = Main Video, Main Video / Hooks Status = Not Started,
   Total Videos = 4, Is First Cycle = true.
7. Posts **🎉 New trial client** to #production with both Notion links.

**Team check:** confirm the 🎉 alert arrived and no ⚠️/🚨 alerts followed.
If you see 🚨 "Onboarding agent failed", do the steps above by hand.

### 3. Kickoff reminders (automatic)
- Every 6 hours the scheduler looks for Client DB rows with
  Client Type = Trial, Kickoff Call Booked = false, Payment Date set.
- Posts a reminder in the client's channel on **day 1, 3 and 7** after payment
  (in their language). Nothing is sent after day 8.

### 4. Client books the kickoff call (client → automatic)
- GoHighLevel workflow *Appointment Booked → Webhook* posts to
  `https://<server>/ghl-booking?secret=<GHL_WEBHOOK_SECRET>`.
- Agent finds the Client DB row **by email**, ticks **Kickoff Call Booked**
  and posts **📅 Kickoff call booked** to #production. Reminders stop.
- **If the client booked with a different email**, #production gets a ⚠️ —
  tick **Kickoff Call Booked** on their row manually.

### 5. Kickoff call and storyboard (team)
- Hold the kickoff call, write the brief, produce the storyboard.
- Paste the storyboard URL into the Project Tracker **Storyboard Link** field.

### 6. Send the storyboard for review (team → automatic)
- Set Project Tracker **Status → Storyboard Review**.
- Notion automation calls `/notion-storyboard`; the agent posts the storyboard
  link to the client's channel and ticks **Storyboard Sent to Client**.
- **Fill in Storyboard Link before changing Status** — if it's empty the
  agent posts ⚠️ to #production and sends nothing. To retry, switch Status
  away and back to Storyboard Review.

### 7. Client approves the storyboard (client → automatic)
- Client replies **Approved** in their channel.
- Agent sets Storyboard Approved = true, Approved Date, **Status → In Production**,
  thanks the client and posts ✅ to #production.

### 8. Send the main video for review (team → automatic)
- Paste the link into **Main Video Drive Link**.
- Set **Main Video Status → Ready for Review** (Review Stage must be Main Video).
- Agent posts the review message to the client and sets
  **Main Video Status → In Review**.

### 9. Client approves the main video (client → automatic)
- Client replies **Approved**.
- Agent sets Main Video Approved, Main Video Status = Approved,
  **Review Stage → Hooks**, and posts **✅ Core video(s) approved** to #production.
  → Start the 3 hooks.

### 10. Send the hooks for review (team → automatic)
- Paste the link into **Hooks Drive Link** and also fill in
  **Delivery Drive Link** now (it's needed at step 11).
- Set **Hooks Status → Ready for Review**.
- Agent posts the hooks review message and sets **Hooks Status → In Review**.

### 11. Client approves hooks → delivery (client → automatic)
- Client replies **Approved**.
- Agent reads **Delivery Drive Link** (empty → ⚠️ to #production, stops),
  then sets Hooks Approved, Review Stage = Complete, Client Approved,
  Delivered Date, **Status → Delivered**, Slack Notified.
- Posts the final delivery message + the Trial post-delivery message to the client.
- Posts **📊 Trial cycle delivered** to #production.

### 12. Conversion follow-up (team)
- On the 📊 alert, flag the client for conversion follow-up in GHL
  (upsell to Spark / Scale / System / Story).

---

## Team rules of thumb

- **Only one thing in review at a time.** "Approved" is matched to whatever is
  currently in review (storyboard → main video → hooks). Don't put the main
  video in Ready for Review while the storyboard is still awaiting approval.
- **Links first, status second.** Every review step reads a link field; set it
  before flipping the status.
- **Any message containing "approve"** from the client counts as approval,
  so ask clients to give feedback without that word until they're ready.
- **Watch #production.** Every failure posts a ⚠️ or 🚨 there with the manual
  action needed.

## Required wiring

| Integration | Setting |
|---|---|
| Stripe webhook | `https://<server>/stripe-webhook`, event `checkout.session.completed` (keep `customer.created` only for the manual test lane) |
| GoHighLevel | Appointment Booked → Webhook → `https://<server>/ghl-booking?secret=…` |
| Notion automation 1 | Project Tracker, Status = Storyboard Review → webhook `https://<server>/notion-storyboard` |
| Notion automation 2 | Project Tracker, Main Video Status or Hooks Status = Ready for Review → webhook `https://<server>/notion-video-review` |
| Slack app | Event Subscriptions → `https://<server>/slack-events` (bot event `message.channels`); `SLACK_SIGNING_SECRET` set |

## Testing the flow

```bash
STRIPE_WEBHOOK_SECRET=whsec_... node scripts/test-checkout-webhook.js en
```
Or in Stripe Dashboard → Customers → **+ Add customer** with description
`test` (English) or `test NL` (Dutch). Then walk steps 4–11 by hand on the
test client's Notion rows and Slack channel.
