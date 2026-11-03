/**
 * next-intl request configuration (platform spec section 8, DR-17). `next.config.ts` applies
 * `createNextIntlPlugin('./lib/i18n.ts')` because this file exists. The locale comes from the
 * URL segment for `(site)` and `(portal)` (proxy sets `x-beam-locale`) and from `users.locale`
 * in the back-office. Only the namespaces of the current route group are loaded: `platform` +
 * `site` for the site, `platform` + the portal modules for the portal, all for the admin.
 * A missing message renders `⟦key⟧` and is reported to Sentry once per key (PL-63).
 *
 * Server components may also use `translator(locale)`, a thin wrapper over `@beam/core/i18n`'s
 * `t()`, and hand strings to `@beam/ui` components as props (ui has no catalogue lookups).
 */
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import {
  DEFAULT_LOCALE,
  isLocale,
  lookupMessage,
  MESSAGES,
  localeFromAcceptLanguage,
  localeFromSegment,
  messagesFor,
  missingMarker,
  t,
  type Locale,
  type MessageParams,
} from "@beam/core/i18n";
import { reportMessage } from "./logger";

export type RouteGroup = "site" | "portal" | "admin";

/** The portal pages come from these modules (site owns the portal home, crm the profile, ...). */
export const PORTAL_MODULES = ["platform", "site", "crm", "booking", "commerce", "credits", "forms", "webinar"] as const;

export function routeGroupOf(pathname: string): RouteGroup {
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "admin";
  if (/^\/(nl|fr|en)\/account(\/|$)/.test(pathname)) return "portal";
  return "site";
}

export function modulesFor(group: RouteGroup): readonly string[] | undefined {
  if (group === "admin") return undefined;
  if (group === "portal") return PORTAL_MODULES;
  return ["platform", "site"];
}

const reported = new Set<string>();

function onMissing(key: string): void {
  if (reported.has(key)) return;
  reported.add(key);
  reportMessage(`missing translation: ${key}`, { tags: { i18n_key: key } });
}

/** The back-office locale: `users.locale` of the signed-in user. */
export async function adminLocale(): Promise<Locale> {
  try {
    const { getSession } = await import("./auth");
    return (await getSession())?.user.locale ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export default getRequestConfig(async ({ requestLocale }) => {
  const h = await headers();
  const pathname = (h.get("x-pathname") ?? "/").split("?")[0]!;
  const group = routeGroupOf(pathname);
  const fromHeader = h.get("x-beam-locale");
  const requested = await requestLocale;
  const locale: Locale =
    group === "admin" ? await adminLocale() : isLocale(fromHeader) ? fromHeader : isLocale(requested) ? requested : DEFAULT_LOCALE;
  return {
    locale,
    timeZone: "Europe/Brussels",
    messages: messagesFor(locale, modulesFor(group)) as Record<string, never>,
    onError: (error) => {
      const key = (error as { originalMessage?: string }).originalMessage ?? error.message;
      onMissing(key);
    },
    getMessageFallback: ({ namespace, key }) => missingMarker(namespace ? `${namespace}.${key}` : key),
  };
});

/** `t()` bound to a locale, returning `⟦key⟧` instead of throwing in production builds. */
export function translator(locale: Locale): (key: string, params?: MessageParams) => string {
  return (key, params) => {
    try {
      return t(locale, key, params);
    } catch (error) {
      if (process.env.NODE_ENV === "production") {
        onMissing(key);
        return missingMarker(key);
      }
      throw error;
    }
  };
}

/** `t()` that never throws, for keys of other modules' catalogues (nav labels): the key itself when missing. */
export function softTranslator(locale: Locale): (key: string, params?: MessageParams) => string {
  return (key, params) => (t.has(locale, key) ? t(locale, key, params) : key);
}

/** The locale of a site or portal request (proxy's `x-beam-locale`), else the default. */
export async function requestLocale(): Promise<Locale> {
  try {
    const value = (await headers()).get("x-beam-locale");
    return isLocale(value) ? value : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** Sign-in pages of the back-office: the user's locale when signed in, else `NEXT_LOCALE`, `Accept-Language`, `nl-BE`. */
export async function adminAuthLocale(): Promise<Locale> {
  const { getSession } = await import("./auth");
  const session = await getSession().catch(() => null);
  if (session) return session.user.locale;
  try {
    const c = (await cookies()).get("NEXT_LOCALE")?.value;
    const fromCookie = isLocale(c) ? c : localeFromSegment(c);
    return fromCookie ?? localeFromAcceptLanguage((await headers()).get("accept-language")) ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** Resolves a map of label names to catalogue keys; keys without a dot are taken under `prefix`. */
export function labelsFrom<K extends string>(tr: (key: string) => string, prefix: string, keys: Record<K, string>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const [name, key] of Object.entries(keys) as [K, string][]) out[name] = tr(key.includes(".") ? key : `${prefix}.${key}`);
  return out;
}

// ---------------------------------------------------------------------------
// Label sets of platform's sign-in and system screens (server side; client forms get strings)
// ---------------------------------------------------------------------------

type Tr = (key: string, params?: MessageParams) => string;

/** Strings with ICU parameters stay templates; the client fills them with `fill()`. */
export const messageTemplate = (locale: Locale, key: string): string => lookupMessage(MESSAGES, locale, key) ?? missingMarker(key);
const raw = messageTemplate;

export function passwordLabels(tr: Tr, locale: Locale) {
  return {
    label: tr("platform.password.new"),
    strength: raw(locale, "platform.password.strength"),
    scores: [0, 1, 2, 3, 4].map((i) => tr(`platform.password.score_${i}`)) as [string, string, string, string, string],
    hint: raw(locale, "platform.password.hint"),
    breached: tr("platform.password.breached"),
    invalidToken: tr("platform.reset.expired"),
    policy: {
      too_short: tr("platform.password.too_short"),
      too_long: tr("platform.password.too_long"),
      too_weak: tr("platform.password.too_weak"),
      same_as_email: tr("platform.password.same_as_email"),
    },
    generic: tr("platform.errors.validation"),
  };
}

export function loginLabels(tr: Tr, locale: Locale) {
  return {
    email: tr("platform.login.email"),
    password: tr("platform.login.password"),
    submit: tr("platform.login.submit"),
    submitting: tr("platform.login.submitting"),
    invalid: tr("platform.login.invalid_credentials"),
    locked: raw(locale, "platform.login.locked"),
    rateLimited: raw(locale, "platform.login.rate_limited"),
    generic: tr("platform.errors.internal", { requestId: "" }),
  };
}

export function totpLabels(tr: Tr, locale: Locale) {
  return {
    code: tr("platform.mfa.code_label"),
    submit: tr("platform.mfa.verify_submit"),
    submitting: tr("platform.mfa.submitting"),
    invalid: tr("platform.mfa.invalid_code"),
    locked: raw(locale, "platform.mfa.locked"),
    useRecovery: tr("platform.mfa.use_recovery"),
    useTotp: tr("platform.mfa.use_totp"),
    recovery: tr("platform.mfa.recovery_label"),
    recoverySubmit: tr("platform.mfa.recovery_submit"),
    generic: tr("platform.errors.internal", { requestId: "" }),
  };
}

export function mfaSetupLabels(tr: Tr, locale: Locale) {
  return {
    intro: tr("platform.mfa.setup_intro"),
    qrAlt: tr("platform.mfa.qr_alt"),
    manualKey: tr("platform.mfa.manual_key"),
    code: tr("platform.mfa.code_label"),
    confirm: tr("platform.mfa.confirm_submit"),
    invalid: tr("platform.mfa.invalid_code"),
    loading: tr("platform.mfa.loading"),
    codesTitle: tr("platform.mfa.recovery_codes_title"),
    codesIntro: tr("platform.mfa.recovery_codes_intro"),
    download: tr("platform.mfa.download_codes"),
    stored: tr("platform.mfa.stored_checkbox"),
    continue: tr("platform.mfa.continue"),
    fileHeading: raw(locale, "platform.mfa.codes_file_heading"),
    generic: tr("platform.errors.internal", { requestId: "" }),
  };
}

export function portalLoginLabels(tr: Tr, locale: Locale) {
  return {
    email: tr("platform.portal_login.email"),
    submit: tr("platform.portal_login.submit"),
    submitting: tr("platform.portal_login.submitting"),
    magicTab: tr("platform.portal_login.magic_tab"),
    passwordTab: tr("platform.portal_login.password_tab"),
    password: tr("platform.portal_login.password"),
    passwordSubmit: tr("platform.portal_login.password_submit"),
    invalidEmail: tr("platform.portal_login.invalid_email"),
    invalidCredentials: tr("platform.portal_login.invalid_credentials"),
    rateLimited: raw(locale, "platform.portal_login.rate_limited"),
    generic: tr("platform.errors.internal", { requestId: "" }),
  };
}

export function reportProblemLabels(tr: Tr, locale: Locale) {
  const sev = (s: string) => ({ label: tr(`platform.report.${s}_label`), example: tr(`platform.report.${s}_example`) });
  return {
    title: tr("platform.report.title"),
    description: tr("platform.report.description"),
    titleField: tr("platform.report.title_field"),
    descriptionField: tr("platform.report.description_field"),
    severityField: tr("platform.report.severity_field"),
    severities: { critical: sev("critical"), high: sev("high"), normal: sev("normal"), improvement: sev("improvement") },
    emergency: raw(locale, "platform.report.emergency"),
    titleLength: tr("platform.report.title_length"),
    submit: tr("platform.report.submit"),
    submitting: tr("platform.report.submitting"),
    cancel: tr("platform.report.cancel"),
    close: tr("platform.report.close"),
    success: raw(locale, "platform.report.success"),
  };
}

export function jobsTableLabels(tr: Tr) {
  const j = (k: string) => tr(`platform.jobs.${k}`);
  return {
    columns: { kind: j("col_kind"), status: j("col_status"), lane: j("col_lane"), attempts: j("col_attempts"), runAt: j("col_run_at"), lastError: j("col_last_error"), key: j("col_key"), actions: j("col_actions") },
    statuses: Object.fromEntries(["pending", "running", "succeeded", "failed", "dead"].map((s) => [s, j(`status_${s}`)])),
    lanes: { fast: j("lane_fast"), bulk: j("lane_bulk") },
    filterStatus: j("filter_status"),
    filterKind: j("filter_kind"),
    filterLane: j("filter_lane"),
    any: j("any"),
    retry: j("retry"),
    retried: j("retried"),
    discard: j("discard"),
    discardTitle: j("discard_title"),
    discardReason: j("discard_reason"),
    discardConfirm: j("discard_confirm"),
    discarded: j("discarded"),
    cancel: j("cancel"),
    emptyDead: j("empty_dead"),
    emptyFiltered: j("empty_filtered"),
    notDead: j("not_dead"),
    generic: tr("platform.errors.internal", { requestId: "" }),
    pagination: j("pagination"),
    previous: j("previous"),
    next: j("next"),
    applyFilters: j("apply_filters"),
    filters: j("filters"),
    none: j("none"),
  };
}
