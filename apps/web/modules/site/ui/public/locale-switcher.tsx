"use client";

/**
 * The locale switch (site spec section 8): links to the same page's route in the target locale,
 * or to `unavailable` when it has none. The server renders each locale's home as the fallback;
 * on a content page `PageView` publishes its alternates in `[data-beam-alternates]`, which this
 * component reads after each navigation.
 */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

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

export function LocaleSwitcher({ current, options, label }: { current: string; options: LocaleOption[]; label: string }) {
  const pathname = usePathname();
  const [alternates, setAlternates] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    setAlternates(readAlternates());
  }, [pathname]);
  return (
    <nav aria-label={label}>
      <ul className="flex items-center gap-1 text-sm">
        {options.map((o) => {
          const active = o.locale === current;
          return (
            <li key={o.locale}>
              <a
                href={alternates?.[o.locale] ?? o.href}
                hrefLang={o.locale}
                lang={o.locale}
                aria-current={active ? "true" : undefined}
                aria-label={o.label}
                data-locale={o.locale}
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
