/**
 * The capacity utilisation report (ops spec 2.4 and 5, ops-P7, R2) over booking's V1 view
 * `v_session_utilisation`; ops defines no capacity view of its own. Sessions whose Brussels
 * date (`day_on`) falls in the range are grouped by session template, ISO weekday, local start
 * hour or month. Counts are sums of the view's columns; `waitlist_peak` is the largest of the
 * group; a group's utilisation is the capacity-weighted mean of the view's `utilisation_pct`
 * (so a group of one session shows exactly that session's figure). Sessions on closed days do
 * not exist, so closures never lower utilisation.
 */
import type { DbOrTx } from "@beam/db";
import { sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { parseDateRange, type DateRange } from "./no-shows";
import type { OpsReadCtx, ReportFilters } from "./registry";

export const CAPACITY_GROUPS = ["template", "weekday", "hour", "month"] as const;
export type CapacityGroupBy = (typeof CAPACITY_GROUPS)[number];

/** The default range: the past 90 and the next 90 days. */
export const CAPACITY_DEFAULT_SPAN = { from: -90, to: 90 } as const;

export type CapacityRow = {
  /** Template id, ISO weekday `1`-`7`, hour `0`-`23` or month `YYYY-MM`; `none` for sessions without a template. */
  key: string;
  /** The template name (template grouping only). */
  name: Record<string, string> | null;
  sessions: number;
  capacity: number;
  held: number;
  bookedTotal: number;
  attended: number;
  noShows: number;
  cancellations: number;
  lateCancellations: number;
  waitlistPeak: number;
  /** Capacity-weighted mean of `utilisation_pct`, one decimal; null when the capacity is 0. */
  utilisationPct: number | null;
};

export type CapacityReport = { range: DateRange; groupBy: CapacityGroupBy; rows: CapacityRow[]; total: Omit<CapacityRow, "key" | "name"> };

export function parseGroupBy(v: string | undefined): CapacityGroupBy {
  return (CAPACITY_GROUPS as readonly string[]).includes(v ?? "") ? (v as CapacityGroupBy) : "template";
}

const KEY: Record<CapacityGroupBy, SQL> = {
  template: sql`coalesce(su.template_id::text, 'none')`,
  weekday: sql`su.weekday::text`,
  hour: sql`extract(hour from su.local_start_time)::int::text`,
  month: sql`to_char(su.day_on, 'YYYY-MM')`,
};
const ORDER: Record<CapacityGroupBy, SQL> = {
  template: sql`min(t.name->>'en') nulls last, 1`,
  weekday: sql`min(su.weekday)`,
  hour: sql`min(extract(hour from su.local_start_time))`,
  month: sql`1`,
};

const FIGURES = sql`count(*)::int as sessions, coalesce(sum(su.capacity), 0)::int as capacity, coalesce(sum(su.held), 0)::int as held,
  coalesce(sum(su.booked_total), 0)::int as booked_total, coalesce(sum(su.attended), 0)::int as attended,
  coalesce(sum(su.no_shows), 0)::int as no_shows, coalesce(sum(su.cancellations), 0)::int as cancellations,
  coalesce(sum(su.late_cancellations), 0)::int as late_cancellations, coalesce(max(su.waitlist_peak), 0)::int as waitlist_peak,
  round(sum(su.utilisation_pct * su.capacity) filter (where su.utilisation_pct is not null)
        / nullif(sum(su.capacity) filter (where su.utilisation_pct is not null), 0), 1)::float8 as utilisation_pct`;

const num = (v: unknown) => Number(v ?? 0);
function figures(r: Record<string, unknown>): Omit<CapacityRow, "key" | "name"> {
  return {
    sessions: num(r.sessions),
    capacity: num(r.capacity),
    held: num(r.held),
    bookedTotal: num(r.booked_total),
    attended: num(r.attended),
    noShows: num(r.no_shows),
    cancellations: num(r.cancellations),
    lateCancellations: num(r.late_cancellations),
    waitlistPeak: num(r.waitlist_peak),
    utilisationPct: r.utilisation_pct === null || r.utilisation_pct === undefined ? null : Number(r.utilisation_pct),
  };
}

/** The report of `range`, grouped by `groupBy`. */
export async function computeCapacityReport(db: DbOrTx, input: { range: DateRange; groupBy: CapacityGroupBy }): Promise<CapacityReport> {
  const { range, groupBy } = input;
  const where = sql`su.day_on >= ${range.from}::date and su.day_on <= ${range.to}::date`;
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select ${KEY[groupBy]} as key, ${groupBy === "template" ? sql`(array_agg(t.name))[1]` : sql`null::jsonb`} as name, ${FIGURES}
      from v_session_utilisation su left join session_templates t on t.id = su.template_id
      where ${where} group by 1 order by ${ORDER[groupBy]}`),
  );
  const [total] = rowsOf<Record<string, unknown>>(await db.execute(sql`select ${FIGURES} from v_session_utilisation su where ${where}`));
  return {
    range,
    groupBy,
    rows: rows.map((r) => ({
      key: String(r.key),
      name: (typeof r.name === "string" ? (JSON.parse(r.name) as Record<string, string>) : (r.name as Record<string, string> | null)) ?? null,
      ...figures(r),
    })),
    total: figures(total ?? {}),
  };
}

export const CAPACITY_CSV_COLUMNS = [
  "group_by",
  "key",
  "name_en",
  "sessions",
  "capacity",
  "held",
  "booked_total",
  "attended",
  "no_shows",
  "cancellations",
  "late_cancellations",
  "waitlist_peak",
  "utilisation_pct",
] as const;

/** The grouped rows of the page, with the page's `from`, `to` and `groupBy`. */
export async function* capacityCsvRows(ctx: OpsReadCtx, filters: ReportFilters): AsyncIterable<unknown[]> {
  const report = await computeCapacityReport(ctx.tx, { range: parseDateRange(filters, ctx.now, CAPACITY_DEFAULT_SPAN), groupBy: parseGroupBy(filters.groupBy) });
  for (const r of report.rows) {
    yield [
      report.groupBy,
      r.key,
      r.name?.en ?? "",
      r.sessions,
      r.capacity,
      r.held,
      r.bookedTotal,
      r.attended,
      r.noShows,
      r.cancellations,
      r.lateCancellations,
      r.waitlistPeak,
      r.utilisationPct ?? "",
    ];
  }
}
