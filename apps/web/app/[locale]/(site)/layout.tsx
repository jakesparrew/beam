import type { ReactNode } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { localeFromSegment } from "@beam/core/i18n";
import { localePath } from "@beam/core/site";
import { translator } from "@/lib/i18n";
import { reportError } from "@/lib/logger";
import { getCompanyFooter, getNavMenus, type CompanyFooterView, type PublicNavMenus } from "@/modules/site/queries";
import { SiteFooter } from "@/modules/site/ui/public/site-footer";
import { SiteHeader } from "@/modules/site/ui/public/site-header";

/**
 * The public site chrome (site-P2): skip link, header with the `header` menu and the locale
 * switch, the main landmark and the footer with menus, newsletter and company identification.
 * A failing menu or settings read renders the chrome without it (reported), never an error page.
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

export default async function SiteLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const tr = translator(locale);
  const [menus, company] = await Promise.all([safe(() => getNavMenus(locale), NO_MENUS), safe<CompanyFooterView | null>(() => getCompanyFooter(locale), null)]);
  const requested = ((await headers()).get("x-pathname") ?? "").split("?")[0] ?? "";
  const pagePath = requested.startsWith(`/${segment}`) ? requested : localePath(locale, "");
  return (
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
  );
}
