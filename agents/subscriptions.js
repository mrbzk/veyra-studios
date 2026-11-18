'use strict';

// Monthly packages (Launch / Core / Growth), driven by Stripe invoice.paid.
// Plain code, no AI: these steps have to be predictable.
//
// billing_reason = subscription_create  (first payment of a new subscription)
//   - Client already in the Client DB (matched by email), e.g. a trial client
//     you added a subscription to in the Stripe dashboard → UPGRADE:
//     Client DB → Recurring + new plan, next cycle row in the Project Tracker,
//     confirmation in their Slack channel, alert in #production. No call.
//   - Not in the Client DB (bought through a package Payment Link) → full
//     onboarding by the onboarding agent, including kickoff call reminders.
//
// billing_reason = subscription_cycle   (monthly renewal paid)
//   → next cycle row in the Project Tracker + alert in #production.

const Stripe = require('stripe');
const notion = require('../utils/notion');
const slack = require('../utils/slack');
const { packageFor, languageCode } = require('../utils/plans');
const onboardingAgent = require('./onboarding');

const INTERNAL_CHANNEL = () => process.env.INTERNAL_SLACK_CHANNEL || 'production';

let _stripe;
function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set, so the package on this invoice cannot be looked up');
  }
  if (!_stripe) _stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// Stripe retries a webhook if it gets no 200; we answer 200 straight away,
// but keep this as a guard against the same invoice being processed twice.
const processedInvoices = new Set();

const today = () => new Date().toISOString().split('T')[0];

async function alert(text) {
  await slack.postMessage(INTERNAL_CHANNEL(), text).catch(err =>
    console.error('[SUBSCRIPTION] Failed to post to #production:', err.message)
  );
}

// ─── Stripe lookups ──────────────────────────────────────────────────────────

// Product IDs on the invoice lines. Handles both webhook payload shapes
// (older API versions: line.price.product; newer: line.pricing.price_details.product).
function productIdsFromInvoice(invoice) {
  const ids = [];
  for (const line of invoice.lines?.data || []) {
    const p = line.price?.product || line.pricing?.price_details?.product || line.plan?.product;
    const id = typeof p === 'string' ? p : p?.id;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// First product on the invoice whose metadata.plan is a known package.
async function findPackage(invoice) {
  for (const productId of productIdsFromInvoice(invoice)) {
    const product = await stripe().products.retrieve(productId);
    const pkg = packageFor(product.metadata?.plan);
    if (pkg) {
      return { pkg, productLanguage: product.metadata?.language || '', productName: product.name };
    }
  }
  return null;
}

async function customerDetails(invoice) {
  let name = invoice.customer_name || '';
  let email = invoice.customer_email || '';
  let created = invoice.created;
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if ((!name || !email) && customerId) {
    const customer = await stripe().customers.retrieve(customerId);
    name = name || customer.name || '';
    email = email || customer.email || '';
  }
  return { id: customerId, name, email, created };
}

// ─── Notion lookups ──────────────────────────────────────────────────────────

const titleOf = page => page.properties?.['Your Name']?.title?.[0]?.plain_text || '';

async function findClientByEmail(email) {
  if (!email) return null;
  const candidates = [...new Set([email, email.toLowerCase()])];
  for (const value of candidates) {
    const result = await notion.queryDatabase(process.env.NOTION_CLIENT_DB_ID, {
      property: 'Email',
      email: { equals: value },
    });
    if (result.results.length > 1) {
      console.warn(`[SUBSCRIPTION] ${result.results.length} Client DB rows have email ${value}, using the first`);
    }
    if (result.results.length) return result.results[0];
  }
  return null;
}

async function highestCycleNumber(clientPageId) {
  let max = 0;
  let cursor;
  do {
    const result = await notion.queryDatabase(
      process.env.NOTION_PROJECT_TRACKER_ID,
      { property: 'Client Name', relation: { contains: clientPageId } },
      cursor
    );
    for (const row of result.results) {
      const n = row.properties?.['Cycle Number']?.number;
      if (typeof n === 'number' && n > max) max = n;
    }
    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);
  return max;
}

async function createNextCycle(clientPage, pkg) {
  const clientName = titleOf(clientPage) || 'Client';
  const cycleNumber = (await highestCycleNumber(clientPage.id)) + 1;
  const page = await notion.createPage(process.env.NOTION_PROJECT_TRACKER_ID, {
    'Name': { title: [{ text: { content: `${clientName} — Cycle ${cycleNumber}` } }] },
    'Client Name': { relation: [{ id: clientPage.id }] },
    'Cycle Number': { number: cycleNumber },
    'Status': { select: { name: 'Briefing' } },
    'Is First Cycle': { checkbox: cycleNumber === 1 },
    'Review Stage': { select: { name: 'Main Video' } },
    'Start Date': { date: { start: today() } },
    'Main Video Status': { select: { name: 'Not Started' } },
    'Hooks Status': { select: { name: 'Not Started' } },
    'Total Videos': { number: pkg.totalVideos },
  });
  console.log(`[SUBSCRIPTION] Project Tracker row created: ${clientName} — Cycle ${cycleNumber} (${pkg.label}, ${pkg.totalVideos} videos)`);
  return { page, cycleNumber };
}

// ─── Client message on upgrade ───────────────────────────────────────────────

function upgradeMessage(language, firstName, pkg) {
  const d = pkg.deliverables[language] || pkg.deliverables.en;
  const messages = {
    en: `Hi ${firstName},\n\nYour ${pkg.label} package is confirmed. Thank you for continuing with us.\n\nEach month we will produce ${d}. Your first monthly cycle is set up and we are starting on it now.\n\nAs before, all reviews and final files will be shared in this channel.`,
    nl: `Hoi ${firstName},\n\nJe ${pkg.label}-pakket is bevestigd. Bedankt dat je met ons verdergaat.\n\nElke maand maken we ${d}. Je eerste maandcyclus staat klaar en we gaan er nu mee aan de slag.\n\nZoals voorheen delen we alle reviews en eindbestanden in dit kanaal.`,
    fr: `Bonjour ${firstName},\n\nVotre forfait ${pkg.label} est confirmé. Merci de poursuivre avec nous.\n\nChaque mois, nous produirons ${d}. Votre premier cycle mensuel est prêt et nous commençons dès maintenant.\n\nComme auparavant, toutes les révisions et tous les fichiers finaux seront partagés dans ce canal.`,
  };
  return messages[language] || messages.en;
}

// ─── Flows ───────────────────────────────────────────────────────────────────

async function handleUpgrade(clientPage, pkg) {
  const clientName = titleOf(clientPage) || 'Client';
  const firstName = clientName.split(' ')[0];
  const previousPlan = clientPage.properties?.['Plan Purchased']?.select?.name || 'unknown';
  const wasTrial = clientPage.properties?.['Client Type']?.select?.name === 'Trial' || previousPlan === 'Paid Trial';
  const slackChannel = clientPage.properties?.['Slack Channel']?.rich_text?.[0]?.plain_text || '';
  const language = languageCode(clientPage.properties?.['Language']?.select?.name);

  console.log(`[SUBSCRIPTION] Upgrade: ${clientName} ${previousPlan} → ${pkg.label}`);

  await notion.updatePage(clientPage.id, {
    'Plan Purchased': { select: { name: pkg.label } },
    'Client Type': { select: { name: 'Recurring' } },
    'Status': { select: { name: 'Active' } },
  });

  const { page: cyclePage, cycleNumber } = await createNextCycle(clientPage, pkg);

  let clientMessageNote = 'Upgrade message sent to the client.';
  if (slackChannel) {
    const result = await slack.postMessage(slackChannel.replace(/^#/, ''), upgradeMessage(language, firstName, pkg));
    if (!result.ok) clientMessageNote = `⚠️ Could not post the upgrade message in ${slackChannel} (${result.error}). Please send it manually.`;
  } else {
    clientMessageNote = '⚠️ No Slack Channel on the Client DB row, so no upgrade message was sent. Please message the client manually.';
  }

  await alert(
    `${wasTrial ? '🚀 Trial converted' : '➕ Package added'}: ${clientName}\n` +
    `Plan: ${previousPlan} → ${pkg.label} (${pkg.totalVideos} videos per month)\n` +
    `Slack: ${slackChannel || 'not set'}\n` +
    `${clientMessageNote}\n\n` +
    `Cycle ${cycleNumber} created, status Briefing.\n` +
    `👉 Notion: ${cyclePage.url}`
  );
}

async function handleRenewal(clientPage, pkg) {
  const clientName = titleOf(clientPage) || 'Client';
  console.log(`[SUBSCRIPTION] Renewal: ${clientName} (${pkg.label})`);
  const { page: cyclePage, cycleNumber } = await createNextCycle(clientPage, pkg);
  await alert(
    `🔁 New monthly cycle: ${clientName}\n` +
    `Plan: ${pkg.label} (${pkg.totalVideos} videos)\n` +
    `Renewal paid. Cycle ${cycleNumber} created, status Briefing.\n` +
    `👉 Notion: ${cyclePage.url}`
  );
}

async function handleInvoicePaid(invoice) {
  const reason = invoice.billing_reason;
  if (reason !== 'subscription_create' && reason !== 'subscription_cycle') {
    console.log(`[SUBSCRIPTION] invoice.paid ${invoice.id} ignored (billing_reason: ${reason || 'none'})`);
    return;
  }
  if (processedInvoices.has(invoice.id)) {
    console.log(`[SUBSCRIPTION] invoice ${invoice.id} already processed, skipping`);
    return;
  }
  processedInvoices.add(invoice.id);

  let customer = { name: invoice.customer_name, email: invoice.customer_email };
  try {
    const found = await findPackage(invoice);
    if (!found) {
      console.log(`[SUBSCRIPTION] invoice.paid ${invoice.id} has no Launch/Core/Growth product, ignoring`);
      return;
    }
    const { pkg, productLanguage } = found;
    customer = await customerDetails(invoice);
    console.log(`[SUBSCRIPTION] invoice.paid (${reason}): ${customer.name || customer.email} — ${pkg.label}`);

    if (!customer.email) {
      await alert(`⚠️ ${pkg.label} payment received but the Stripe customer has no email, so it cannot be matched to a client. Invoice ${invoice.id}. Please handle manually.`);
      return;
    }

    const clientPage = await findClientByEmail(customer.email);

    if (reason === 'subscription_cycle') {
      if (!clientPage) {
        await alert(`⚠️ ${pkg.label} renewal paid by ${customer.name || ''} <${customer.email}>, but no Client DB row has that email. Next cycle not created. Please check manually.`);
        return;
      }
      await handleRenewal(clientPage, pkg);
      return;
    }

    // subscription_create
    if (clientPage) {
      await handleUpgrade(clientPage, pkg);
    } else {
      const language = languageCode(productLanguage);
      console.log(`[SUBSCRIPTION] New package client, starting onboarding: ${customer.name || customer.email} (${pkg.label}, ${language})`);
      await onboardingAgent.handleNewCustomer(customer, pkg.label, language);
    }
  } catch (err) {
    processedInvoices.delete(invoice.id);
    console.error(`[SUBSCRIPTION] invoice.paid ${invoice.id} failed: ${err.message}`);
    await alert(
      `🚨 Subscription automation failed for: ${customer.name || customer.email || invoice.customer}\n` +
      `Invoice: ${invoice.id} (${reason})\nError: ${err.message}\nPlease update Notion and Slack manually.`
    );
  }
}

module.exports = { handleInvoicePaid };
