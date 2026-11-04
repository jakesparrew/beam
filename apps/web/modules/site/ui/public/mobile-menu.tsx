"use client";

/**
 * The header menu below `md` (rule 50): a disclosure button with `aria-expanded` that opens the
 * header items; Escape closes it and returns focus to the button.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { PublicNavItem } from "../../queries/public";

export function MobileMenu({ items, openLabel, closeLabel, navLabel }: { items: PublicNavItem[]; openLabel: string; closeLabel: string; navLabel: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  if (!items.length) return null;
  return (
    <div className="md:hidden">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-border px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring"
      >
        {open ? closeLabel : openLabel}
      </button>
      <nav id={panelId} aria-label={navLabel} hidden={!open} className="absolute inset-x-0 top-full z-40 border-b border-border bg-background p-4 shadow-lg">
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <a href={item.href} rel={item.external ? "noopener" : undefined} className="block py-1 font-medium" onClick={() => setOpen(false)}>
                {item.label}
              </a>
              {item.children.length ? (
                <ul className="mt-1 space-y-1 pl-4">
                  {item.children.map((c) => (
                    <li key={c.id}>
                      <a href={c.href} rel={c.external ? "noopener" : undefined} className="block py-1 text-sm" onClick={() => setOpen(false)}>
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
    </div>
  );
}
