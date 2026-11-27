/**
 * The building blocks of the customer profile (`/admin/persons/[id]`, owner review November
 * 2026): quick-contact icon links, one compact banner with the reception warnings, a KPI row
 * whose empty cells are a small muted line with an action (never a big "0"), visit rows with a
 * date tile, the follow-up lines, the recent activity and a twelve-month visit strip. Server
 * compatible (no hooks); the page formats every value and passes every string.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@beam/ui";
import { StatusPill, type Tone } from "../kit";

export type Action = { href: string; label: string };

const actionLink =
  "font-semibold whitespace-nowrap text-[#8a5a14] hover:underline";

function ActionLink({
  action,
  className,
}: {
  action: Action;
  className?: string;
}) {
  return (
    <Link href={action.href as never} className={cn(actionLink, className)}>
      {action.label} →
    </Link>
  );
}

// Header ---------------------------------------------------------------------------------------

const iconLink =
  "grid size-7 place-items-center rounded-md border border-border bg-card text-muted-foreground hover:border-[#c9973a] hover:text-[#8a5a14]";

/** Mail, call and WhatsApp as small icon links; each shows only when its address is known. */
export function ContactLinks({
  email,
  phone,
  whatsapp,
  labels,
}: {
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  labels: { email: string; call: string; whatsapp: string };
}) {
  if (!email && !phone) return null;
  return (
    <span
      className="flex items-center gap-1"
      data-testid="person-contact-links"
    >
      {email ? (
        <a
          href={`mailto:${email}`}
          className={iconLink}
          aria-label={`${labels.email}: ${email}`}
          title={email}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-3.5"
          >
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="m3 7 9 6 9-6" />
          </svg>
        </a>
      ) : null}
      {phone ? (
        <a
          href={`tel:${phone}`}
          className={iconLink}
          aria-label={`${labels.call}: ${phone}`}
          title={phone}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-3.5"
          >
            <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
          </svg>
        </a>
      ) : null}
      {whatsapp ? (
        <a
          href={`https://wa.me/${whatsapp}`}
          target="_blank"
          rel="noopener noreferrer"
          className={iconLink}
          aria-label={labels.whatsapp}
          title={labels.whatsapp}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-3.5"
          >
            <path d="M3 21l1.7-4.6A8.5 8.5 0 1 1 8 19.6z" />
            <path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 .8a4 4 0 0 1-1.8-1.8l.8-1-1-2z" />
          </svg>
        </a>
      ) : null}
    </span>
  );
}

// Reception warnings ---------------------------------------------------------------------------

export type DeskAlert = {
  key: string;
  tone: "bad" | "warn";
  text: string;
  action?: Action | null;
};

/** The warnings reception must see before anything else, in one compact banner. */
export function DeskAlerts({
  title,
  items,
}: {
  title: string;
  items: DeskAlert[];
}) {
  if (!items.length) return null;
  const blocking = items.some((i) => i.tone === "bad");
  return (
    <section
      aria-label={title}
      data-testid="person-alerts"
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-xl border px-4 py-2.5 text-[0.8125rem]",
        blocking
          ? "border-[var(--status-bad)]/25 bg-[var(--status-bad-soft)]"
          : "border-[var(--status-warn)]/25 bg-[var(--status-warn-soft)]",
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          blocking ? "text-[var(--status-bad)]" : "text-[var(--status-warn)]",
        )}
      >
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
      <ul className="flex flex-1 flex-wrap gap-x-5 gap-y-1">
        {items.map((i) => (
          <li
            key={i.key}
            data-alert={i.key}
            className="flex flex-wrap items-center gap-x-2"
          >
            <span
              className={cn(
                "font-medium",
                i.tone === "bad"
                  ? "text-[var(--status-bad)]"
                  : "text-[var(--status-warn)]",
              )}
            >
              {i.text}
            </span>
            {i.action ? (
              <ActionLink action={i.action} className="text-[0.75rem]" />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

// KPI row --------------------------------------------------------------------------------------

export type ProfileKpi = {
  key: string;
  label: string;
  href?: string;
  body: ReactNode;
};

/** The key figures in one hairline surface; the label links to the tab with the detail. */
export function ProfileKpis({
  label,
  items,
}: {
  label: string;
  items: ProfileKpi[];
}) {
  return (
    // Hairlines are the 1px gaps over the border colour; an odd last cell spans the two-column row.
    <section
      aria-label={label}
      data-testid="kpi-strip"
      className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-flow-col lg:auto-cols-fr lg:grid-cols-none"
    >
      {items.map((k) => (
        <div
          key={k.key}
          data-kpi={k.key}
          className="grid min-w-0 content-start gap-1 bg-card px-5 py-3 sm:last:odd:col-span-2 lg:last:odd:col-span-1"
        >
          {k.href ? (
            <Link
              href={k.href as never}
              className="w-fit text-[0.75rem] font-medium text-muted-foreground hover:text-foreground"
            >
              {k.label}
            </Link>
          ) : (
            <span className="text-[0.75rem] font-medium text-muted-foreground">
              {k.label}
            </span>
          )}
          {k.body}
        </div>
      ))}
    </section>
  );
}

const kpiTone: Partial<Record<Tone, string>> = {
  bad: "text-[var(--status-bad)]",
  warn: "text-[var(--status-warn)]",
  ok: "text-[var(--status-ok)]",
};

/** A filled KPI: the figure, and an optional muted line under it. */
export function KpiValue({
  value,
  sub,
  tone,
}: {
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
}) {
  return (
    <>
      <span
        className={cn(
          "text-[1.125rem] leading-tight font-semibold tracking-[-0.01em] tabular-nums",
          tone && kpiTone[tone],
        )}
      >
        {value}
      </span>
      {sub ? (
        <span className="text-[0.75rem] text-muted-foreground">{sub}</span>
      ) : null}
    </>
  );
}

/** An empty KPI: a small muted line and, where one exists, its action. */
export function KpiEmpty({
  text,
  action,
}: {
  text: string;
  action?: Action | null;
}) {
  return (
    <span
      className="flex flex-wrap items-baseline gap-x-2 pt-0.5 text-[0.8125rem]"
      data-empty="true"
    >
      <span className="text-muted-foreground">{text}</span>
      {action ? (
        <ActionLink action={action} className="text-[0.75rem]" />
      ) : null}
    </span>
  );
}

/** One credit kind: label, remaining of total, a thin bar and its expiry. */
export function CreditMeter({
  label,
  remaining,
  total,
  sub,
}: {
  label: string;
  remaining: number;
  total: number | null;
  sub?: string | null;
}) {
  const pct = total
    ? Math.min(100, Math.round((remaining / total) * 100))
    : 100;
  const low = total !== null && remaining <= 1;
  return (
    <span className="grid gap-1">
      <span className="flex items-baseline justify-between gap-2 text-[0.8125rem]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">
          <span className={cn(low && "text-[var(--status-warn)]")}>
            {remaining}
          </span>
          {total !== null ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              / {total}
            </span>
          ) : null}
        </span>
      </span>
      {total !== null ? (
        <span
          aria-hidden="true"
          className="h-1 overflow-hidden rounded-full bg-muted"
        >
          <span
            className="block h-full rounded-full"
            style={{
              width: `${Math.max(pct, remaining ? 6 : 0)}%`,
              background: low ? "var(--status-warn)" : "#c9973a",
            }}
          />
        </span>
      ) : null}
      {sub ? (
        <span className="text-[0.6875rem] text-muted-foreground">{sub}</span>
      ) : null}
    </span>
  );
}

// Overview -------------------------------------------------------------------------------------

export type VisitRowView = {
  id: string;
  href: string;
  weekday: string;
  day: string;
  month: string;
  time: string;
  title: string;
  meta: string | null;
  pill: { tone: Tone; label: string } | null;
};

/** The next visits as compact rows with a date tile; `empty` shows when nothing is planned. */
export function VisitList({
  rows,
  empty,
}: {
  rows: VisitRowView[];
  empty: ReactNode;
}) {
  if (!rows.length) return <div className="px-5 py-4">{empty}</div>;
  return (
    <ul className="divide-y divide-border" data-testid="next-visits">
      {rows.map((r) => (
        <li
          key={r.id}
          className="relative flex items-center gap-3.5 px-5 py-2.5 hover:bg-[#faf9f6]"
        >
          <span
            aria-hidden="true"
            className="grid w-11 shrink-0 overflow-hidden rounded-lg border border-border text-center leading-none"
          >
            <span className="bg-[#f7eedc] py-0.5 text-[0.625rem] font-semibold tracking-wide text-[#8a5a14] uppercase">
              {r.weekday}
            </span>
            <span className="py-1 text-[1rem] font-semibold tabular-nums">
              {r.day}
            </span>
          </span>
          <span className="grid min-w-0 flex-1 leading-tight">
            <Link
              href={r.href as never}
              className="truncate font-medium after:absolute after:inset-0 after:content-[''] hover:underline"
            >
              {r.title}
            </Link>
            <span className="text-[0.75rem] text-muted-foreground tabular-nums">
              {[`${r.month} · ${r.time}`, r.meta].filter(Boolean).join(" · ")}
            </span>
          </span>
          {r.pill ? (
            <StatusPill tone={r.pill.tone}>{r.pill.label}</StatusPill>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export type FollowUp = { key: string; text: string; action: Action | null };

/** The dashboard's opportunities for this client, one short line and one action each. */
export function FollowUpList({
  items,
  empty,
}: {
  items: FollowUp[];
  empty: string;
}) {
  if (!items.length)
    return (
      <p className="px-5 py-3 text-[0.8125rem] text-muted-foreground">
        {empty}
      </p>
    );
  return (
    <ul className="divide-y divide-border text-[0.8125rem]">
      {items.map((i) => (
        <li
          key={i.key}
          data-opportunity={i.key}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-5 py-2"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full bg-[#c9973a]"
            />
            <span>{i.text}</span>
          </span>
          {i.action ? (
            <ActionLink action={i.action} className="text-[0.75rem]" />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export type ActivityRowView = {
  id: string;
  occurredAt: string;
  time: string;
  category: string;
  summary: string;
};

/** The last timeline items, as a quiet list. */
export function ActivityList({
  rows,
  empty,
}: {
  rows: ActivityRowView[];
  empty: string;
}) {
  if (!rows.length)
    return (
      <p className="px-5 py-3 text-[0.8125rem] text-muted-foreground">
        {empty}
      </p>
    );
  return (
    <ol
      className="grid gap-0 px-5 py-2 text-[0.8125rem]"
      data-testid="recent-activity"
    >
      {rows.map((r) => (
        <li key={r.id} className="grid grid-cols-[0.5rem_1fr] gap-x-3 py-1.5">
          <span
            aria-hidden="true"
            className="mt-1.5 size-1.5 rounded-full bg-border"
          />
          <span className="grid min-w-0 leading-snug">
            <span className="truncate">{r.summary}</span>
            <span className="text-[0.6875rem] text-muted-foreground">
              <time dateTime={r.occurredAt}>{r.time}</time> · {r.category}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export type MonthCount = { key: string; label: string; count: number };

/** Attended visits per Brussels month for the twelve months up to `now`'s, oldest first. */
export function visitsByMonth(
  dates: readonly Date[],
  now: Date,
  locale: string,
): MonthCount[] {
  const ym = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Brussels",
    year: "numeric",
    month: "2-digit",
  });
  const label = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "narrow",
  });
  const [y, m] = ym.format(now).split("-").map(Number) as [number, number];
  const months: MonthCount[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 15));
    months.push({
      key: d.toISOString().slice(0, 7),
      label: label.format(d),
      count: 0,
    });
  }
  const byKey = new Map(months.map((x) => [x.key, x]));
  for (const d of dates) {
    const hit = byKey.get(ym.format(d));
    if (hit) hit.count++;
  }
  return months;
}

/** A tiny bar strip of visits per month; `title(m)` is each bar's tooltip and screen-reader text. */
export function VisitsStrip({
  label,
  months,
  title,
}: {
  label: string;
  months: MonthCount[];
  title: (m: MonthCount) => string;
}) {
  const max = Math.max(1, ...months.map((m) => m.count));
  return (
    <figure className="grid gap-1.5" data-testid="visits-strip">
      <figcaption className="text-[0.75rem] font-medium text-muted-foreground">
        {label}
      </figcaption>
      <ul className="grid h-12 grid-cols-12 items-end gap-1">
        {months.map((m) => (
          <li key={m.key} title={title(m)} className="grid h-full content-end">
            <span className="sr-only">{title(m)}</span>
            <span
              aria-hidden="true"
              className={cn(
                "block rounded-sm",
                m.count ? "bg-[#c9973a]" : "bg-muted",
              )}
              style={{
                height: m.count
                  ? `${Math.max(12, Math.round((m.count / max) * 100))}%`
                  : "3px",
              }}
            />
          </li>
        ))}
      </ul>
      <span
        aria-hidden="true"
        className="grid grid-cols-12 gap-1 text-center text-[0.625rem] text-muted-foreground uppercase"
      >
        {months.map((m) => (
          <span key={m.key}>{m.label}</span>
        ))}
      </span>
    </figure>
  );
}
