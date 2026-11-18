'use strict';

// Final delivery and the Growth mid-cycle review call. Plain code, no AI.
//
// Delivery: the team puts the final files in one folder, pastes it in
// "Delivery Drive Link" on the Project Tracker row and sets Status →
// "Ready to Deliver". A Notion automation calls /notion-delivery, and this
// sends the delivery message to the client, marks the cycle Delivered and
// tells #production.
//
// Growth mid-cycle: Growth has a report and review call every two weeks.
// The scheduler sends the booking link to the client on day 14 of each
// Growth cycle that is not yet delivered.

const notion = require('../utils/notion');
const slack = require('../utils/slack');
const { packageForTotalVideos, languageCode } = require('../utils/plans');

const INTERNAL_CHANNEL = () => process.env.INTERNAL_SLACK_CHANNEL || 'production';
const REVIEW_CALL_URL = () =>
  process.env.REVIEW_CALL_BOOKING_URL || process.env.KICKOFF_BOOKING_URL || 'https://veyrastudios.eu/onboarding';

const today = () => new Date().toISOString().split('T')[0];
const plainText = prop => prop?.rich_text?.[0]?.plain_text || prop?.title?.[0]?.plain_text || '';

async function alert(text) {
  await slack.postMessage(INTERNAL_CHANNEL(), text).catch(err =>
    console.error('[DELIVERY] Failed to post to #production:', err.message)
  );
}

// ─── Messages ────────────────────────────────────────────────────────────────

const TRIAL_DELIVERY = {
  en: (first, link) => `Hi ${first},\n\nAll 4 videos are approved and ready to download.\n\nYour final files are in the folder below: your core video and 3 hook variations, ready to use.\n\n${link}\n\nDownload directly from the link above.`,
  nl: (first, link) => `Hoi ${first},\n\nAlle 4 video's zijn goedgekeurd en klaar om te downloaden.\n\nJe eindbestanden vind je in de map hieronder: je kernvideo en 3 hook-varianten, klaar voor gebruik.\n\n${link}\n\nDownload rechtstreeks via de link hierboven.`,
  fr: (first, link) => `Bonjour ${first},\n\nLes 4 vidéos sont validées et prêtes à être téléchargées.\n\nVos fichiers finaux se trouvent dans le dossier ci-dessous : votre vidéo principale et 3 variantes d'accroche, prêtes à l'emploi.\n\n${link}\n\nTéléchargez-les directement via le lien ci-dessus.`,
};

const TRIAL_FOLLOW_UP = {
  en: 'We hope the videos perform well for you. Would love to hear how they land with your audience.\n\nWhen you are ready to scale up, we are here.',
  nl: "We hopen dat de video's goed voor je presteren. Laat gerust weten hoe ze aanslaan bij je publiek.\n\nWil je opschalen, dan staan we voor je klaar.",
  fr: "Nous espérons que ces vidéos vous apporteront de bons résultats. N'hésitez pas à nous dire comment votre audience les reçoit.\n\nQuand vous souhaiterez passer à la vitesse supérieure, nous sommes là.",
};

function packageDelivery(language, first, link, pkg, withCall) {
  const scope = pkg.delivered[language] || pkg.delivered.en;
  const url = REVIEW_CALL_URL();
  const call = {
    en: `\n\nNext is your ${pkg.callCadence.en} report and review call, where we go through performance and plan the next cycle. Book a time here:\n\n${url}`,
    nl: `\n\nVolgende stap is je ${pkg.callCadence.nl} rapport- en evaluatiegesprek, waarin we de resultaten bespreken en de volgende cyclus plannen. Plan hier een moment in:\n\n${url}`,
    fr: `\n\nProchaine étape : votre rapport et appel de suivi (${pkg.callCadence.fr}), pour faire le point sur les résultats et planifier le prochain cycle. Réservez un créneau ici :\n\n${url}`,
  };
  const body = {
    en: `Hi ${first},\n\nThis cycle is complete and your final files are ready to download.\n\nIn the folder: ${scope}.\n\n${link}`,
    nl: `Hoi ${first},\n\nDeze cyclus is afgerond en je eindbestanden staan klaar om te downloaden.\n\nIn de map: ${scope}.\n\n${link}`,
    fr: `Bonjour ${first},\n\nCe cycle est terminé et vos fichiers finaux sont prêts à être téléchargés.\n\nDans le dossier : ${scope}.\n\n${link}`,
  };
  const lang = body[language] ? language : 'en';
  return body[lang] + (withCall ? call[lang] : '');
}

const GENERIC_DELIVERY = {
  en: (first, link) => `Hi ${first},\n\nYour final files are approved and ready to download.\n\n${link}`,
  nl: (first, link) => `Hoi ${first},\n\nJe eindbestanden zijn goedgekeurd en klaar om te downloaden.\n\n${link}`,
  fr: (first, link) => `Bonjour ${first},\n\nVos fichiers finaux sont validés et prêts à être téléchargés.\n\n${link}`,
};

const GROWTH_MID_CYCLE = {
  en: (first, url) => `Hi ${first},\n\nWe are halfway through this cycle, so it is time for your two-weekly report and review call. Book a time here:\n\n${url}`,
  nl: (first, url) => `Hoi ${first},\n\nWe zitten halverwege deze cyclus, dus het is tijd voor je tweewekelijkse rapport- en evaluatiegesprek. Plan hier een moment in:\n\n${url}`,
  fr: (first, url) => `Bonjour ${first},\n\nNous sommes à mi-parcours de ce cycle : c'est le moment de votre rapport et appel de suivi, prévus toutes les deux semaines. Réservez un créneau ici :\n\n${url}`,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadClient(cyclePage) {
  const clientId = cyclePage.properties?.['Client Name']?.relation?.[0]?.id;
  if (!clientId) return null;
  const client = await notion.getPage(clientId);
  const name = plainText(client.properties?.['Your Name']) || 'there';
  return {
    page: client,
    name,
    firstName: name.split(' ')[0],
    slackChannel: plainText(client.properties?.['Slack Channel']).replace(/^#/, ''),
    language: languageCode(client.properties?.['Language']?.select?.name),
    clientType: client.properties?.['Client Type']?.select?.name || '',
  };
}

// ─── Delivery ────────────────────────────────────────────────────────────────

async function handleDelivery(cyclePage) {
  const props = cyclePage.properties || {};
  const cycleName = plainText(props['Name']) || cyclePage.id;
  const link = props['Delivery Drive Link']?.url || '';
  const totalVideos = props['Total Videos']?.number;

  console.log(`[DELIVERY] Ready to Deliver: ${cycleName}`);

  try {
    if (props['Slack Notified']?.checkbox && props['Status']?.select?.name === 'Delivered') {
      console.log(`[DELIVERY] ${cycleName} already delivered, skipping`);
      return;
    }
    if (!link) {
      await alert(`⚠️ ${cycleName} is set to Ready to Deliver, but Delivery Drive Link is empty. Nothing was sent to the client. Add the link and set Ready to Deliver again.\n👉 Notion: ${cyclePage.url}`);
      return;
    }

    const client = await loadClient(cyclePage);
    if (!client || !client.slackChannel) {
      await alert(`⚠️ ${cycleName}: no client or no Slack Channel found on the Client DB row. Delivery not sent. Please send it manually.\n👉 Notion: ${cyclePage.url}`);
      return;
    }

    const isTrial = totalVideos === 4;
    const pkg = packageForTotalVideos(totalVideos);
    const lang = client.language;
    let text;
    if (isTrial) text = (TRIAL_DELIVERY[lang] || TRIAL_DELIVERY.en)(client.firstName, link);
    else if (pkg) text = packageDelivery(lang, client.firstName, link, pkg, client.clientType !== 'One-off');
    else text = (GENERIC_DELIVERY[lang] || GENERIC_DELIVERY.en)(client.firstName, link);

    const posted = await slack.postMessage(client.slackChannel, text);
    if (!posted.ok) {
      await alert(`🚨 Delivery message for ${cycleName} could not be posted in #${client.slackChannel} (${posted.error}). Notion not updated. Please send it manually:\n\n${text}`);
      return;
    }

    await notion.updatePage(cyclePage.id, {
      'Status': { select: { name: 'Delivered' } },
      'Delivered Date': { date: { start: today() } },
      'Slack Notified': { checkbox: true },
    });

    if (isTrial) {
      await slack.postMessage(client.slackChannel, TRIAL_FOLLOW_UP[lang] || TRIAL_FOLLOW_UP.en);
      await alert(`📊 Trial cycle delivered: ${client.name}\n\nFlag for conversion follow-up in GHL. To upgrade, add a Launch, Core or Growth subscription to their Stripe customer (same email as in Notion).\n👉 Notion: ${cyclePage.url}`);
    } else {
      const plan = pkg ? `${pkg.label}, ` : '';
      const hooksApproved = props['Hooks Approved']?.checkbox ? '' : '\n⚠️ Hooks Approved was not ticked, so the client may not have approved the final review in Slack.';
      await alert(`📦 Cycle delivered: ${client.name} (${plan}${cycleName})${hooksApproved}\n👉 Notion: ${cyclePage.url}`);
    }
    console.log(`[DELIVERY] Delivered ${cycleName} to #${client.slackChannel} (${lang})`);
  } catch (err) {
    console.error(`[DELIVERY] ${cycleName} failed: ${err.message}`);
    await alert(`🚨 Delivery failed for ${cycleName}\nError: ${err.message}\nPlease check Slack and Notion and finish the delivery manually.\n👉 Notion: ${cyclePage.url}`);
  }
}

// ─── Growth mid-cycle review call (run by the 6-hourly scheduler) ────────────

const sentMidCycle = new Set();

async function checkGrowthMidCycle() {
  const growth = packageForTotalVideos(24);
  const filter = {
    and: [
      { property: 'Total Videos', number: { equals: growth.totalVideos } },
      { property: 'Start Date', date: { is_not_empty: true } },
      { property: 'Status', select: { does_not_equal: 'Delivered' } },
    ],
  };
  let cursor;
  do {
    const result = await notion.queryDatabase(process.env.NOTION_PROJECT_TRACKER_ID, filter, cursor);
    for (const row of result.results) {
      const days = (Date.now() - new Date(row.properties['Start Date'].date.start)) / 86400000;
      if (days < 14 || days >= 15 || sentMidCycle.has(row.id)) continue;
      const client = await loadClient(row);
      if (!client?.slackChannel) continue;
      const text = (GROWTH_MID_CYCLE[client.language] || GROWTH_MID_CYCLE.en)(client.firstName, REVIEW_CALL_URL());
      const posted = await slack.postMessage(client.slackChannel, text);
      if (posted.ok) {
        sentMidCycle.add(row.id);
        await alert(`📅 Growth mid-cycle call: ${client.name} was sent the booking link for their two-weekly report and review call.\n👉 Notion: ${row.url}`);
        console.log(`[SCHEDULER] Growth mid-cycle call link sent to #${client.slackChannel}`);
      }
    }
    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);
}

module.exports = { handleDelivery, checkGrowthMidCycle };
