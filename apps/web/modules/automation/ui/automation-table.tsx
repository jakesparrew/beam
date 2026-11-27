/**
 * Server-rendered pieces of the automation screens (automation spec 5): the detail header with the
 * section tabs and the stats strip in the back-office look (owner review, November 2026; the list
 * renders in its page with the kit), and the plain-words summaries of a trigger and a step offset.
 * Every string comes from the `automation` catalogue through `labels`; times are Europe/Brussels.
 */
import Link from "next/link";
import { type AutomationCategory, type At, type Definition, type Filter, type Step } from "@beam/core/automation";
import { AutomationStatusBadge, fill, type Labels } from "./outcome-badge";

export type AutomationTableRow = {
  id: string;
  slug: string;
  name: string;
  status: "draft" | "active" | "paused" | "archived";
  groupKey: string;
  groupName: string;
  groupIsExclusive: boolean;
  currentVersion: number | null;
  activeCount: number;
  entered7d: number;
  sent7d: number;
  skipped7d: number;
  failed7d: number;
  lastRunAt: Date | null;
  category: AutomationCategory;
};

export type AutomationTab = "overview" | "edit" | "builder" | "versions" | "enrolments" | "runs";

/** Title, status badge and the section tabs of one automation (links; the current one is marked). */
export function AutomationHeader({
  id,
  name,
  slug,
  status,
  current,
  l,
  actions,
}: {
  id: string;
  name: string;
  slug: string;
  status: AutomationTableRow["status"];
  current: AutomationTab;
  l: Labels;
  actions?: React.ReactNode;
}) {
  const tabs: { key: AutomationTab; href: string }[] = [
    { key: "overview", href: `/admin/automations/${id}` },
    { key: "edit", href: `/admin/automations/${id}/edit` },
    { key: "builder", href: `/admin/automations/${id}/builder` },
    { key: "versions", href: `/admin/automations/${id}/versions` },
    { key: "enrolments", href: `/admin/automations/${id}/enrolments` },
    { key: "runs", href: `/admin/automations/${id}/runs` },
  ];
  return (
    <div className="grid gap-4">
      <Link href="/admin/automations" className="w-fit text-[0.8125rem] font-medium text-muted-foreground hover:text-foreground">
        ← {l["list.title"] ?? l["common.back"]}
      </Link>
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="grid gap-1">
          <h1 className="flex flex-wrap items-center gap-3">
            {name}
            <AutomationStatusBadge status={status} label={l[`status.${status}`] ?? status} />
          </h1>
          <p className="font-mono text-[0.75rem] text-muted-foreground">{slug}</p>
        </div>
        {actions}
      </header>
      <nav aria-label={l["detail.tabs_label"]} className="flex w-fit max-w-full flex-wrap rounded-lg bg-muted p-0.5 text-[0.8125rem] font-medium">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href as never}
            aria-current={t.key === current ? "page" : undefined}
            className={`rounded-md px-3 py-1 whitespace-nowrap ${t.key === current ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            {l[`detail.tab_${t.key}`]}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** The stats tiles of `v_automation_stats`. */
export function StatTiles({ stats, l }: { stats: Record<"activeCount" | "completedCount" | "exitedCount" | "entered7d" | "sent7d" | "skipped7d" | "failed7d", number>; l: Labels }) {
  const tiles = [
    ["stat_active", stats.activeCount],
    ["stat_completed", stats.completedCount],
    ["stat_exited", stats.exitedCount],
    ["stat_entered_7d", stats.entered7d],
    ["stat_sent_7d", stats.sent7d],
    ["stat_skipped_7d", stats.skipped7d],
    ["stat_failed_7d", stats.failed7d],
  ] as const;
  return (
    <dl className="grid grid-cols-2 divide-border rounded-xl border border-border bg-card sm:grid-cols-4 lg:grid-cols-7 lg:divide-x" data-testid="automation-stats">
      {tiles.map(([key, n]) => (
        <div key={key} className="grid content-start gap-0.5 px-5 py-3">
          <dt className="text-[0.75rem] font-medium text-muted-foreground">{l[`detail.${key}`]}</dt>
          <dd className={`text-[1.375rem] leading-tight font-semibold tracking-[-0.02em] tabular-nums ${key === "stat_failed_7d" && n > 0 ? "text-[var(--status-bad)]" : ""}`}>{n}</dd>
        </div>
      ))}
    </dl>
  );
}

function filterWords(where: Filter | undefined, l: Labels): string {
  if (!where) return "";
  return Object.entries(where)
    .map(([path, v]) => {
      if (v === null || typeof v !== "object") return `${path} ${l["editor.op.eq"]} ${String(v)}`;
      return Object.entries(v)
        .map(([op, x]) => `${path} ${l[`editor.op.${op}`] ?? op} ${Array.isArray(x) ? x.join(", ") : String(x)}`)
        .join(", ");
    })
    .join("; ");
}

/** "When booking.confirmed happens, only if data.kind equals event" and its segment and manual forms. */
export function describeTrigger(def: Definition, l: Labels, segmentNames: Record<string, string> = {}): string {
  const t = def.trigger;
  if ("manual" in t) return l["detail.trigger_manual"] ?? "";
  if ("segment_enter" in t) return fill(l["detail.trigger_segment"], { segment: segmentNames[t.segment_enter] ?? t.segment_enter });
  const kinds = (Array.isArray(t.event) ? t.event : [t.event]).join(" / ");
  const base = fill(l["detail.trigger_event"], { kinds });
  const where = filterWords(t.where, l);
  return where ? `${base}, ${fill(l["detail.trigger_where"], { conditions: where })}` : base;
}

/** A step offset in words: "+1 d 2 h after the enrolment", "-7 d from the event date at 10:00". */
export function describeAt(at: At | undefined, l: Labels): string {
  if (!at) return l["editor.at_none"] ?? "";
  const sign = at.minutes < 0 ? "-" : "+";
  const m = Math.abs(at.minutes);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  const parts = [d ? `${d} d` : "", h ? `${h} h` : "", min || (!d && !h) ? `${min} min` : ""].filter(Boolean).join(" ");
  const from = l[`editor.at_${at.from}`] ?? at.from;
  return `${sign}${parts} · ${from}${at.snap_to ? ` · ${at.snap_to}` : ""}`;
}

/** The steps of a definition as a vertical list with type, key and planned offset. */
export function StepList({ steps, l }: { steps: Step[]; l: Labels }) {
  if (steps.length === 0) return <p className="text-sm text-muted-foreground">{l["detail.no_steps"]}</p>;
  return (
    <ol className="grid gap-2" data-testid="automation-steps">
      {steps.map((s, i) => (
        <li key={s.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border p-3" data-step-key={s.key}>
          <span className="text-sm font-semibold tabular-nums">{i + 1}.</span>
          <span className="font-medium">{l[`editor.step_type.${s.type}`] ?? s.type}</span>
          <span className="font-mono text-xs text-muted-foreground">{s.key}</span>
          {s.type === "email" ? <span className="font-mono text-xs">{s.template}</span> : null}
          {s.type === "wait" ? <span className="text-sm">{`${s.minutes} ${l["common.minutes"]}`}</span> : null}
          <span className="ml-auto text-sm text-muted-foreground" data-testid="step-offset">
            {describeAt(s.at, l)}
          </span>
        </li>
      ))}
    </ol>
  );
}
