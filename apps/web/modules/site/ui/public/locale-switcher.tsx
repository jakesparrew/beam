"use client";

/**
 * The locale switch (site spec section 8): links to the same page's route in the target locale,
 * or to `unavailable` when it has none. The server renders each locale's home as the href; on a
 * content page `PageView` publishes its alternates in `[data-beam-alternates]`, and the link
 * takes the page's alternate as soon as it is hovered, focused or activated.
 */
import type { SyntheticEvent } from "react";

export type LocaleOption = { locale: string; short: string; label: string; href: string };

function readAlternates(): Record<string, string> | null {
  const el = typeof document === "undefined" ? null : document.querySelector<HTMLElement>("[data-beam-alternates]");
  if (!el?.dataset.beamAlternates) return null;
  try {
    return JSON.parse(el.dataset.beamAlternates) as Record<string, string>;
  } catch {
    return null;
  }
}

/** Points the link at the current page's alternate in its locale (or keeps the locale home). */
function retarget(event: SyntheticEvent<HTMLAnchorElement>, fallback: string): void {
  const link = event.currentTarget;
  const locale = link.dataset.locale ?? "";
  link.setAttribute("href", readAlternates()?.[locale] ?? fallback);
}

export function LocaleSwitcher({ current, options, label }: { current: string; options: LocaleOption[]; label: string }) {
  return (
    <nav aria-label={label}>
      <ul className="flex items-center gap-1 text-sm">
        {options.map((o) => {
          const active = o.locale === current;
          const update = (e: SyntheticEvent<HTMLAnchorElement>) => retarget(e, o.href);
          return (
            <li key={o.locale}>
              <a
                href={o.href}
                hrefLang={o.locale}
                lang={o.locale}
                aria-current={active ? "true" : undefined}
                aria-label={o.label}
                data-locale={o.locale}
                onPointerEnter={update}
                onFocus={update}
                onClick={update}
                onAuxClick={update}
                className={`rounded px-2 py-1 font-medium uppercase focus-visible:outline-2 focus-visible:outline-ring ${active ? "bg-muted" : "hover:underline"}`}
              >
                {o.short}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
