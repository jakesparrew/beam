/**
 * Custom dashboard widget sources of forms (forms spec section 12, forms-P10, R4): `forms.funnel`,
 * `forms.outcomes` and `forms.conversion`. Each source reads aggregates only: the funnel and the
 * outcomes come from the non-sensitive `ai` views (`ai.form_funnel_daily`, `ai.form_outcomes`, with
 * rare outcomes merged into `other`), the conversions are counts and sums of `v_form_conversions`.
 * No answer, score, person id or contact field leaves this file.
 *
 * Range semantics follow `getFormReport`: `from` and `to` are Brussels days, both inclusive, and a
 * submission counts on the Brussels day it started (the report's cohort), so for one form the
 * totals of a source equal the report's totals over the same days. Without `formId` a source sums
 * every form.
 *
 * Reading needs `reports.read` (`permission`); the caller (ops' custom dashboards, R4) checks it
 * before `loadFormsDashboardSource`, like every query here that takes a `db`.
 */
import type { DbOrTx } from "@beam/db";
import { aiFormFunnelDaily, aiFormOutcomes } from "@beam/db/schema";
import { and, asc, desc, eq, gte, lte, sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

export const FORMS_DASHBOARD_SOURCE_KEYS = ["forms.funnel", "forms.outcomes", "forms.conversion"] as const;
export type FormsDashboardSourceKey = (typeof FORMS_DASHBOARD_SOURCE_KEYS)[number];

export type FormsDashboardViz = "number" | "line" | "bar" | "table";

/** Brussels days `YYYY-MM-DD`, both inclusive (as `getFormReport`); `formId` null or absent = every form. */
export type FormsDashboardRange = { from: string; to: string; formId?: string | null };

export type FunnelCounts = { views: number; started: number; engaged: number; completed: number; abandoned: number };

export type FormsFunnelValue = {
  totals: FunnelCounts & { completionRate: number | null };
  /** One point per Brussels day of the range, zeros included. */
  series: (FunnelCounts & { day: string })[];
};

export type FormsOutcomesValue = {
  completed: number;
  /** `key` null = completed without an outcome; `label` is a catalogue key for null, else the raw key. */
  rows: { key: string | null; label: string; count: number; share: number }[];
};

export type ConversionCounts = { linked: number; booked: number; purchased: number; revenueCents: number };

export type FormsConversionValue = {
  totals: ConversionCounts & { bookingRate: number | null; purchaseRate: number | null };
  series: (ConversionCounts & { day: string })[];
};

export type FormsDashboardValues = {
  "forms.funnel": FormsFunnelValue;
  "forms.outcomes": FormsOutcomesValue;
  "forms.conversion": FormsConversionValue;
};

export type FormsDashboardSource<K extends FormsDashboardSourceKey> = {
  key: K;
  /** Catalogue key of the widget title (forms' report titles). */
  label: string;
  unit: "count" | "cents";
  views: FormsDashboardViz[];
  permission: "reports.read";
  load: (db: DbOrTx, range: FormsDashboardRange) => Promise<FormsDashboardValues[K]>;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Longest range a widget may ask for (two years and a day). */
export const MAX_DASHBOARD_RANGE_DAYS = 732;

const dayIndex = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;

/** Every calendar day from `from` to `to` (pure date arithmetic, no time zone involved). */
function daysOf(from: string, to: string): string[] {
  const out: string[] = [];
  const pad = (v: number) => String(v).padStart(2, "0");
  for (let i = dayIndex(from); i <= dayIndex(to); i++) {
    const d = new Date(i * 86_400_000);
    out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  return out;
}

function checkRange(range: FormsDashboardRange): void {
  const { from, to } = range;
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || Number.isNaN(dayIndex(from)) || Number.isNaN(dayIndex(to))) throw new TypeError("invalid_range");
  const span = dayIndex(to) - dayIndex(from);
  if (span < 0 || span >= MAX_DASHBOARD_RANGE_DAYS) throw new TypeError("invalid_range");
}

const rate = (a: number, b: number): number | null => (b ? a / b : null);
const n = (v: unknown) => Number(v ?? 0);

async function loadFunnel(db: DbOrTx, range: FormsDashboardRange): Promise<FormsFunnelValue> {
  checkRange(range);
  const v = aiFormFunnelDaily;
  const rows = await db
    .select({
      day: v.dayOn,
      views: sql<number>`coalesce(sum(${v.views}), 0)::int`,
      started: sql<number>`coalesce(sum(${v.started}), 0)::int`,
      engaged: sql<number>`coalesce(sum(${v.engaged}), 0)::int`,
      completed: sql<number>`coalesce(sum(${v.completed}), 0)::int`,
      abandoned: sql<number>`coalesce(sum(${v.abandoned}), 0)::int`,
    })
    .from(v)
    .where(and(gte(v.dayOn, range.from), lte(v.dayOn, range.to), range.formId ? eq(v.formId, range.formId) : undefined))
    .groupBy(v.dayOn)
    .orderBy(asc(v.dayOn));
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const series = daysOf(range.from, range.to).map((day) => {
    const r = byDay.get(day);
    return { day, views: n(r?.views), started: n(r?.started), engaged: n(r?.engaged), completed: n(r?.completed), abandoned: n(r?.abandoned) };
  });
  const sum = (f: (p: FunnelCounts) => number) => series.reduce((acc, p) => acc + f(p), 0);
  const totals = { views: sum((p) => p.views), started: sum((p) => p.started), engaged: sum((p) => p.engaged), completed: sum((p) => p.completed), abandoned: sum((p) => p.abandoned) };
  return { totals: { ...totals, completionRate: rate(totals.completed, totals.started) }, series };
}

async function loadOutcomes(db: DbOrTx, range: FormsDashboardRange): Promise<FormsOutcomesValue> {
  checkRange(range);
  const o = aiFormOutcomes;
  const count = sql<number>`coalesce(sum(${o.completions}), 0)::int`;
  const rows = await db
    .select({ key: o.outcomeKey, count })
    .from(o)
    .where(and(gte(o.dayOn, range.from), lte(o.dayOn, range.to), range.formId ? eq(o.formId, range.formId) : undefined))
    .groupBy(o.outcomeKey)
    .orderBy(desc(count), asc(o.outcomeKey));
  const completed = rows.reduce((acc, r) => acc + n(r.count), 0);
  return {
    completed,
    rows: rows.map((r) => ({ key: r.key, label: r.key ?? "forms.report.no_outcome", count: n(r.count), share: completed ? n(r.count) / completed : 0 })),
  };
}

async function loadConversion(db: DbOrTx, range: FormsDashboardRange): Promise<FormsConversionValue> {
  checkRange(range);
  const day: SQL = sql`(s.started_at at time zone 'Europe/Brussels')::date`;
  const rows = rowsOf<{ day: string; linked: number; booked: number; purchased: number; revenue: string | number }>(
    await db.execute(sql`
      select to_char(${day}, 'YYYY-MM-DD') as day,
             count(*)::int as linked,
             count(c.first_booking_at)::int as booked,
             count(c.first_paid_at)::int as purchased,
             coalesce(sum(c.revenue_30d_cents), 0)::bigint as revenue
      from v_form_conversions c join form_submissions s on s.id = c.submission_id
      where ${day} >= ${range.from}::date and ${day} <= ${range.to}::date
        ${range.formId ? sql`and s.form_id = ${range.formId}` : sql``}
      group by 1 order by 1`),
  );
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const series = daysOf(range.from, range.to).map((d) => {
    const r = byDay.get(d);
    return { day: d, linked: n(r?.linked), booked: n(r?.booked), purchased: n(r?.purchased), revenueCents: n(r?.revenue) };
  });
  const sum = (f: (p: ConversionCounts) => number) => series.reduce((acc, p) => acc + f(p), 0);
  const totals = { linked: sum((p) => p.linked), booked: sum((p) => p.booked), purchased: sum((p) => p.purchased), revenueCents: sum((p) => p.revenueCents) };
  return { totals: { ...totals, bookingRate: rate(totals.booked, totals.linked), purchaseRate: rate(totals.purchased, totals.linked) }, series };
}

/** The three widget sources, keyed by their widget source key. */
export const FORMS_DASHBOARD_SOURCES: { readonly [K in FormsDashboardSourceKey]: FormsDashboardSource<K> } = {
  "forms.funnel": { key: "forms.funnel", label: "forms.report.funnel_title", unit: "count", views: ["number", "line", "bar", "table"], permission: "reports.read", load: loadFunnel },
  "forms.outcomes": { key: "forms.outcomes", label: "forms.report.outcomes_title", unit: "count", views: ["table", "bar"], permission: "reports.read", load: loadOutcomes },
  "forms.conversion": { key: "forms.conversion", label: "forms.report.conversions_title", unit: "count", views: ["number", "line", "bar", "table"], permission: "reports.read", load: loadConversion },
};

export function isFormsDashboardSourceKey(value: unknown): value is FormsDashboardSourceKey {
  return typeof value === "string" && (FORMS_DASHBOARD_SOURCE_KEYS as readonly string[]).includes(value);
}

/** Loads one widget source (`reports.read`, checked by the caller). */
export function loadFormsDashboardSource<K extends FormsDashboardSourceKey>(db: DbOrTx, key: K, range: FormsDashboardRange): Promise<FormsDashboardValues[K]> {
  if (!isFormsDashboardSourceKey(key)) throw new TypeError("unknown_source");
  return FORMS_DASHBOARD_SOURCES[key].load(db, range) as Promise<FormsDashboardValues[K]>;
}
