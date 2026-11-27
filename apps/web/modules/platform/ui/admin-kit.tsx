/**
 * The back-office page kit (owner review, November 2026): the few building blocks every data page
 * uses, so pages look and read the same. A page has one header (title, one line of context, at
 * most one primary action and a couple of quiet secondary ones), one toolbar (segmented filters,
 * a period switch, a search), and its data in hairline surfaces: tables with fixed columns and
 * right-aligned figures, status shown as a coloured pill. Server components, no client state.
 */
import type { Route } from "next";
import type { UrlObject } from "node:url";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn, type StepFormLabels } from "@beam/ui";

type Href = Route | UrlObject;

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="grid gap-1">
        <h1>{title}</h1>
        {description ? <p className="max-w-2xl text-[0.8125rem] text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function PrimaryAction({ href, children }: { href: Href; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[0.8125rem] font-semibold text-primary-foreground hover:opacity-90">
      {children}
    </Link>
  );
}

export function SecondaryAction({ href, children }: { href: Href; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[0.8125rem] font-semibold hover:bg-muted">
      {children}
    </Link>
  );
}

/**
 * The "⋯" menu of a page header: the secondary destinations and actions, so the header keeps one
 * primary action. A native `<details>`; the admin shell's `AutoFilter` closes it on Escape or a
 * click outside.
 */
export function MoreMenu({ label, items }: { label: string; items: { key: string; href: Href; label: ReactNode }[] }) {
  if (!items.length) return null;
  const item = "block rounded-md px-2.5 py-1.5 font-medium whitespace-nowrap hover:bg-muted";
  return (
    <details className="relative" data-popover="" data-testid="page-more-menu">
      <summary aria-label={label} title={label} className="grid size-9 cursor-pointer list-none place-items-center rounded-lg border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className="size-4">
          <circle cx="5" cy="12" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="19" cy="12" r="1.75" />
        </svg>
      </summary>
      <ul className="absolute right-0 z-20 mt-1.5 grid min-w-48 gap-0.5 rounded-xl border border-border bg-card p-1.5 text-[0.8125rem] shadow-lg">
        {items.map((it) => (
          <li key={it.key}>
            <Link href={it.href} className={item}>
              {it.label}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A row of filters and switches above the data. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>;
}

/** A segmented control of links (one active); `label` names it for screen readers. */
export function Segmented({ label, items }: { label: string; items: { key: string; label: ReactNode; href: Href; active: boolean; count?: number }[] }) {
  return (
    <nav aria-label={label} className="flex rounded-lg bg-muted p-0.5 text-[0.8125rem] font-medium">
      {items.map((it) => (
        <Link
          key={it.key}
          href={it.href}
          aria-current={it.active ? "true" : undefined}
          className={cn("rounded-md px-3 py-1 whitespace-nowrap text-muted-foreground hover:text-foreground", it.active && "bg-card text-foreground shadow-sm")}
        >
          {it.label}
          {it.count !== undefined ? <span className="ml-1 opacity-60">{it.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/** Previous / label / next, for weeks, days or months. */
export function PeriodSwitch({ label, previous, next, today, todayLabel, previousLabel, nextLabel }: { label: ReactNode; previous: Href; next: Href; today?: Href; todayLabel?: string; previousLabel: string; nextLabel: string }) {
  const btn = "grid h-8 min-w-8 place-items-center rounded-md px-2 text-muted-foreground hover:bg-muted hover:text-foreground";
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-0.5 text-[0.8125rem]">
      <Link href={previous} aria-label={previousLabel} className={btn}>
        ‹
      </Link>
      <span className="px-1.5 font-semibold whitespace-nowrap">{label}</span>
      <Link href={next} aria-label={nextLabel} className={btn}>
        ›
      </Link>
      {today && todayLabel ? (
        <Link href={today} className="ml-0.5 rounded-md px-2.5 py-1 font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
          {todayLabel}
        </Link>
      ) : null}
    </div>
  );
}

export type Tone = "ok" | "warn" | "bad" | "info" | "full" | "muted" | "gold";
const TONES: Record<Tone, string> = {
  ok: "bg-[var(--status-ok-soft)] text-[var(--status-ok)]",
  warn: "bg-[var(--status-warn-soft)] text-[var(--status-warn)]",
  bad: "bg-[var(--status-bad-soft)] text-[var(--status-bad)]",
  info: "bg-[var(--status-info-soft)] text-[var(--status-info)]",
  full: "bg-[var(--status-full)] text-white",
  muted: "bg-muted text-muted-foreground",
  gold: "bg-[#f7eedc] text-[#8a5a14]",
};

export function StatusPill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] leading-4 font-semibold whitespace-nowrap", TONES[tone], className)}>{children}</span>;
}

/** A hairline surface (white, 12px corners); `flush` drops the padding for tables. */
export function Surface({ children, className, flush = false, ...rest }: { children: ReactNode; className?: string; flush?: boolean } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn("rounded-xl border border-border bg-card", !flush && "p-5", flush && "overflow-hidden", className)} {...rest}>
      {children}
    </section>
  );
}

/** A thin occupancy bar with the figure next to it (booked/capacity). */
export function OccupancyBar({ taken, capacity, full }: { taken: number; capacity: number; full?: boolean }) {
  const pct = capacity ? Math.min(100, Math.round((taken / capacity) * 100)) : 0;
  return (
    <span className="flex items-center gap-2.5">
      <span aria-hidden="true" className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(pct, taken ? 4 : 0)}%`, background: full ? "#141414" : pct >= 75 ? "#b26b00" : "#1f8a5b" }} />
      </span>
      <span className="font-semibold tabular-nums">
        {taken}
        <span className="font-normal text-muted-foreground">/{capacity}</span>
      </span>
    </span>
  );
}

/** The labels of `StepForm` (`@beam/ui`), the Typeform-style long forms, from `platform.step_form`. */
export function stepFormLabels(tr: (key: string, params?: Record<string, string | number>) => string): StepFormLabels {
  const t = (k: string) => tr(`platform.step_form.${k}`);
  return {
    next: t("next"),
    previous: t("previous"),
    progress: tr("platform.step_form.progress", { current: "{current}", total: "{total}" }),
    review: t("review"),
    reviewIntro: t("review_intro"),
    edit: t("edit"),
    enterHint: t("enter_hint"),
    yes: t("yes"),
    no: t("no"),
  };
}

/** Column header cell and body cell classes for hairline data tables. */
export const th = "px-3 py-2 text-left text-[0.75rem] font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5";
export const td = "px-3 py-2.5 align-middle first:pl-5 last:pr-5";
