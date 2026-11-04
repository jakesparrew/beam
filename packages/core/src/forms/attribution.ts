/**
 * Lead attribution (forms spec rules A1, A2, A6): the `source`, `campaign` and `medium` of a
 * submission, always a value of crm's `AcquisitionSource`, plus the small helpers that clean the
 * landing-URL values. Pure.
 */
import { ACQUISITION_SOURCES, type AcquisitionSource } from "../crm/types";
import type { FormLinkChannel, Utm } from "./types";

const PAID_MEDIA = ["cpc", "paid", "ppc", "paid_social"];
const META_SOURCES = ["facebook", "instagram", "meta", "fb", "ig"];
const GOOGLE_SOURCES = ["google", "adwords", "youtube"];
const SOCIAL_MEDIA = ["social", "organic_social"];
const ORGANIC_MEDIA = ["organic", "seo"];
const SEARCH_HOSTS = ["google.", "bing.", "duckduckgo.", "ecosia."];

/** A1: landing values are trimmed to 100 characters. */
export const ATTRIBUTION_MAX = 100;

/** A1: trims to 100 characters; blank becomes `undefined`. */
export function cleanValue(v: string | null | undefined, lower = false): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().slice(0, ATTRIBUTION_MAX);
  if (!t) return undefined;
  return lower ? t.toLowerCase() : t;
}

/** A1: the UTM values of a landing URL (`source` and `medium` lower-cased), link defaults filling only missing values. */
export function readUtm(params: URLSearchParams | Record<string, string | undefined>, defaults: Utm = {}): Utm {
  const get = (k: string): string | undefined => (params instanceof URLSearchParams ? (params.get(k) ?? undefined) : params[k]);
  const out: Utm = {};
  const pick = (key: keyof Utm, param: string, lower: boolean): void => {
    const v = cleanValue(get(param), lower) ?? cleanValue(defaults[key], lower);
    if (v !== undefined) out[key] = v;
  };
  pick("source", "utm_source", true);
  pick("medium", "utm_medium", true);
  pick("campaign", "utm_campaign", false);
  pick("term", "utm_term", false);
  pick("content", "utm_content", false);
  return out;
}

function isSource(v: string | undefined): v is AcquisitionSource {
  return v !== undefined && (ACQUISITION_SOURCES as readonly string[]).includes(v) && v !== "guest";
}

const fromChannel: Partial<Record<FormLinkChannel, AcquisitionSource>> = {
  qr: "qr_code",
  print: "qr_code",
  partner: "partner",
  referral: "referral",
  b2b: "b2b_campaign",
};

/** The host of a referrer URL (or a bare host), lower-cased, or `null`. */
export function hostOf(urlOrHost: string | null | undefined): string | null {
  if (!urlOrHost) return null;
  try {
    return new URL(urlOrHost.includes("://") ? urlOrHost : `https://${urlOrHost}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function isSearchHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^www\./, "");
  return SEARCH_HOSTS.some((p) => h.startsWith(p) || h.includes(`.${p}`));
}

/**
 * Rule A2, first match wins: (1) explicit `src`; (2) link channel; (3) paid medium by source;
 * (4) social medium; (5) `b2b` medium; (6) organic medium or a search-engine referrer;
 * (7) a landing page or a foreign embed host; (8) `website`. Email traffic keeps
 * `medium = 'email'` and falls through. `campaign` = `utm_campaign` or the link name.
 */
export function deriveSource(input: {
  src?: string;
  utm: Utm;
  linkChannel?: FormLinkChannel;
  linkName?: string;
  referrerHost?: string;
  landingPathKind?: "landing" | "other";
  embedHostIsBeam: boolean | null;
}): { source: AcquisitionSource; campaign: string | null; medium: string | null } {
  const medium = cleanValue(input.utm.medium, true) ?? null;
  const utmSource = cleanValue(input.utm.source, true);
  const campaign = cleanValue(input.utm.campaign) ?? cleanValue(input.linkName) ?? null;
  const done = (source: AcquisitionSource) => ({ source, campaign, medium });

  const src = cleanValue(input.src, true);
  if (isSource(src)) return done(src);
  const byLink = input.linkChannel ? fromChannel[input.linkChannel] : undefined;
  if (byLink) return done(byLink);
  if (medium && PAID_MEDIA.includes(medium)) {
    if (utmSource && META_SOURCES.includes(utmSource)) return done("paid_meta");
    if (utmSource && GOOGLE_SOURCES.includes(utmSource)) return done("paid_google");
    return done("paid_other");
  }
  if (medium && SOCIAL_MEDIA.includes(medium)) return done("social_media");
  if (medium === "b2b") return done("b2b_campaign");
  if ((medium && ORGANIC_MEDIA.includes(medium)) || isSearchHost(input.referrerHost)) return done("organic_search");
  if (input.landingPathKind === "landing" || input.embedHostIsBeam === false) return done("landing_page");
  return done("website");
}

/** Rule A6: the funnel of a submission. */
export function deriveFunnel(settingsFunnel: string | undefined, slug: string): string {
  return settingsFunnel ?? `form:${slug}`;
}

/** `referrer_url`: origin plus path, no query or fragment, max 500 characters; `null` when not a URL. */
export function cleanReferrer(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.origin}${u.pathname}`.slice(0, 500);
  } catch {
    return null;
  }
}

/** `landing_path`: a path without query or fragment, max 300 characters; `null` when empty. */
export function cleanLandingPath(path: string | null | undefined): string | null {
  if (!path) return null;
  let p = path.trim();
  try {
    if (p.includes("://")) p = new URL(p).pathname;
  } catch {
    return null;
  }
  p = p.split(/[?#]/)[0] ?? "";
  if (!p.startsWith("/")) p = `/${p}`;
  return p.slice(0, 300);
}
