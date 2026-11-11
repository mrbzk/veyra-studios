# Veyra Agent: setup from scratch

Use this to rebuild the server on a new machine or reconnect a service. Day-to-day running, the Notion schema and troubleshooting are in [README.md](README.md).

Current production: Hostinger VPS, app in `/var/www/veyra-agent`, pm2 process `veyra-agent`, domain `srv.veyrastudios.agency`.

## Before you start

- A Linux VPS with root access (Hostinger VPS has a browser terminal in hPanel)
- A domain or subdomain whose DNS **A record** points to the VPS IP
- Accounts: Anthropic, Stripe, Slack (paid plan for guest invites), Notion, GitHub access to `mrbzk/veyra-studios`

---

## 1. Server software

```bash
apt update && apt install -y nginx certbot python3-certbot-nginx git
```

Install Node.js 20 or newer (via NodeSource or nvm), then pm2:

```bash
npm install -g pm2
```

## 2. Get the code

```bash
git clone https://github.com/mrbzk/veyra-studios.git /var/www/veyra-agent
```

```bash
cd /var/www/veyra-agent && npm install
```

## 3. Environment variables

```bash
cp env.example .env && nano .env
```

Fill in every value. `env.example` says where each one comes from. The Slack and Stripe secrets only exist after steps 6 and 7, so come back for those.

## 4. Start the app

```bash
pm2 start server.js --name veyra-agent
```

```bash
pm2 save && pm2 startup
```

Run the command `pm2 startup` prints, so the app starts again after a reboot. Check it:

```bash
curl -s localhost:3000/health
```

## 5. nginx and HTTPS

Create `/etc/nginx/sites-available/veyra-agent`:

```nginx
server {
    listen 80;
    server_name srv.veyrastudios.agency;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable it and get a certificate. Use the **nginx** plugin, not `--manual`: manual certificates can't renew on their own, which is what made the old certificate expire.

```bash
ln -s /etc/nginx/sites-available/veyra-agent /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx
```

```bash
certbot --nginx -d srv.veyrastudios.agency
```

```bash
certbot renew --dry-run
```

Check the public address works. It should print `401`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://srv.veyrastudios.agency/stripe-webhook
```

## 6. Slack app

At [api.slack.com/apps](https://api.slack.com/apps), create or open **Veyra Agent**:

1. **OAuth & Permissions:** add the bot scopes listed in the README's "Slack app setup", then **Install to Workspace**. Copy the **Bot User OAuth Token** → `SLACK_BOT_TOKEN`.
2. **Basic Information → App Credentials → Signing Secret** → `SLACK_SIGNING_SECRET`.
3. **Event Subscriptions:** on, Request URL `https://srv.veyrastudios.agency/slack-events`, bot event `message.channels`.
4. **Interactivity & Shortcuts:** on, Request URL `https://srv.veyrastudios.agency/slack-interactive`.
5. **Slash Commands:** create `/booked`, Request URL `https://srv.veyrastudios.agency/slack-commands`, usage hint `[time] or undo`.
6. **Reinstall** the app after the changes.
7. In Slack: create `#production` and run `/invite @Veyra Agent` there. Copy your member ID (profile → `···` → Copy member ID) → `SLACK_ADMIN_USER_ID`.

## 7. Stripe

1. **Developers → Webhooks → Add endpoint:** `https://srv.veyrastudios.agency/stripe-webhook`, events `checkout.session.completed` and `customer.created`. Copy the signing secret → `STRIPE_WEBHOOK_SECRET`.
2. On the **Paid Trial EN** Payment Link, add metadata `plan` = `trial` and `language` = `EN`. On **Paid Trial NL**: `plan` = `trial`, `language` = `NL`.

## 8. Notion

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) → new integration **Veyra Agent** → copy the token → `NOTION_API_KEY`.
2. Connect it to the **Client DB** and the **Project Tracker** (database `···` → Connections).
3. Check every property in the README's "Notion setup" tables exists with the exact name and type. **Language** must be a Select, not Text.
4. Add the two Project Tracker automations from the README, pointing at `/notion-storyboard` and `/notion-video-review`.

## 9. Restart and test

```bash
pm2 restart veyra-agent --update-env
```

Then run the manual test lane from the README: a Stripe customer with `test` in the description. Follow it with `pm2 logs veyra-agent`. A good run ends with `[ONBOARDING] Completed onboarding for: …`, and you should see a new Slack channel with the welcome message, both Notion rows and the #production alert. Then try `/booked` in that channel.
