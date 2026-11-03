import type { ReactNode } from "react";
import { cn } from "./cn";
import { NavIcon } from "./components/nav-icon";
import { Toaster } from "./components/sonner";

/** A customer navigation entry (from `audience: 'customer'` nav entries). */
export type PortalNavItem = {
  key: string;
  href: string;
  label: string;
  icon?: string | ReactNode;
};

export type PortalLocaleSwitch = {
  /** Accessible name of the switch, for example "Language". */
  label: string;
  /** One link per locale to the same page in that locale. */
  options: { locale: string; label: string; href: string }[];
};

export type PortalShellLabels = {
  skipToContent: string;
  /** Accessible name of the navigation, for example "Account navigation". */
  navigation: string;
  /** Product name in the header. */
  brand?: string;
};

export type PortalShellProps = {
  nav: PortalNavItem[];
  /** Current locale (`nl-BE`, `fr-BE`, `en`); marks the active switch option. */
  locale: string;
  localeSwitch: PortalLocaleSwitch;
  /** Shell strings; without them the skip link uses the built-in text of `locale`. */
  labels?: PortalShellLabels;
  /** Current pathname, to mark the active entry with `aria-current="page"`. */
  currentPath?: string;
  children: ReactNode;
};

/** Built-in fallback for the two chrome strings when the app passes no labels. */
const FALLBACK: Record<string, { skipToContent: string; navigation: string }> =
  {
    "nl-BE": {
      skipToContent: "Naar de inhoud",
      navigation: "Accountnavigatie",
    },
    "fr-BE": {
      skipToContent: "Aller au contenu",
      navigation: "Navigation du compte",
    },
    en: { skipToContent: "Skip to content", navigation: "Account navigation" },
  };

const MAIN_ID = "main-content";

function isActive(href: string, currentPath?: string): boolean {
  if (!currentPath) return false;
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

/**
 * Customer portal chrome (installable PWA): header with the locale switch, top
 * navigation on wide screens and a bottom tab bar on mobile, skip link and `main`
 * landmark (PL-90). Server-renderable: everything is a plain link.
 */
export function PortalShell({
  nav,
  locale,
  localeSwitch,
  labels,
  currentPath,
  children,
}: PortalShellProps) {
  const text = labels ?? {
    ...(FALLBACK[locale] ?? FALLBACK.en!),
    brand: undefined,
  };

  const links = (variant: "top" | "bottom") =>
    nav.map((item) => {
      const active = isActive(item.href, currentPath);
      return (
        <li
          key={item.key}
          className={variant === "bottom" ? "flex-1" : undefined}
        >
          <a
            href={item.href}
            data-nav-key={item.key}
            aria-current={active ? "page" : undefined}
            className={cn(
              variant === "top"
                ? "flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
                : "flex flex-col items-center gap-1 px-1 py-2 text-xs",
              active &&
                (variant === "top"
                  ? "bg-accent font-medium text-accent-foreground"
                  : "font-semibold text-primary"),
            )}
          >
            <NavIcon
              icon={item.icon}
              className={variant === "bottom" ? "size-5" : "size-4"}
            />
            <span>{item.label}</span>
          </a>
        </li>
      );
    });

  return (
    <div
      data-slot="portal-shell"
      className="flex min-h-dvh flex-col bg-background text-foreground"
    >
      <a
        href={`#${MAIN_ID}`}
        className="sr-only z-50 rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {text.skipToContent}
      </a>
      <header className="sticky top-0 z-40 border-b bg-background pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
          {text.brand ? (
            <span className="font-semibold">{text.brand}</span>
          ) : null}
          <nav aria-label={text.navigation} className="hidden md:block">
            <ul className="flex items-center gap-1">{links("top")}</ul>
          </nav>
          <ul
            aria-label={localeSwitch.label}
            className="ml-auto flex items-center gap-1"
          >
            {localeSwitch.options.map((option) => {
              const current = option.locale === locale;
              return (
                <li key={option.locale}>
                  <a
                    href={option.href}
                    hrefLang={option.locale}
                    lang={option.locale}
                    aria-current={current ? "true" : undefined}
                    className={cn(
                      "rounded-md px-2 py-1 text-sm hover:bg-accent hover:text-accent-foreground",
                      current && "font-semibold underline underline-offset-4",
                    )}
                  >
                    {option.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      </header>
      <main
        id={MAIN_ID}
        tabIndex={-1}
        className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 pb-24 outline-none md:pb-6"
      >
        {children}
      </main>
      {nav.length > 0 ? (
        <nav
          aria-label={text.navigation}
          data-slot="portal-bottom-nav"
          className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          <ul className="flex">{links("bottom")}</ul>
        </nav>
      ) : null}
      <Toaster position="top-center" />
    </div>
  );
}
