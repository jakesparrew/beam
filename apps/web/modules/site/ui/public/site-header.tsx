/**
 * The public header (site spec section 5): BEAM's logo linking home, the `header` menu (depth 2,
 * keyboard-operable: sub-items are a plain nested list revealed on hover and focus), the locale
 * switch, the account link ("Hi <name>" when signed in: customers to their account, staff to the
 * back-office) and the gold "Book your session" pill, and the mobile menu. Sticky, on navy.
 */
import { LOCALES, type Locale } from "@beam/core/i18n";
import { localePath, portalPath } from "@beam/core/site";
import { translator } from "@/lib/i18n";
import type { PublicNavItem } from "../../queries/public";
import { AccountLink } from "./account-link";
import { ArrowBadge, goldButtonClass, type Tr } from "./block-renderer";
import { LocaleSwitcher, type LocaleOption } from "./locale-switcher";
import { MobileMenu } from "./mobile-menu";

const SHORT: Record<Locale, string> = { "nl-BE": "NL", "fr-BE": "FR", en: "EN" };

export function localeOptions(): LocaleOption[] {
  return LOCALES.map((l) => ({ locale: l, short: SHORT[l], label: translator(l)(`site.public.languages.${l}`), href: localePath(l, "") }));
}

export function SiteHeader({ locale, items, brand, tr }: { locale: Locale; items: PublicNavItem[]; brand: string; tr: Tr }) {
  return (
    <header className="site-on-dark sticky top-0 z-40 border-b border-[#fffaef]/10 bg-[#212842]/95 backdrop-blur-md">
      <div className="relative mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <a href={localePath(locale, "")} aria-label={brand} className="shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- a static brand file, no optimisation needed */}
          <img src="/brand/beam-logo-header.png" alt={brand} width={567} height={112} className="h-9 w-auto sm:h-10" />
        </a>
        {items.length ? (
          <nav aria-label={tr("platform.shell.navigation")} className="hidden lg:block">
            <ul className="flex items-center gap-1 text-sm font-medium">
              {items.map((item) => (
                <li key={item.id} className="group relative">
                  <a
                    href={item.href}
                    rel={item.external ? "noopener" : undefined}
                    className="whitespace-nowrap rounded-full px-3 py-2 text-[#fffaef]/90 transition hover:bg-[#fffaef]/10 hover:text-[#fffaef] focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {item.label}
                    {item.children.length ? <span aria-hidden="true" className="ml-1 text-xs text-[#d1a64a]">▾</span> : null}
                  </a>
                  {item.children.length ? (
                    <ul className="site-on-light invisible absolute left-0 top-full z-40 mt-2 min-w-56 rounded-2xl border border-border bg-[#fffaef] p-2 text-[#212842] opacity-0 shadow-xl transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                      {item.children.map((c) => (
                        <li key={c.id}>
                          <a href={c.href} rel={c.external ? "noopener" : undefined} className="block rounded-xl px-3 py-2 hover:bg-[#f4ead3]">
                            {c.label}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <div className="flex items-center gap-2">
          <div className="hidden sm:block">
            <LocaleSwitcher current={locale} options={localeOptions()} label={tr("site.public.localeSwitch.label")} />
          </div>
          <AccountLink
            accountHref={portalPath(locale, "home")}
            label={tr("site.public.header.account")}
            helloTemplate={tr("site.public.header.hello", { name: "{name}" })}
            className="hidden items-center gap-2 whitespace-nowrap rounded-full px-3 py-2 text-sm font-medium text-[#fffaef]/90 transition hover:bg-[#fffaef]/10 xl:inline-flex"
          />
          <a href={localePath(locale, "book")} className={`${goldButtonClass} whitespace-nowrap py-1.5 pr-1.5 pl-5 max-sm:hidden`}>
            {tr("site.public.header.book")}
            <ArrowBadge dark />
          </a>
          <MobileMenu items={items} openLabel={tr("site.public.menu.open")} closeLabel={tr("site.public.menu.close")} navLabel={tr("platform.shell.navigation")}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <LocaleSwitcher current={locale} options={localeOptions()} label={tr("site.public.localeSwitch.label")} />
              <AccountLink
                accountHref={portalPath(locale, "home")}
                label={tr("site.public.header.account")}
                helloTemplate={tr("site.public.header.hello", { name: "{name}" })}
                className="inline-flex items-center gap-2 text-sm font-medium"
              />
            </div>
            <a href={localePath(locale, "book")} className={`${goldButtonClass} mt-4 w-full justify-between py-1.5 pr-1.5 pl-5`}>
              {tr("site.public.header.book")}
              <ArrowBadge dark />
            </a>
          </MobileMenu>
        </div>
      </div>
    </header>
  );
}
