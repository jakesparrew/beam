import type { ReactNode } from "react";
import { headers } from "next/headers";
import { localeFromSegment, URL_SEGMENT, LOCALES } from "@beam/core/i18n";
import { PortalShell } from "@beam/ui";
import { requireCustomer } from "@/lib/auth";
import { flag } from "@/lib/flags";
import { softTranslator, translator } from "@/lib/i18n";
import { visiblePortalEntries, type PortalNavEntry } from "@/modules/platform/portal-nav";
import { NAV } from "@/registry/nav.generated";
import type { FlagKey } from "@/registry/types.generated";

/**
 * The customer portal shell (platform spec 5): `requireCustomer()` then `PortalShell` with the
 * customer nav, without entries whose flag is off for the customer (PL-43). site-P6 takes this
 * file over and wraps it with its `PortalSiteChrome` (D65).
 */
export default async function PortalLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale: seg } = await params;
  const locale = localeFromSegment(seg) ?? "nl-BE";
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const pathname = ((await headers()).get("x-pathname") ?? `/${seg}/account`).split("?")[0]!;
  const rest = pathname.replace(/^\/(nl|fr|en)/, "");
  const entries = await visiblePortalEntries(NAV.portal as readonly PortalNavEntry[], (key) => flag(key as FlagKey, actor));
  const nav = [
    ...entries.map((e) => ({ key: e.key, href: `/${seg}${e.href.replace(/^\/(nl|fr|en)(?=\/)/, "")}`, label: soft(e.labelKey), icon: e.icon })),
    { key: "platform.security", href: `/${seg}/account/security`, label: tr("platform.nav.security"), icon: "shield" },
  ];
  return (
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
  );
}
