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
