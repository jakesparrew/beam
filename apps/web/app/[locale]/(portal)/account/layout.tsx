import type { ReactNode } from "react";
import { headers } from "next/headers";
import { localeFromSegment, URL_SEGMENT, LOCALES } from "@beam/core/i18n";
import { PortalShell } from "@beam/ui";
import { requireCustomer } from "@/lib/auth";
import { flag } from "@/lib/flags";
import { softTranslator, translator } from "@/lib/i18n";
import { visiblePortalEntries, type PortalNavEntry } from "@/modules/platform/portal-nav";
import { PortalSiteChrome } from "@/modules/site/ui/portal/site-chrome";
import { NAV } from "@/registry/nav.generated";
import type { FlagKey } from "@/registry/types.generated";

/**
 * The customer portal layout (site rule 49, cross-module D65; site owns it from site-P6 on,
 * taking over platform-P6's Wave 0 version): `requireCustomer()` (an anonymous visitor goes to
 * the magic-link sign-in and back), then platform's `PortalShell` with the customer nav, without
 * entries whose flag is off for the customer (PL-43), wrapped with site's `PortalSiteChrome`
 * (terms banner, cookie consent and consent-gated analytics with the request nonce, the "Cookie
 * settings" link and the service worker).
 */
export default async function PortalLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale: seg } = await params;
  const locale = localeFromSegment(seg) ?? "nl-BE";
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const h = await headers();
  const pathname = (h.get("x-pathname") ?? `/${seg}/account`).split("?")[0]!;
  const nonce = h.get("x-nonce");
  const rest = pathname.replace(/^\/(nl|fr|en)/, "");
  const entries = await visiblePortalEntries(NAV.portal as readonly PortalNavEntry[], (key) => flag(key as FlagKey, actor));
  const nav = [
    ...entries.map((e) => ({ key: e.key, href: `/${seg}${e.href.replace(/^\/(nl|fr|en)(?=\/)/, "")}`, label: soft(e.labelKey), icon: e.icon })),
    { key: "platform.security", href: `/${seg}/account/security`, label: tr("platform.nav.security"), icon: "shield" },
  ];
  return (
    <PortalSiteChrome locale={locale} personId={actor.personId} nonce={nonce}>
      <PortalShell
        nav={nav}
        locale={locale}
        currentPath={pathname}
        labels={{ skipToContent: tr("platform.shell.skip_to_content"), navigation: tr("platform.shell.portal_navigation"), brand: tr("platform.shell.brand") }}
        localeSwitch={{
          label: tr("platform.shell.language"),
          options: LOCALES.map((l) => ({ locale: l, label: tr(`platform.shell.locale_${URL_SEGMENT[l]}`), href: `/${URL_SEGMENT[l]}${rest}` })),
        }}
      >
        {children}
      </PortalShell>
    </PortalSiteChrome>
  );
}
