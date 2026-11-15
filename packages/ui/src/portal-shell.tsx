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
  /** The "More" menu holding the entries after the first few. */
  more?: string;
  /** Link back to the public website. */
  website?: string;
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
  /** Logo image (light artwork for the dark header); the brand text otherwise. */
  logoSrc?: string;
  /** Where the logo links (the portal home). */
  homeHref?: string;
  /** The public website, linked from the header. */
  websiteHref?: string;
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
/** Entries shown as tabs; the rest sit under "More". */
const PRIMARY = 4;

function isActive(href: string, currentPath?: string, exact?: boolean): boolean {
  if (!currentPath) return false;
  return currentPath === href || (!exact && currentPath.startsWith(`${href}/`));
}

/**
 * Customer portal chrome (installable PWA): a navy header with the logo, the first entries as
 * tabs and the rest under "More", the locale switch, and a bottom tab bar on mobile; skip link and
 * `main` landmark (PL-90). Server-renderable: plain links, "More" is a `<details>`.
 */
export function PortalShell({
  nav,
  locale,
  localeSwitch,
  labels,
  currentPath,
  logoSrc,
  homeHref,
  websiteHref,
  children,
}: PortalShellProps) {
  const text: PortalShellLabels = labels ?? {
    ...(FALLBACK[locale] ?? FALLBACK.en!),
  };
  // The home entry is a prefix of every other one, so it is active only on itself.
  const homeKey = nav.find((i) => nav.every((o) => o === i || o.href.startsWith(`${i.href}/`)))?.key;
  const active = (item: PortalNavItem) => isActive(item.href, currentPath, item.key === homeKey);
  const primary = nav.length > PRIMARY + 1 ? nav.slice(0, PRIMARY) : nav;
  const rest = nav.length > PRIMARY + 1 ? nav.slice(PRIMARY) : [];
  const restActive = rest.some(active);

  const link = (item: PortalNavItem, variant: "tab" | "menu" | "bottom") => (
    <a
      href={item.href}
      data-nav-key={item.key}
      aria-current={active(item) ? "page" : undefined}
      className={cn(
        variant === "tab" &&
          "flex items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-medium text-[#fffaef]/75 transition hover:bg-[#fffaef]/10 hover:text-[#fffaef]",
        variant === "tab" && active(item) && "bg-[#fffaef]/12 text-[#fffaef]",
        variant === "menu" &&
          "flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-foreground hover:bg-muted",
        variant === "menu" && active(item) && "bg-muted font-medium",
        variant === "bottom" &&
          "flex flex-col items-center gap-1 px-1 py-2 text-[0.7rem] text-muted-foreground",
        variant === "bottom" && active(item) && "font-semibold text-foreground",
      )}
    >
      <NavIcon
        icon={item.icon}
        className={variant === "bottom" ? "size-5" : "size-4"}
      />
      <span>{item.label}</span>
    </a>
  );

  const moreMenu = (variant: "top" | "bottom") =>
    rest.length ? (
      <details className={cn("group relative", variant === "bottom" && "flex-1")}>
        <summary
          className={cn(
            "flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden",
            variant === "top"
              ? cn("gap-1.5 rounded-full px-3.5 py-2 text-sm font-medium text-[#fffaef]/75 hover:bg-[#fffaef]/10 hover:text-[#fffaef]", restActive && "text-[#fffaef]")
              : cn("flex-col gap-1 px-1 py-2 text-[0.7rem] text-muted-foreground", restActive && "font-semibold text-foreground"),
          )}
        >
          {variant === "bottom" ? (
            <span aria-hidden="true" className="text-lg leading-5">
              ⋯
            </span>
          ) : null}
          <span>{text.more ?? "…"}</span>
          {variant === "top" ? (
            <span aria-hidden="true" className="text-xs transition-transform group-open:rotate-180">
              ▾
            </span>
          ) : null}
        </summary>
        <ul
          className={cn(
            "absolute z-50 grid w-64 gap-0.5 rounded-2xl border bg-card p-2 shadow-xl",
            variant === "top" ? "top-full right-0 mt-2" : "right-2 bottom-full mb-2",
          )}
        >
          {rest.map((item) => (
            <li key={item.key}>{link(item, "menu")}</li>
          ))}
        </ul>
      </details>
    ) : null;

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
      <header className="sticky top-0 z-40 bg-[#212842] pt-[env(safe-area-inset-top)] text-[#fffaef] shadow-[0_8px_24px_-16px_rgb(33_40_66/0.6)]">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
          <a href={homeHref ?? primary[0]?.href ?? "#"} className="flex shrink-0 items-center">
            {logoSrc ? (
              // eslint-disable-next-line @next/next/no-img-element -- a static brand file
              <img src={logoSrc} alt="" className="h-8 w-auto" />
            ) : null}
            {text.brand ? (
              <span className={logoSrc ? "sr-only" : "font-semibold"}>{text.brand}</span>
            ) : null}
          </a>
          <nav aria-label={text.navigation} className="hidden md:block">
            <ul className="flex items-center gap-1">
              {primary.map((item) => (
                <li key={item.key}>{link(item, "tab")}</li>
              ))}
              {rest.length ? <li>{moreMenu("top")}</li> : null}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {websiteHref && text.website ? (
              <a href={websiteHref} className="hidden whitespace-nowrap rounded-full px-3 py-2 text-sm text-[#fffaef]/75 hover:text-[#fffaef] xl:inline">
                {text.website} ↗
              </a>
            ) : null}
            <ul
              aria-label={localeSwitch.label}
              className="flex items-center gap-0.5 rounded-full bg-[#fffaef]/8 p-0.5"
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
                        "block rounded-full px-2.5 py-1 text-xs font-medium text-[#fffaef]/70 hover:text-[#fffaef]",
                        current && "bg-[#fffaef] text-[#212842] hover:text-[#212842]",
                      )}
                    >
                      {option.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </header>
      <main
        id={MAIN_ID}
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-28 outline-none md:py-10 md:pb-10"
      >
        {children}
      </main>
      {nav.length > 0 ? (
        <nav
          aria-label={text.navigation}
          data-slot="portal-bottom-nav"
          className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        >
          <ul className="flex">
            {primary.map((item) => (
              <li key={item.key} className="flex-1">
                {link(item, "bottom")}
              </li>
            ))}
            {rest.length ? <li className="flex flex-1">{moreMenu("bottom")}</li> : null}
          </ul>
        </nav>
      ) : null}
      <Toaster position="top-center" />
    </div>
  );
}
