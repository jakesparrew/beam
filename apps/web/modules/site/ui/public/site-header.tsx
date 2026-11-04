/**
 * The public header (site spec section 5): the trade name linking home, the `header` menu (depth
 * 2, keyboard-operable: sub-items are a plain nested list revealed on hover and focus), the
 * locale switch and the mobile menu.
 */
import { LOCALES, type Locale } from "@beam/core/i18n";
import { localePath } from "@beam/core/site";
import { translator } from "@/lib/i18n";
import type { PublicNavItem } from "../../queries/public";
import type { Tr } from "./block-renderer";
import { LocaleSwitcher, type LocaleOption } from "./locale-switcher";
import { MobileMenu } from "./mobile-menu";

const SHORT: Record<Locale, string> = { "nl-BE": "NL", "fr-BE": "FR", en: "EN" };

export function localeOptions(): LocaleOption[] {
  return LOCALES.map((l) => ({ locale: l, short: SHORT[l], label: translator(l)(`site.public.languages.${l}`), href: localePath(l, "") }));
}

export function SiteHeader({ locale, items, brand, tr }: { locale: Locale; items: PublicNavItem[]; brand: string; tr: Tr }) {
  return (
    <header className="relative border-b border-border bg-background">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <a href={localePath(locale, "")} className="text-lg font-bold tracking-tight">
          {brand}
        </a>
        {items.length ? (
          <nav aria-label={tr("platform.shell.navigation")} className="hidden md:block">
            <ul className="flex items-center gap-6 text-sm font-medium">
              {items.map((item) => (
                <li key={item.id} className="group relative">
                  <a href={item.href} rel={item.external ? "noopener" : undefined} className="py-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                    {item.label}
                  </a>
                  {item.children.length ? (
                    <ul className="invisible absolute left-0 top-full z-40 min-w-48 rounded-md border border-border bg-background p-2 shadow-lg group-focus-within:visible group-hover:visible">
                      {item.children.map((c) => (
                        <li key={c.id}>
                          <a href={c.href} rel={c.external ? "noopener" : undefined} className="block rounded px-3 py-2 hover:bg-muted">
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
        <div className="flex items-center gap-3">
          <LocaleSwitcher current={locale} options={localeOptions()} label={tr("site.public.localeSwitch.label")} />
          <MobileMenu items={items} openLabel={tr("site.public.menu.open")} closeLabel={tr("site.public.menu.close")} navLabel={tr("platform.shell.navigation")} />
        </div>
      </div>
    </header>
  );
}
