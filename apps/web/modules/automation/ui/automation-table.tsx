/**
 * Server-rendered pieces of the automation screens (automation spec 5): the list table with its
 * filter form (a plain GET form, so it works without JavaScript), the detail header with the
 * section tabs, the stats tiles and the plain-words summaries of a trigger and a step offset.
 * Every string comes from the `automation` catalogue through `labels`; times are Europe/Brussels.
 */
import Link from "next/link";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDateTime, type Locale } from "@beam/core/i18n";
import { AUTOMATION_CATEGORIES, type AutomationCategory, type At, type Definition, type Filter, type Step } from "@beam/core/automation";
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

const STATUSES = ["draft", "active", "paused", "archived"] as const;

/** Status, group and search filters of the list (GET `/admin/automations?status=&group=&q=`). */
export function AutomationFilters({
  l,
  groups,
  value,
}: {
  l: Labels;
  groups: { key: string; name: string }[];
  value: { status?: string; group?: string; q?: string; category?: string };
}) {
  const selectClass = "h-9 rounded-md border border-input bg-background px-3 text-sm";
  return (
    <form data-auto-filter="" method="get" action="/admin/automations" className="flex flex-wrap items-end gap-3" data-testid="automation-filters">
      {value.category ? <input type="hidden" name="category" value={value.category} /> : null}
      <div className="grid gap-1">
        <Label htmlFor="automation-filter-status">{l["list.filter_status"]}</Label>
        <select id="automation-filter-status" name="status" defaultValue={value.status ?? ""} className={selectClass}>
          <option value="">{l["common.all"]}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {l[`status.${s}`]}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="automation-filter-group">{l["list.filter_group"]}</Label>
        <select id="automation-filter-group" name="group" defaultValue={value.group ?? ""} className={selectClass}>
          <option value="">{l["common.all"]}</option>
          {groups.map((g) => (
            <option key={g.key} value={g.key}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="automation-filter-q">{l["list.search"]}</Label>
        <Input id="automation-filter-q" name="q" defaultValue={value.q ?? ""} placeholder={l["list.search_placeholder"]} className="w-56" />
      </div>
    </form>
  );
}

/**
 * The categories as tabs with their counts (owner's review, section 10): a link per category keeps
 * the other filters; "All" lists every category, grouped under a heading row.
 */
export function CategoryTabs({ l, counts, current, query }: { l: Labels; counts: Record<AutomationCategory, number>; current?: AutomationCategory; query: Record<string, string | undefined> }) {
  const href = (category?: AutomationCategory) => {
    const entries: [string, string | undefined][] = Object.entries({ ...query, category });
    const q = new URLSearchParams(entries.filter((e): e is [string, string] => !!e[1]));
    const s = q.toString();
    return s ? `/admin/automations?${s}` : "/admin/automations";
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const tabs: { key?: AutomationCategory; label: string; count: number }[] = [
    { label: l["list.category_all"] ?? "", count: total },
    ...AUTOMATION_CATEGORIES.filter((c) => counts[c] > 0 || c === current).map((c) => ({ key: c, label: l[`list.category.${c}`] ?? c, count: counts[c] })),
  ];
  return (
    <nav aria-label={l["list.categories"]} className="flex flex-wrap gap-2" data-testid="automation-categories">
      {tabs.map((t) => (
        <Link
          key={t.key ?? "all"}
          href={href(t.key) as never}
          aria-current={t.key === current ? "page" : undefined}
          data-category={t.key ?? "all"}
          className={`rounded-full border px-3 py-1 text-sm ${t.key === current ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"}`}
        >
          {t.label} <span className="tabular-nums opacity-80">{t.count}</span>
        </Link>
      ))}
    </nav>
  );
}

/** The list: name, slug, group (exclusive badge), status, version, counts of the last 7 days, last run; grouped by category when `grouped`. */
export function AutomationTable({ rows, l, locale, emptyAction, filtered, grouped }: { rows: AutomationTableRow[]; l: Labels; locale: Locale; emptyAction?: React.ReactNode; filtered: boolean; grouped?: boolean }) {
  const ordered = grouped ? AUTOMATION_CATEGORIES.flatMap((c) => rows.filter((r) => r.category === c)) : rows;
  if (rows.length === 0) return <EmptyState title={filtered ? l["list.empty_filtered"] : l["list.empty"]} action={filtered ? undefined : emptyAction} />;
  return (
    <Table data-testid="automation-table">
      <TableHeader>
        <TableRow>
          <TableHead>{l["list.col_name"]}</TableHead>
          <TableHead>{l["list.col_slug"]}</TableHead>
          <TableHead>{l["list.col_group"]}</TableHead>
          <TableHead>{l["list.col_status"]}</TableHead>
          <TableHead>{l["list.col_version"]}</TableHead>
          <TableHead className="text-right">{l["list.col_active"]}</TableHead>
          <TableHead className="text-right">{l["list.col_entered_7d"]}</TableHead>
          <TableHead className="text-right">{l["list.col_sent_7d"]}</TableHead>
          <TableHead className="text-right">{l["list.col_skipped_7d"]}</TableHead>
          <TableHead className="text-right">{l["list.col_failed_7d"]}</TableHead>
          <TableHead>{l["list.col_last_run"]}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.map((r, i) => [
          grouped && r.category !== ordered[i - 1]?.category ? (
            <TableRow key={`category-${r.category}`} data-category-heading={r.category} className="bg-muted/40 hover:bg-muted/40">
              <TableCell colSpan={11} className="font-semibold">
                {l[`list.category.${r.category}`] ?? r.category}
              </TableCell>
            </TableRow>
          ) : null,
          <TableRow key={r.id} data-slug={r.slug}>
            <TableCell>
              <Link className="font-medium underline-offset-2 hover:underline" href={`/admin/automations/${r.id}`}>
                {r.name}
              </Link>
            </TableCell>
            <TableCell className="font-mono text-xs">{r.slug}</TableCell>
            <TableCell>
              {r.groupName}
              {r.groupIsExclusive ? (
                <Badge variant="outline" className="ml-2">
                  {l["list.exclusive"]}
                </Badge>
              ) : null}
            </TableCell>
            <TableCell>
              <AutomationStatusBadge status={r.status} label={l[`status.${r.status}`] ?? r.status} />
            </TableCell>
            <TableCell>{r.currentVersion ? fill(l["list.version_n"], { version: r.currentVersion }) : l["list.no_version"]}</TableCell>
            <TableCell className="text-right tabular-nums">{r.activeCount}</TableCell>
            <TableCell className="text-right tabular-nums">{r.entered7d}</TableCell>
            <TableCell className="text-right tabular-nums">{r.sent7d}</TableCell>
            <TableCell className="text-right tabular-nums">{r.skipped7d}</TableCell>
            <TableCell className={`text-right tabular-nums ${r.failed7d > 0 ? "font-semibold text-destructive" : ""}`} data-failed={r.failed7d > 0 ? "true" : undefined}>
              {r.failed7d}
            </TableCell>
            <TableCell>{r.lastRunAt ? formatDateTime(r.lastRunAt, locale) : l["list.never"]}</TableCell>
          </TableRow>,
        ])}
      </TableBody>
    </Table>
  );
}

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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <Link href="/admin/automations" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
            {l["common.back"]}
          </Link>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold">
            {name}
            <AutomationStatusBadge status={status} label={l[`status.${status}`] ?? status} />
          </h1>
          <p className="font-mono text-xs text-muted-foreground">{slug}</p>
        </div>
        {actions}
      </div>
      <nav aria-label={l["detail.tabs_label"]} className="flex flex-wrap gap-1 border-b">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href as never}
            aria-current={t.key === current ? "page" : undefined}
            className={`rounded-t-md px-3 py-2 text-sm ${t.key === current ? "border-b-2 border-primary font-semibold" : "text-muted-foreground hover:text-foreground"}`}
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
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7" data-testid="automation-stats">
      {tiles.map(([key, n]) => (
        <Card key={key} className="py-3">
          <CardHeader className="px-4">
            <CardTitle>
              <dt className="text-xs font-medium text-muted-foreground">{l[`detail.${key}`]}</dt>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <dd className={`text-2xl font-semibold tabular-nums ${key === "stat_failed_7d" && n > 0 ? "text-destructive" : ""}`}>{n}</dd>
          </CardContent>
        </Card>
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
