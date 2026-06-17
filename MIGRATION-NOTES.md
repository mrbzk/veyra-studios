# Migration Notes — Railway → React Hosting
# Veyra Studios Agent Infrastructure
# ================================================


## The core question

React hosting platforms (Vercel, Netlify, Cloudflare Pages)
are designed for frontend apps — static files and serverless
functions. Your agents are backend webhook receivers that
need to run 24/7.

The good news: the architecture migrates cleanly. The agents
themselves do not change. Only the hosting layer changes.


## What actually needs to move

Your agents are an Express.js server with five endpoints.
That server needs to:
- Receive POST requests from Stripe and Frame.io
- Verify webhook signatures
- Call the Claude API
- Call MCP tools (Notion, Slack, Frame.io)
- Run a scheduler every 6 hours

The first four work perfectly as serverless functions.
The scheduler (follow-up cron job) does not — it needs
persistent execution, which serverless platforms do not
provide natively.


## Option A — Vercel (recommended for React teams)

Vercel runs Next.js API routes as serverless functions.
Each webhook endpoint becomes an API route.

WHAT CHANGES:
  server.js → deleted
  agents/onboarding.js → /api/stripe-webhook.js
  agents/onboarding.js → /api/notion-webhook.js
  agents/production.js → /api/frameio-webhook.js
  agents/production.js → /api/frameio-approved.js
  agents/production.js → /api/notion-storyboard.js

SCHEDULER SOLUTION:
  Vercel does not support cron natively on the free plan.
  Two options:
  1. Vercel Pro → add a cron job in vercel.json:
     {
       "crons": [{
         "path": "/api/onboarding-check",
         "schedule": "0 */6 * * *"
       }]
     }
  2. Use a free external cron service (cron-job.org) that
     hits your Vercel endpoint every 6 hours via HTTP GET.
     No Vercel plan upgrade needed.

ENVIRONMENT VARIABLES:
  Same variables, added via Vercel dashboard →
  Settings → Environment Variables.

COLD STARTS:
  Serverless functions sleep between requests. First
  request after idle may take 1-3 seconds longer.
  For webhook receivers this is fine — Stripe and
  Frame.io retry failed webhooks automatically.

EXECUTION TIMEOUT:
  Vercel free plan: 10 second function timeout.
  Your agents may take 5-8 seconds for a full run.
  If hitting limits, upgrade to Pro (60 second timeout)
  or move the Claude API call to a background job.


## Option B — Cloudflare Workers (fastest cold starts)

Cloudflare Workers run at the edge globally with
near-zero cold starts. Works well for webhook receivers.

WHAT CHANGES:
  Express → Cloudflare Worker fetch handler
  Each endpoint becomes a route in one Worker file
  or separate Workers per endpoint.

SCHEDULER SOLUTION:
  Cloudflare has native cron triggers:
  [triggers]
  crons = ["0 */6 * * *"]
  Free plan includes up to 5 cron triggers.

LIMITS:
  CPU time: 10ms on free plan (not enough for Claude API)
  Must use Cloudflare Workers Paid ($5/month) for longer
  execution. Still cheaper than Railway for most setups.

ENVIRONMENT VARIABLES:
  Added via wrangler.toml or Cloudflare dashboard.


## Option C — Keep Railway + add React frontend separately

This is the cleanest long-term architecture and the one
we recommend if you want a React dashboard for Veyra Studios.

  Railway → backend agents (webhook server, stays as is)
  Vercel/Netlify → React frontend dashboard

The React frontend can display:
  - Active client pipeline (read from Notion API)
  - Pending approvals
  - Delivery status per cycle
  - Real-time agent activity log

The agents never move. The frontend is a separate repo
that reads from the same Notion databases the agents write to.

This gives you:
  - Clean separation of concerns
  - No migration risk to the agents
  - A proper dashboard for your team
  - Both layers independently deployable


## Recommendation for Veyra Studios

Short term (now):
  Deploy to Railway. It works, it is cheap ($5/month),
  and it handles everything including the scheduler.
  No migration needed until you are ready.

Medium term (when you want a dashboard):
  Keep Railway for agents.
  Build a Next.js dashboard on Vercel.
  Connect it to Notion via the Notion API.
  No agents move, no risk.

Long term (if you want everything on one platform):
  Migrate agents to Vercel API routes + Vercel Pro cron.
  This consolidates billing and deployment to one platform.
  Migration time: approximately half a day.


## Migration steps when you are ready (Railway → Vercel)

1. Create a new Next.js app: npx create-next-app veyra-dashboard
2. Copy agents/ and prompts/ directories across unchanged
3. Create /pages/api/ routes for each endpoint:
   - stripe-webhook.js
   - notion-webhook.js
   - frameio-webhook.js
   - frameio-approved.js
   - notion-storyboard.js
   - onboarding-check.js (cron target)
4. Replace Express req/res with Next.js req/res
   (the agent logic inside does not change)
5. Add vercel.json with cron config
6. Move environment variables to Vercel dashboard
7. Update Stripe webhook URL to new Vercel URL
8. Update Frame.io webhook URL to new Vercel URL
9. Deploy and test
10. Shut down Railway once confirmed working

The agent logic (agents/, prompts/) never changes.
Only the HTTP layer around it changes.
