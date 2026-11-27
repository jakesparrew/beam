/**
 * List-page additions to the back-office page kit (`./admin-kit`, owner review November 2026):
 * the toolbar's wide search field, a native `<details>` disclosure for the rarely used filters
 * (with the number of active ones) or a period, a compact KPI strip, a one-line notice, a small
 * back link and the initials avatar of a person. Server components, no client state: the fields
 * sit inside a `<form method="get" data-auto-filter>` and apply through `AutoFilter`.
 */
import type { Route } from "next";
import type { UrlObject } from "node:url";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@beam/ui";
import type { Tone } from "./admin-kit";

type Href = Route | UrlObject;

/** Field classes inside a disclosure panel (a select or a date input). */
export const fieldClass = "h-9 w-full rounded-lg border border-input bg-card px-2.5 text-[0.8125rem] text-foreground";

/** The prominent search of a toolbar: wide, with a search icon; it applies on Enter or after a pause. */
export function SearchField({ label, placeholder, defaultValue, name = "q", className }: { label: string; placeholder: string; defaultValue?: string; name?: string; className?: string }) {
  return (
    <label className={cn("relative flex min-w-[15rem] flex-1 items-center sm:max-w-md", className)}>
      <span className="sr-only">{label}</span>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="pointer-events-none absolute left-3 size-4 text-muted-foreground">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input type="search" name={name} defaultValue={defaultValue ?? ""} placeholder={placeholder} maxLength={100} className="h-9 w-full rounded-lg border border-input bg-card pr-3 pl-9 text-[0.8125rem]" />
    </label>
  );
}

/**
 * A toolbar disclosure ("Filters", "Periode"): a quiet button that opens a small panel. `count`
 * shows how many of its filters are active; `value` names the current choice (a period).
 */
export function Disclosure({ label, count, value, clear, children, align = "left" }: { label: string; count?: number; value?: ReactNode; clear?: { href: Href; label: string } | null; children: ReactNode; align?: "left" | "right" }) {
  return (
    <details className="relative">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[0.8125rem] font-semibold whitespace-nowrap hover:bg-muted [&::-webkit-details-marker]:hidden">
        {label}
        {value ? <span className="font-normal text-muted-foreground">{value}</span> : null}
        {count ? <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[0.6875rem] text-primary-foreground">{count}</span> : null}
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3.5 text-muted-foreground">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className={cn("absolute z-20 mt-1.5 grid w-72 gap-3 rounded-xl border border-border bg-card p-4 shadow-lg", align === "right" ? "right-0" : "left-0")}>
        {children}
        {clear ? (
          <Link href={clear.href} className="w-fit text-[0.75rem] font-semibold text-muted-foreground hover:text-foreground">
            {clear.label}
          </Link>
        ) : null}
      </div>
    </details>
  );
}

/** A labelled field inside a disclosure panel. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-[0.75rem] font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

export type Kpi = { key: string; label: string; value: ReactNode; sub?: ReactNode; href?: Href; tone?: Tone };

/** A row of key figures in one hairline surface, no empty space. */
export function KpiStrip({ items, ...rest }: { items: Kpi[] } & React.HTMLAttributes<HTMLElement>) {
  const tone: Partial<Record<Tone, string>> = { bad: "text-[var(--status-bad)]", warn: "text-[var(--status-warn)]", ok: "text-[var(--status-ok)]" };
  return (
    <section className="grid divide-y divide-border rounded-xl border border-border bg-card sm:grid-flow-col sm:auto-cols-fr sm:divide-x sm:divide-y-0" {...rest}>
      {items.map((k) => {
        const body = (
          <>
            <span className="text-[0.75rem] font-medium text-muted-foreground">{k.label}</span>
            <span className={cn("text-[1.375rem] leading-tight font-semibold tracking-[-0.02em] tabular-nums", k.tone && tone[k.tone])}>{k.value}</span>
            {k.sub ? <span className="text-[0.75rem] text-muted-foreground">{k.sub}</span> : null}
          </>
        );
        return k.href ? (
          <Link key={k.key} href={k.href} className="grid content-start gap-0.5 px-5 py-3 hover:bg-[#faf9f6]" data-kpi={k.key}>
            {body}
          </Link>
        ) : (
          <div key={k.key} className="grid content-start gap-0.5 px-5 py-3" data-kpi={k.key}>
            {body}
          </div>
        );
      })}
    </section>
  );
}

const DOT: Record<Tone, string> = {
  ok: "bg-[var(--status-ok)]",
  warn: "bg-[var(--status-warn)]",
  bad: "bg-[var(--status-bad)]",
  info: "bg-[var(--status-info)]",
  full: "bg-[var(--status-full)]",
  muted: "bg-muted-foreground",
  gold: "bg-[#c9973a]",
};

/** One calm line above the data: a coloured dot, the message and its link. */
export function Notice({ tone, children, action, ...rest }: { tone: Tone; children: ReactNode; action?: { href: Href; label: string } } & React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-border bg-card px-3.5 py-2 text-[0.8125rem]" {...rest}>
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[tone])} />
      <span>{children}</span>
      {action ? (
        <Link href={action.href} className="font-semibold text-[#8a5a14] hover:underline">
          {action.label} →
        </Link>
      ) : null}
    </p>
  );
}

/** A small "← Facturen" link above a page header, for pages reached from another page. */
export function BackLink({ href, children }: { href: Href; children: ReactNode }) {
  return (
    <Link href={href} className="w-fit text-[0.8125rem] font-medium text-muted-foreground hover:text-foreground">
      ← {children}
    </Link>
  );
}

/** The initials of a name in a small round avatar (decorative: the name sits next to it). */
export function Initials({ name }: { name: string | null | undefined }) {
  const letters =
    (name ?? "")
      .split(/[\s-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => Array.from(w)[0]!.toUpperCase())
      .join("") || "–";
  return (
    <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[0.6875rem] font-semibold text-muted-foreground">
      {letters}
    </span>
  );
}

/** Classes that make a whole table row open the link in its first cell (`tr` gets `rowClass`). */
export const rowClass = "relative border-b border-border last:border-b-0 hover:bg-[#faf9f6]";
export const rowLink = "after:absolute after:inset-0 after:content-['']";
/** Lifts a second link or button of a clickable row above the row's link. */
export const aboveRow = "relative z-10";
