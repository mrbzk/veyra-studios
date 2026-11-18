'use strict';

// Monthly packages sold through Stripe. Each Stripe Product carries metadata
// plan = launch | core | growth and language = EN | NL | FR.
// "label" is the value written to "Plan Purchased" in the Client DB.
// "deliverables" is the per-month scope (upgrade and welcome messages),
// "delivered" what is in the final folder (delivery message), "callCadence"
// how often the report and review call happens.

const PACKAGES = {
  launch: {
    label: 'Launch',
    totalVideos: 8,
    delivered: {
      en: '8 videos (2 concepts with 4 hooks each) and 3 static ads',
      nl: "8 video's (2 concepten met elk 4 hooks) en 3 statische advertenties",
      fr: '8 vidéos (2 concepts avec 4 accroches chacun) et 3 visuels statiques',
    },
    callCadence: { en: 'monthly', nl: 'maandelijkse', fr: 'chaque mois' },
    deliverables: {
      en: '2 concepts with 4 hooks each, 8 videos in total, plus 3 static ads',
      nl: "2 concepten met elk 4 hooks, 8 video's in totaal, plus 3 statische advertenties",
      fr: '2 concepts avec 4 accroches chacun, soit 8 vidéos au total, plus 3 visuels statiques',
    },
  },
  core: {
    label: 'Core',
    totalVideos: 16,
    delivered: {
      en: '16 videos (4 concepts with 4 hooks each) and 5 static ads with copy variants',
      nl: "16 video's (4 concepten met elk 4 hooks) en 5 statische advertenties met tekstvarianten",
      fr: '16 vidéos (4 concepts avec 4 accroches chacun) et 5 visuels statiques avec variantes de texte',
    },
    callCadence: { en: 'monthly', nl: 'maandelijkse', fr: 'chaque mois' },
    deliverables: {
      en: '4 concepts with 4 hooks each, 16 videos in total, plus 5 static ads with copy variants',
      nl: "4 concepten met elk 4 hooks, 16 video's in totaal, plus 5 statische advertenties met tekstvarianten",
      fr: '4 concepts avec 4 accroches chacun, soit 16 vidéos au total, plus 5 visuels statiques avec variantes de texte',
    },
  },
  growth: {
    label: 'Growth',
    totalVideos: 24,
    delivered: {
      en: '24 videos (6 concepts with 4 hooks each), 10 static ads and your YouTube Shorts, including the Dutch and French versions',
      nl: "24 video's (6 concepten met elk 4 hooks), 10 statische advertenties en je YouTube Shorts, inclusief de Nederlandse en Franse versies",
      fr: '24 vidéos (6 concepts avec 4 accroches chacun), 10 visuels statiques et vos YouTube Shorts, versions néerlandaise et française incluses',
    },
    callCadence: { en: 'two-weekly', nl: 'tweewekelijkse', fr: 'toutes les deux semaines' },
    deliverables: {
      en: '6 concepts with 4 hooks each, 24 videos in total, plus 10 static ads and YouTube Shorts',
      nl: "6 concepten met elk 4 hooks, 24 video's in totaal, plus 10 statische advertenties en YouTube Shorts",
      fr: '6 concepts avec 4 accroches chacun, soit 24 vidéos au total, plus 10 visuels statiques et des YouTube Shorts',
    },
  },
};

// Language code ↔ the Client DB "Language" select option
const LANGUAGE_LABELS = { en: 'English', nl: 'Nederlands', fr: 'Français' };

function packageFor(planMeta) {
  return PACKAGES[(planMeta || '').toLowerCase().trim()] || null;
}

function packageForTotalVideos(n) {
  return Object.values(PACKAGES).find(p => p.totalVideos === n) || null;
}

function languageCode(value) {
  const v = (value || '').toLowerCase().trim();
  if (LANGUAGE_LABELS[v]) return v;
  const byLabel = Object.keys(LANGUAGE_LABELS).find(code => LANGUAGE_LABELS[code].toLowerCase() === v);
  return byLabel || 'en';
}

module.exports = { PACKAGES, LANGUAGE_LABELS, packageFor, packageForTotalVideos, languageCode };
