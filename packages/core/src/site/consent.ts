/**
 * Cookie consent (rules 36-39, privacy section 9). The `beam_consent` cookie holds only
 * `{k, v, a, m, t}`: consent key, banner version (the cookie notice's published ordinal),
 * analytics, marketing and epoch seconds, written as `k.v.a.m.t` so server and browser read it
 * without a decoder. It lives 182 days.
 */
export const CONSENT_COOKIE = "beam_consent";
export const CONSENT_MAX_AGE_DAYS = 182;
export const CONSENT_MAX_AGE_SECONDS = CONSENT_MAX_AGE_DAYS * 86_400; // 15724800
export const REFERRAL_COOKIE = "beam_ref";

export type CookieCategory = "necessary" | "analytics" | "marketing";
export type ConsentChoices = { analytics: boolean; marketing: boolean };
export type ConsentAction = "accept_all" | "reject_all" | "custom" | "withdraw";

export type ConsentCookie = {
  /** `cookie_consents.consent_key`. */
  k: string;
  /** Banner version: the published ordinal of the cookie notice the visitor answered. */
  v: number;
  a: boolean;
  m: boolean;
  /** Epoch seconds of the choice. */
  t: number;
};

/** Every cookie the site and portal set (the cookie notice lists exactly these). */
export const COOKIE_INVENTORY = [
  { name: "beam_consent", category: "necessary", provider: "BEAM", maxAgeDays: 182, purpose: "Stores your cookie choice", release: "V1" },
  { name: "NEXT_LOCALE", category: "necessary", provider: "BEAM", maxAgeDays: 365, purpose: "Remembers your language", release: "V1" },
  { name: "authjs.session-token", category: "necessary", provider: "BEAM", maxAgeDays: 30, purpose: "Keeps you signed in to your account (portal only)", release: "V1" },
  { name: "authjs.csrf-token", category: "necessary", provider: "BEAM", maxAgeDays: 0, purpose: "Protects the sign-in form (portal only, session cookie)", release: "V1" },
  { name: "authjs.callback-url", category: "necessary", provider: "BEAM", maxAgeDays: 0, purpose: "Returns you to the page you came from after sign-in (session cookie)", release: "V1" },
  { name: "_ga", category: "analytics", provider: "Google Analytics", maxAgeDays: 395, purpose: "Distinguishes visitors for statistics", release: "V1" },
  { name: "_ga_<id>", category: "analytics", provider: "Google Analytics", maxAgeDays: 395, purpose: "Keeps the state of a statistics session", release: "V1" },
  { name: "beam_ref", category: "marketing", provider: "BEAM", maxAgeDays: 30, purpose: "Remembers the referral code you arrived with", release: "R3" },
  { name: "_gcl_au", category: "marketing", provider: "Google Ads", maxAgeDays: 90, purpose: "Measures ad conversions", release: "R3" },
  { name: "_fbp", category: "marketing", provider: "Meta", maxAgeDays: 90, purpose: "Measures ad conversions", release: "R3" },
] as const satisfies readonly { name: string; category: CookieCategory; provider: string; maxAgeDays: number; purpose: string; release: string }[];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeConsentCookie(c: ConsentCookie): string {
  return [c.k.toLowerCase(), Math.trunc(c.v), c.a ? 1 : 0, c.m ? 1 : 0, Math.trunc(c.t)].join(".");
}

/** Parses a cookie value; anything malformed yields `null` (the banner shows again). */
export function decodeConsentCookie(value: string | null | undefined): ConsentCookie | null {
  if (!value) return null;
  const parts = decodeURIComponent(value).split(".");
  if (parts.length !== 5) return null;
  const [k, v, a, m, t] = parts as [string, string, string, string, string];
  if (!UUID_RE.test(k) || !/^\d{1,9}$/.test(v) || !/^[01]$/.test(a) || !/^[01]$/.test(m) || !/^\d{1,12}$/.test(t)) return null;
  return { k: k.toLowerCase(), v: Number(v), a: a === "1", m: m === "1", t: Number(t) };
}

/** The choices for a banner action (`custom` and `withdraw` use the dialog's switches). */
export function choicesFor(action: ConsentAction, custom: ConsentChoices = { analytics: false, marketing: false }): ConsentChoices {
  if (action === "accept_all") return { analytics: true, marketing: true };
  if (action === "reject_all" || action === "withdraw") return { analytics: false, marketing: false };
  return { analytics: custom.analytics, marketing: custom.marketing };
}

/**
 * True when the banner must show (rule 38): no valid cookie, a cookie older than 182 days, or a
 * cookie-notice version with `is_material_change` published after the version in the cookie.
 */
export function needsConsentPrompt(cookie: ConsentCookie | null, opts: { now: Date; latestMaterialOrdinal: number | null }): boolean {
  if (!cookie) return true;
  const ageSeconds = opts.now.getTime() / 1000 - cookie.t;
  if (ageSeconds > CONSENT_MAX_AGE_SECONDS || ageSeconds < -300) return true;
  return opts.latestMaterialOrdinal !== null && opts.latestMaterialOrdinal > cookie.v;
}

/** Whether a category may load given the cookie (necessary always may). */
export function consentAllows(cookie: ConsentCookie | null, category: CookieCategory): boolean {
  if (category === "necessary") return true;
  if (!cookie) return false;
  return category === "analytics" ? cookie.a : cookie.m;
}

/** Cookie names to delete on withdrawal (rule 38: every `_ga*` cookie of the site domain). */
export function cookiesToClearOnWithdraw(names: readonly string[], choices: ConsentChoices): string[] {
  return names.filter((n) => (!choices.analytics && /^_ga(_|$)/.test(n)) || (!choices.marketing && (n === "_gcl_au" || n === "_fbp" || n === REFERRAL_COOKIE)));
}

/** The cookie names of a category in the inventory (the settings dialog lists them per switch). */
export function cookieNamesOf(category: CookieCategory): string[] {
  return COOKIE_INVENTORY.filter((c) => c.category === category).map((c) => c.name);
}

// ---------------------------------------------------------------------------------------------
// Marketing tags (R3, section 6): Google Ads conversion and Meta Pixel after marketing consent
// ---------------------------------------------------------------------------------------------

const ADS_ID_RE = /^AW-[0-9]{6,12}$/;
const PIXEL_ID_RE = /^[0-9]{10,20}$/;

export type MarketingTagIds = { googleAdsId: string | null; metaPixelId: string | null };

/**
 * The marketing tag ids to load on a page: only in production and only for valid ids
 * (`settings.site.google_ads_conversion_id` `AW-...`, `meta_pixel_id` digits). Whether they load
 * at all is decided in the browser by marketing consent.
 */
export function marketingTagIds(input: { isProduction: boolean; googleAdsConversionId: string | null | undefined; metaPixelId: string | null | undefined }): MarketingTagIds {
  if (!input.isProduction) return { googleAdsId: null, metaPixelId: null };
  const ads = input.googleAdsConversionId?.trim() ?? "";
  const pixel = input.metaPixelId?.trim() ?? "";
  return { googleAdsId: ADS_ID_RE.test(ads) ? ads : null, metaPixelId: PIXEL_ID_RE.test(pixel) ? pixel : null };
}

// ---------------------------------------------------------------------------------------------
// Referral links (rule 63, R3)
// ---------------------------------------------------------------------------------------------

/** `beam_ref` lives 30 days (`Max-Age=2592000`). */
export const REFERRAL_MAX_AGE_DAYS = 30;
export const REFERRAL_MAX_AGE_SECONDS = REFERRAL_MAX_AGE_DAYS * 86_400; // 2592000
/** The query parameter of a referral link (`?ref=<CODE>`). */
export const REFERRAL_PARAM = "ref";
/** Eight characters from `A-HJ-NP-Z2-9` (no `I`, `O`, `0` or `1`). */
export const REFERRAL_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

/** The referral code in `value` (trimmed, upper-cased), or null when it is malformed. */
export function normaliseReferralCode(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(value);
  } catch {
    return null;
  }
  const code = raw.trim().toUpperCase();
  return REFERRAL_CODE_RE.test(code) ? code : null;
}

/** The `Set-Cookie` value of `beam_ref` (rule 63: 30 days, `Secure; SameSite=Lax; Path=/`). */
export function referralSetCookie(code: string): string {
  return `${REFERRAL_COOKIE}=${code}; Path=/; Max-Age=${REFERRAL_MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
}

/**
 * What a page view does with a `?ref=` code (rule 63): `set` stores it in `beam_ref` (marketing
 * consent and no valid code stored yet: the first code wins while the cookie lives), `links`
 * appends it to this page view's portal, checkout and form links (no marketing consent), `none`
 * when there is no valid code or the cookie already holds one.
 */
export function referralCaptureAction(input: { code: string | null | undefined; stored: string | null | undefined; marketing: boolean }): "set" | "links" | "none" {
  if (!normaliseReferralCode(input.code)) return "none";
  if (!input.marketing) return "links";
  return normaliseReferralCode(input.stored) ? "none" : "set";
}

/** Site paths whose request handlers create persons and read the code: portal (sign-in), checkout, gift checkout, hosted forms. */
const REFERRAL_TARGET_RE = /^\/(nl|fr|en)\/(account|checkout|gift|f)(\/|$)/i;

/** True when a site-relative or same-origin URL is a portal, checkout or form link. */
export function isReferralTarget(href: string, origin: string): boolean {
  try {
    const url = new URL(href, origin);
    return url.origin === new URL(origin).origin && REFERRAL_TARGET_RE.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * `href` with `ref=<code>` appended when it is a portal, checkout or form link of this origin
 * (rule 63, no marketing consent); any other link, or one that already carries a `ref`, is
 * returned unchanged. A site-relative link stays site-relative.
 */
export function withReferralCode(href: string, code: string, origin: string): string {
  const valid = normaliseReferralCode(code);
  if (!valid || !isReferralTarget(href, origin)) return href;
  const url = new URL(href, origin);
  if (url.searchParams.has(REFERRAL_PARAM)) return href;
  url.searchParams.set(REFERRAL_PARAM, valid);
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}
