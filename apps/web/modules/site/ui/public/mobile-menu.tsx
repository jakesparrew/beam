"use client";

/**
 * The header menu below `md` (rule 50): a disclosure button with `aria-expanded` that opens the
 * header items; Escape closes it and returns focus to the button.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { PublicNavItem } from "../../queries/public";

export function MobileMenu({ items, openLabel, closeLabel, navLabel, children }: { items: PublicNavItem[]; openLabel: string; closeLabel: string; navLabel: string; children?: ReactNode }) {
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
    <div className="lg:hidden">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring"
      >
        {open ? closeLabel : openLabel}
      </button>
      <nav id={panelId} aria-label={navLabel} hidden={!open} className="site-on-light absolute inset-x-3 top-full z-40 mt-2 rounded-3xl border border-border bg-[#fffaef] p-5 text-[#212842] shadow-xl">
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
        {children ? <div className="mt-4 border-t border-[#212842]/10 pt-4">{children}</div> : null}
      </nav>
    </div>
  );
}
