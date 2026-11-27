/**
 * The panels of the 360 page's tabs (crm spec 5.1, owner review November 2026): `Panel` is a
 * hairline surface with a small title row (and an optional link on the right), `PanelTable` a
 * compact table of rows the page formats on the server from the owning module's api (loaded
 * through `safePanel()`): a panel whose load failed (`rows: null`) shows "Not available yet" and
 * the rest of the page renders. Rows with an `href` open on a click anywhere in the row. Every
 * string is a prop.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@beam/ui";
import { rowClass, rowLink, StatusPill, td, th, theadClass, type Tone } from "../kit";
import { NotAvailable } from "./safe-panel";

export function Panel({ title, action, testId, flush = false, children, className }: { title: string; action?: { href: string; label: string }; testId?: string; flush?: boolean; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} data-testid={testId} className={cn("grid content-start overflow-hidden rounded-xl border border-border bg-card", className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-2.5">
        <h2 className="text-[0.875rem] font-semibold">{title}</h2>
        {action ? (
          <Link href={action.href as never} className="text-[0.75rem] font-semibold text-muted-foreground hover:text-foreground">
            {action.label} →
          </Link>
        ) : null}
      </header>
      <div className={flush ? undefined : "px-5 py-4"}>{children}</div>
    </section>
  );
}

export type PanelColumn = { key: string; label: string; align?: "right"; className?: string };
export type PanelRow = { id: string; href?: string | null; cells: Record<string, ReactNode>; pill?: { tone: Tone; label: string } | null };

/** A compact table inside a flush `Panel`; the first cell carries the row link; a `pill` column shows `row.pill`. */
export function PanelTable({ columns, rows, empty, notAvailable, caption }: { columns: PanelColumn[]; rows: PanelRow[] | null; empty: string; notAvailable: string; caption: string }) {
  if (rows === null)
    return (
      <div className="px-5 py-4">
        <NotAvailable label={notAvailable} />
      </div>
    );
  if (rows.length === 0) return <p className="px-5 py-4 text-[0.8125rem] text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[0.8125rem]">
        <caption className="sr-only">{caption}</caption>
        <thead className={theadClass}>
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn(th, c.align === "right" && "text-right", c.className)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={rowClass}>
              {columns.map((c, i) => (
                <td key={c.key} className={cn(td, c.align === "right" && "text-right tabular-nums whitespace-nowrap")}>
                  {c.key === "pill" ? (
                    r.pill ? <StatusPill tone={r.pill.tone}>{r.pill.label}</StatusPill> : null
                  ) : i === 0 && r.href ? (
                    <Link href={r.href as never} className={cn(rowLink, "font-medium hover:underline")}>
                      {r.cells[c.key]}
                    </Link>
                  ) : (
                    r.cells[c.key]
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
