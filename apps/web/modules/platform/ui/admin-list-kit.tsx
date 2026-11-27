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
export function Disclosure({
  label,
  count,
  value,
  clear,
  children,
  align = "left",
  icon,
  summaryClassName,
}: {
  label: string;
  count?: number;
  value?: ReactNode;
  clear?: { href: Href; label: string } | null;
  children: ReactNode;
  align?: "left" | "right";
  icon?: ReactNode;
  summaryClassName?: string;
}) {
  return (
    <details className="relative" data-popover="">
      <summary className={cn("flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[0.8125rem] font-semibold whitespace-nowrap hover:bg-muted [&::-webkit-details-marker]:hidden", summaryClassName)}>
        {icon}
        {label}
        {value ? <span className="font-normal text-muted-foreground">{value}</span> : null}
        {count ? <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[0.6875rem] text-primary-foreground">{count}</span> : null}
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3.5 text-muted-foreground">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className={cn("absolute z-20 mt-1.5 grid w-72 max-w-[calc(100vw-2rem)] gap-3 rounded-xl border border-border bg-card p-4 shadow-lg", align === "right" ? "right-0" : "left-0")}>
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

export type ToolbarLabels = { search: string; filters: string; clearAll: string; remove: string; shortcut: string };

/** The shared labels of `ListToolbar`, from `platform.table`. */
export function listToolbarLabels(tr: (key: string) => string): ToolbarLabels {
  return { search: tr("platform.table.search"), filters: tr("platform.table.filters"), clearAll: tr("platform.table.clear_all"), remove: tr("platform.table.remove_filter"), shortcut: tr("platform.table.search_shortcut") };
}

/** A quick filter of the chip row (one active), with an optional count. */
export type ToolbarChip = { key: string; label: ReactNode; href: Href; active: boolean; count?: number };
/** An applied filter shown as a removable chip; `href` is the list without it. */
export type AppliedFilter = { key: string; label: ReactNode; value?: ReactNode; href: Href };

/**
 * The toolbar of every back-office list (owner review, November 2026: "the search bar is the main
 * thing; don't overload us with buttons"). One wide search (`/` focuses it) with a single
 * "Filters" popover beside it holding the secondary filters, then one compact row: the three or
 * four most used views as chips, the applied filters as removable chips with "Clear all", and an
 * optional `aside` (a period switch, a view toggle) on the right. One GET form with
 * `data-auto-filter`, so every URL keeps working and fields apply as they change; `hidden` carries
 * the query params the visible fields do not.
 */
export function ListToolbar({
  labels,
  search,
  hidden,
  filters,
  chips,
  applied = [],
  clearAll,
  aside,
  className,
}: {
  labels: ToolbarLabels;
  search?: { placeholder: string; defaultValue?: string | undefined; name?: string; label?: string };
  hidden?: Record<string, string | undefined>;
  filters?: { count: number; children: ReactNode; label?: string };
  chips?: { label: string; items: ToolbarChip[] };
  applied?: AppliedFilter[];
  clearAll?: Href | null;
  aside?: ReactNode;
  className?: string;
}) {
  const row = !!(chips?.items.length || applied.length || aside);
  return (
    <form data-auto-filter="" method="get" role="search" className={cn("grid gap-2.5", className)}>
      {Object.entries(hidden ?? {}).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <div className="flex items-center gap-2">
        {search ? (
          <label className="group relative flex min-w-0 flex-1 items-center">
            <span className="sr-only">{search.label ?? labels.search}</span>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="pointer-events-none absolute left-3.5 size-[1.125rem] text-muted-foreground group-focus-within:text-[#8a5a14]">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="search"
              name={search.name ?? "q"}
              defaultValue={search.defaultValue ?? ""}
              placeholder={search.placeholder}
              maxLength={100}
              autoComplete="off"
              aria-keyshortcuts="/"
              data-super-search=""
              className="h-11 w-full rounded-xl border border-input bg-card pr-12 pl-10 text-[0.9375rem] shadow-[0_1px_2px_rgba(20,20,20,0.04)] placeholder:text-muted-foreground/80 focus:border-[#c9973a] focus:ring-[3px] focus:ring-[#c9973a]/15 focus:outline-none"
            />
            <kbd aria-hidden="true" title={labels.shortcut} className="pointer-events-none absolute right-3 hidden h-5 min-w-5 place-items-center rounded border border-border bg-muted px-1 font-sans text-[0.6875rem] font-medium text-muted-foreground group-focus-within:invisible sm:grid">
              /
            </kbd>
          </label>
        ) : null}
        {filters ? (
          <Disclosure
            label={filters.label ?? labels.filters}
            count={filters.count}
            align="right"
            summaryClassName="h-11 rounded-xl px-3.5 shadow-[0_1px_2px_rgba(20,20,20,0.04)]"
            icon={
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-4 text-muted-foreground">
                <path d="M4 6h16M7 12h10M10 18h4" />
              </svg>
            }
          >
            {filters.children}
          </Disclosure>
        ) : null}
      </div>
      {row ? (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
          {chips?.items.length ? (
            <nav aria-label={chips.label} className="flex flex-wrap items-center gap-1.5">
              {chips.items.map((c) => (
                <Link
                  key={c.key}
                  href={c.href}
                  aria-current={c.active ? "true" : undefined}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[0.75rem] font-medium whitespace-nowrap",
                    c.active ? "border-[#c9973a]/45 bg-[#f7eedc] text-[#8a5a14]" : "border-border bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                  )}
                >
                  {c.label}
                  {c.count !== undefined ? <span className={cn("tabular-nums", c.active ? "text-[#8a5a14]/70" : "text-muted-foreground/70")}>{c.count}</span> : null}
                </Link>
              ))}
            </nav>
          ) : null}
          {chips?.items.length && applied.length ? <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" /> : null}
          {applied.map((a) => (
            <Link key={a.key} href={a.href} className="inline-flex h-7 items-center gap-1 rounded-full bg-muted pr-1.5 pl-2.5 text-[0.75rem] whitespace-nowrap hover:bg-[#ebe8e1]" data-applied-filter={a.key}>
              <span className="text-muted-foreground">
                {a.label}
                {a.value !== undefined ? ":" : ""}
              </span>
              {a.value !== undefined ? <span className="font-semibold text-foreground">{a.value}</span> : null}
              <span aria-hidden="true" className="ml-0.5 grid size-4 place-items-center rounded-full text-muted-foreground">
                ×
              </span>
              <span className="sr-only">{labels.remove}</span>
            </Link>
          ))}
          {applied.length > 1 && clearAll ? (
            <Link href={clearAll} className="ml-1 text-[0.75rem] font-semibold text-muted-foreground hover:text-foreground">
              {labels.clearAll}
            </Link>
          ) : null}
          {aside ? <div className="ml-auto flex flex-wrap items-center gap-2">{aside}</div> : null}
        </div>
      ) : null}
    </form>
  );
}

export type Kpi ={ key: string; label: string; value: ReactNode; sub?: ReactNode; href?: Href; tone?: Tone };

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
