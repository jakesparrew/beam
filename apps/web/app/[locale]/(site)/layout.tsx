import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { localeFromSegment, type Locale } from "@beam/core/i18n";
import { CONSENT_COOKIE, localePath, parseSiteSettings } from "@beam/core/site";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { reportError } from "@/lib/logger";
import { getSetting } from "@/lib/settings";
import { getCompanyFooter, getNavMenus, type CompanyFooterView, type PublicNavMenus } from "@/modules/site/queries";
import { analyticsProductionMode, consentLabels, getConsentChromeState, type ConsentChromeState } from "@/modules/site/server/consent";
import { AnalyticsLoader, gaIdFor } from "@/modules/site/ui/public/analytics-loader";
import { ConsentProvider } from "@/modules/site/ui/public/consent-provider";
import { SiteFooter } from "@/modules/site/ui/public/site-footer";
import { SiteHeader } from "@/modules/site/ui/public/site-header";
import { SwRegister } from "@/modules/site/ui/public/sw-register";
import { UtmCapture } from "@/modules/site/ui/public/utm-capture";

/**
 * The public site chrome (site-P2, consent and PWA by site-P5): skip link, header with the
 * `header` menu and the locale switch, the main landmark and the footer with menus, newsletter
 * and company identification; around it `ConsentProvider` (cookie banner and settings dialog,
 * opened by the footer's `data-cookie-settings` button), the consent-gated analytics loader with
 * the request nonce, UTM capture and the service worker registration. A failing menu, settings
 * or consent read renders the chrome without it (reported), never an error page.
 */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    reportError(error, { tags: { module: "site", step: "layout" } });
    return fallback;
  }
}

const NO_MENUS: PublicNavMenus = { header: [], footer: [], legal: [] };
const NO_CONSENT_STATE: ConsentChromeState = { bannerVersion: 0, latestMaterialOrdinal: null, cookieNoticeHref: null };

/** GA4 loads only in production with `settings.site.analytics_enabled` and a measurement id (rule 37). */
async function gaMeasurementId(): Promise<string | null> {
  if (!analyticsProductionMode()) return null;
  const site = parseSiteSettings(await getSetting(await getAppDb(), "site"));
  return gaIdFor({ isProduction: true, analyticsEnabled: site.analytics_enabled, gaMeasurementId: site.ga_measurement_id });
}

async function consentCookie(): Promise<string | null> {
  try {
    return (await cookies()).get(CONSENT_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

export default async function SiteLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale: segment } = await params;
  const maybeLocale = localeFromSegment(segment);
  if (!maybeLocale) notFound();
  const locale: Locale = maybeLocale;
  const tr = translator(locale);
  const [menus, company, consent, gaId, initialCookie] = await Promise.all([
    safe(() => getNavMenus(locale), NO_MENUS),
    safe<CompanyFooterView | null>(() => getCompanyFooter(locale), null),
    safe(() => getConsentChromeState(locale), NO_CONSENT_STATE),
    safe(gaMeasurementId, null),
    consentCookie(),
  ]);
  const h = await headers();
  const nonce = h.get("x-nonce");
  const requested = (h.get("x-pathname") ?? "").split("?")[0] ?? "";
  const pagePath = requested.startsWith(`/${segment}`) ? requested : localePath(locale, "");
  return (
    <ConsentProvider
      locale={locale}
      bannerVersion={consent.bannerVersion}
      latestMaterialOrdinal={consent.latestMaterialOrdinal}
      initialCookie={initialCookie}
      cookieNoticeHref={consent.cookieNoticeHref}
      gaMeasurementId={gaId}
      labels={consentLabels(tr)}
    >
      <div className="flex min-h-dvh flex-col">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:shadow"
        >
          {tr("site.public.skipLink")}
        </a>
        <SiteHeader locale={locale} items={menus.header} brand={company?.tradeName ?? company?.legalName ?? "BEAM"} tr={tr} />
        <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
          {children}
        </main>
        <SiteFooter locale={locale} footer={menus.footer} legal={menus.legal} company={company} tr={tr} pagePath={pagePath} />
      </div>
      <AnalyticsLoader nonce={nonce} gaMeasurementId={gaId} />
      <UtmCapture />
      <SwRegister />
    </ConsentProvider>
  );
}
