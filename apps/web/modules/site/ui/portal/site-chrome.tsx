/**
 * `PortalSiteChrome` (site spec section 5, rules 35 and 37, cross-module D65; site-P6): what site
 * adds around platform's `PortalShell` on every portal page. Internal to the site module (not in
 * `api.ts`); only site's portal layout `account/layout.tsx` mounts it.
 *
 * - `ConsentProvider` over the same `beam_consent` cookie as the public site: the cookie banner
 *   only while no valid choice exists, never a second banner when one does; the settings dialog
 *   opens from the footer's "Cookie settings" button (`data-cookie-settings`).
 * - `AnalyticsLoader` with the request nonce and no GA4 id (GA4 loads only on public site pages):
 *   Vercel Analytics after analytics consent, nothing before.
 * - `SwRegister` (the PWA service worker shared by site and portal).
 * - The terms banner while the customer has not accepted the latest material terms version.
 *
 * A failing consent or terms lookup renders the chrome without it (reported to Sentry), never an
 * error page.
 */
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import type { Locale } from "@beam/core/i18n";
import { CONSENT_COOKIE } from "@beam/core/site";
import { translator } from "@/lib/i18n";
import { reportError } from "@/lib/logger";
import { getTermsBannerState, type TermsBannerState } from "../../queries/portal";
import { consentLabels, getConsentChromeState, type ConsentChromeState } from "../../server/consent";
import { AnalyticsLoader } from "../public/analytics-loader";
import { ConsentProvider } from "../public/consent-provider";
import { SwRegister } from "../public/sw-register";
import { TermsBanner } from "./terms-banner";

export type PortalSiteChromeProps = {
  locale: Locale;
  /** The signed-in customer's person id (from `requireCustomer()` in the layout). */
  personId: string;
  /** The request's CSP nonce (`x-nonce`), for every `next/script` the chrome loads. */
  nonce?: string | null;
  /** Platform's `PortalShell` with the page. */
  children?: ReactNode;
};

const NO_CONSENT_STATE: ConsentChromeState = { bannerVersion: 0, latestMaterialOrdinal: null, cookieNoticeHref: null };
const NO_BANNER: TermsBannerState = { show: false };

async function safe<T>(step: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    reportError(error, { tags: { module: "site", step } });
    return fallback;
  }
}

async function consentCookie(): Promise<string | null> {
  try {
    return (await cookies()).get(CONSENT_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

/** The site-relative path of an absolute terms URL (the portal links within its own origin). */
export function sitePath(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url.startsWith("/") ? url : null;
  }
}

export async function PortalSiteChrome({ locale, personId, nonce, children }: PortalSiteChromeProps) {
  const tr = translator(locale);
  const [consent, terms, initialCookie] = await Promise.all([
    safe("portal_consent", () => getConsentChromeState(locale), NO_CONSENT_STATE),
    safe("portal_terms_banner", () => getTermsBannerState(personId), NO_BANNER),
    consentCookie(),
  ]);
  return (
    <ConsentProvider
      locale={locale}
      bannerVersion={consent.bannerVersion}
      latestMaterialOrdinal={consent.latestMaterialOrdinal}
      initialCookie={initialCookie}
      cookieNoticeHref={consent.cookieNoticeHref}
      gaMeasurementId={null}
      labels={consentLabels(tr)}
    >
      {terms.show ? (
        <TermsBanner
          versionId={terms.versionId}
          readHref={sitePath(terms.urlByLocale[locale])}
          labels={{
            banner: tr("site.portal.terms.banner"),
            read: tr("site.portal.terms.read"),
            accept: tr("site.portal.terms.accept"),
            newer: tr("site.portal.terms.newer"),
          }}
        />
      ) : null}
      {children}
      <footer data-portal-footer className="border-t px-4 pt-4 pb-24 text-sm md:pb-4">
        <div className="mx-auto max-w-5xl">
          <button type="button" data-cookie-settings className="underline underline-offset-4 hover:text-primary">
            {tr("site.portal.chrome.cookieSettings")}
          </button>
        </div>
      </footer>
      <AnalyticsLoader nonce={nonce ?? null} gaMeasurementId={null} />
      <SwRegister />
    </ConsentProvider>
  );
}
