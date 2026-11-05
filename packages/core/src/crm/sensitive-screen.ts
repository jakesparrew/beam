/**
 * The deterministic sensitive-content screen of AI reply drafts (crm rule 3.51, edge case 29),
 * crm-P10. Before a thread is sent to Claude, its customer messages are checked against
 * `SENSITIVE_KEYWORDS` of a locale: health conditions, mental health, pregnancy, medication and
 * similar special-category topics (GDPR art. 9). A match blocks the draft
 * (`ai_draft_status = blocked_sensitive`) and nothing is sent.
 *
 * Matching is case- and accent-insensitive and on whole words: a keyword never matches inside a
 * longer word ("cancer" does not match "cancerous"), unless it ends in `*`, which marks a prefix
 * ("zwanger*" matches "zwanger" and "zwangerschap"). Hyphens, apostrophes and runs of white space
 * count as one space, so "burn-out", "burn out" and "Burn‑Out" are the same keyword.
 *
 * Pure: no Node, Drizzle or framework imports.
 */
import type { Locale } from "../i18n";

export const SENSITIVE_KEYWORDS: Readonly<Record<Locale, readonly string[]>> = {
  "nl-BE": [
    "burn-out",
    "burnout",
    "overspannen",
    "depressie",
    "depressief",
    "angststoornis",
    "paniekaanval*",
    "zelfmoord*",
    "suicide*",
    "zelfdoding",
    "psycholoog",
    "psychiater",
    "eetstoornis",
    "anorexia",
    "boulimie",
    "verslaving",
    "zwanger*",
    "miskraam",
    "kanker",
    "chemo*",
    "tumor",
    "diabetes",
    "epilepsie",
    "hartaanval",
    "hartfalen",
    "hartritmestoornis*",
    "beroerte",
    "hernia",
    "operatie",
    "geopereerd",
    "diagnose",
    "medicatie",
    "medicijnen",
    "antidepressiva",
    "ziekenhuis",
    "chronisch ziek",
    "hiv",
    "aids",
    "handicap",
    "rouw",
    "overlijden",
  ],
  "fr-BE": [
    "burn-out",
    "burnout",
    "epuisement professionnel",
    "depression",
    "depressif",
    "depressive",
    "anxiete",
    "crise d angoisse",
    "attaque de panique",
    "suicide*",
    "psychologue",
    "psychiatre",
    "trouble alimentaire",
    "anorexie",
    "boulimie",
    "addiction",
    "enceinte",
    "grossesse",
    "fausse couche",
    "cancer",
    "chimio*",
    "tumeur",
    "diabete",
    "epilepsie",
    "crise cardiaque",
    "infarctus",
    "insuffisance cardiaque",
    "avc",
    "hernie",
    "opere",
    "operee",
    "diagnostic",
    "medicament*",
    "antidepresseur*",
    "hopital",
    "hospitalise*",
    "maladie chronique",
    "vih",
    "sida",
    "handicap",
    "deuil",
    "deces",
  ],
  en: [
    "burn-out",
    "burnout",
    "depression",
    "depressed",
    "anxiety",
    "panic attack*",
    "suicide*",
    "suicidal",
    "self-harm",
    "psychologist",
    "psychiatrist",
    "therapist",
    "eating disorder",
    "anorexia",
    "bulimia",
    "addiction",
    "pregnant",
    "pregnancy",
    "miscarriage",
    "cancer",
    "chemo*",
    "tumour",
    "tumor",
    "diabetes",
    "epilepsy",
    "heart attack",
    "heart failure",
    "stroke",
    "hernia",
    "surgery",
    "diagnosis",
    "diagnosed",
    "medication",
    "antidepressant*",
    "hospital*",
    "chronic illness",
    "hiv",
    "disability",
    "bereavement",
    "passed away",
  ],
};

export type SensitiveScreenResult = { blocked: boolean; matched: string[] };

/** Lower case, accents removed, hyphens, apostrophes and white space folded into one space. */
export function normaliseForScreen(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[\s\-‐-―'‘’`]+/gu, " ")
    .trim();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Matcher = { keyword: string; re: RegExp };

function compile(keyword: string): Matcher {
  const prefix = keyword.endsWith("*");
  const core = normaliseForScreen(prefix ? keyword.slice(0, -1) : keyword);
  const tail = prefix ? "" : "(?![\\p{L}\\p{N}])";
  return { keyword, re: new RegExp(`(?<![\\p{L}\\p{N}])${escape(core)}${tail}`, "u") };
}

const MATCHERS = new Map<Locale, Matcher[]>();
function matchers(locale: Locale): Matcher[] {
  let list = MATCHERS.get(locale);
  if (!list) {
    list = (SENSITIVE_KEYWORDS[locale] ?? []).map(compile);
    MATCHERS.set(locale, list);
  }
  return list;
}

/** Rule 3.51: the keywords of `locale` found in `text` (whole words); `blocked` when any matched. */
export function screenSensitive(text: string, locale: Locale): SensitiveScreenResult {
  const normalised = normaliseForScreen(text);
  const matched = normalised ? matchers(locale).filter((m) => m.re.test(normalised)).map((m) => m.keyword) : [];
  return { blocked: matched.length > 0, matched };
}

/** Screens `text` with the keywords of every given locale (customers write in any language). */
export function screenSensitiveAll(text: string, locales: readonly Locale[]): SensitiveScreenResult {
  const matched = new Set<string>();
  for (const locale of locales) for (const k of screenSensitive(text, locale).matched) matched.add(k);
  return { blocked: matched.size > 0, matched: [...matched] };
}
