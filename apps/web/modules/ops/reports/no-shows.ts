/**
 * The no-show and cancellation report (ops rule 39, ops-P7, R2) over `v_no_show_report`, for
 * bookings whose session starts in the selected Brussels dates. Tester persons are left out
 * (rule 41). Rows whose session BEAM cancelled (`is_session_cancelled`) are counted apart and
 * never in a customer's figures, rates or pattern.
 *
 * - totals per status (`cancelled`, `late_cancelled`, `no_show`), the no-show rate
 *   `no-shows / (attended + no-shows)`, and the value and credit units forfeited (late
 *   cancellations and no-shows);
 * - per customer: counts, rate, forfeited value and units, and the pattern flag: at least
 *   `no_show_pattern_count` no-shows in the `no_show_pattern_days` before the end of the period;
 * - per session template and per Brussels weekday x hour.
 *
 * This file also holds `parseDateRange`, the `?from=&to=` filter of the R2 reports. It imports
 * only types from `./registry`, which imports its CSV generator.
 */
import type { DbOrTx } from "@beam/db";
import { brusselsDate, RETENTION_DEFAULTS, type RetentionDefaults } from "@beam/core/ops";
import { sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";
import type { OpsReadCtx, ReportFilters } from "./registry";

// ---------------------------------------------------------------------------------------------
// Date ranges of the R2 reports
// ---------------------------------------------------------------------------------------------

/** A report period of Brussels dates, both inclusive (`from <= day <= to`). */
export type DateRange = { from: string; to: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `isoDate` plus `days` (negative for earlier). */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The `?from=&to=` filters as Brussels dates; a missing or invalid bound falls back to today plus
 * `defaults` days (`{ from: -29, to: 0 }` is the last 30 days). `from` after `to` swaps them; the
 * span is capped at `maxDays` days.
 */
export function parseDateRange(filters: { from?: string | undefined; to?: string | undefined }, now: Date, defaults: { from: number; to: number } = { from: -29, to: 0 }, maxDays = 731): DateRange {
  const today = brusselsDate(now);
  const valid = (v: string | undefined) => (v && ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) ? v : undefined);
  let from = valid(filters.from) ?? addDays(today, defaults.from);
  let to = valid(filters.to) ?? addDays(today, defaults.to);
  if (from > to) [from, to] = [to, from];
  if (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`) > maxDays * 86_400_000) from = addDays(to, -maxDays);
  return { from, to };
}

/** `col` within the range: `[from 00:00, to + 1 00:00)` Brussels. */
export function inRange(col: SQL, range: DateRange): SQL {
  return sql`${col} >= (${range.from}::date::timestamp at time zone 'Europe/Brussels') and ${col} < ((${range.to}::date + 1)::timestamp at time zone 'Europe/Brussels')`;
}

/** The end of the range as an instant (start of the next Brussels day). */
export function rangeEnd(range: DateRange): SQL {
  return sql`((${range.to}::date + 1)::timestamp at time zone 'Europe/Brussels')`;
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

export type NoShowCounts = { cancelled: number; lateCancelled: number; noShows: number };

export type NoShowCustomer = NoShowCounts & {
  personId: string;
  name: string | null;
  attended: number;
  /** `noShows / (attended + noShows)`, null when both are 0. */
  rate: number | null;
  valueForfeitedCents: number;
  creditUnitsForfeited: number;
  /** No-shows in the pattern window before the end of the period. */
  recentNoShows: number;
  pattern: boolean;
};

export type NoShowReport = {
  range: DateRange;
  totals: NoShowCounts & { attended: number; rate: number | null; valueForfeitedCents: number; creditUnitsForfeited: number };
  /** Bookings on sessions BEAM cancelled, never counted against a customer. */
  sessionCancelled: { bookings: number; sessions: number };
  pattern: { count: number; days: number };
  customers: NoShowCustomer[];
  byTemplate: (NoShowCounts & { templateId: string | null; name: Record<string, string> | null; valueForfeitedCents: number })[];
  byWeekdayHour: (NoShowCounts & { weekday: number; hour: number })[];
};

/** The customers shown (and in the CSV): patterns first, then by no-shows and late cancellations. */
export const NO_SHOW_CUSTOMER_ROWS = 200;

const num = (v: unknown) => Number(v ?? 0);
const rate = (noShows: number, attended: number) => (noShows + attended > 0 ? Math.round((noShows / (noShows + attended)) * 1000) / 1000 : null);
const counts = (r: { cancelled: unknown; late_cancelled: unknown; no_shows: unknown }): NoShowCounts => ({
  cancelled: num(r.cancelled),
  lateCancelled: num(r.late_cancelled),
  noShows: num(r.no_shows),
});

const COUNT_COLUMNS = sql`count(*) filter (where vn.status = 'cancelled')::int as cancelled,
  count(*) filter (where vn.status = 'late_cancelled')::int as late_cancelled,
  count(*) filter (where vn.status = 'no_show')::int as no_shows,
  coalesce(sum(vn.value_cents) filter (where vn.status in ('late_cancelled', 'no_show')), 0)::int as value_forfeited,
  coalesce(sum(vn.credit_units_forfeited) filter (where vn.status in ('late_cancelled', 'no_show')), 0)::int as units_forfeited`;

/** Rule 39 over the bookings of sessions starting in `range`. */
export async function computeNoShowReport(db: DbOrTx, input: { range: DateRange; now: Date; cfg?: RetentionDefaults }): Promise<NoShowReport> {
  const { range } = input;
  const cfg = input.cfg ?? RETENTION_DEFAULTS;
  const customerRows = sql`v_no_show_report vn join persons pe on pe.id = vn.person_id
    where pe.is_tester = false and not vn.is_session_cancelled and ${inRange(sql`vn.starts_at`, range)}`;
  const attendedIn = sql`select b.person_id, count(*)::int as attended from bookings b join sessions s on s.id = b.session_id
    join persons pe on pe.id = b.person_id
    where b.status = 'attended' and s.status <> 'cancelled' and pe.is_tester = false and ${inRange(sql`s.starts_at`, range)} group by b.person_id`;
  const ref = sql`least(${rangeEnd(range)}, ${input.now.toISOString()}::timestamptz)`;

  const [total] = rowsOf<Record<string, unknown>>(await db.execute(sql`select ${COUNT_COLUMNS} from ${customerRows}`));
  const [attendedTotal] = rowsOf<{ n: unknown }>(await db.execute(sql`select coalesce(sum(a.attended), 0)::int as n from (${attendedIn}) a`));
  const [cancelledByBeam] = rowsOf<{ bookings: unknown; sessions: unknown }>(
    await db.execute(sql`select count(*)::int as bookings, count(distinct vn.session_id)::int as sessions
      from v_no_show_report vn join persons pe on pe.id = vn.person_id
      where pe.is_tester = false and vn.is_session_cancelled and ${inRange(sql`vn.starts_at`, range)}`),
  );

  const people = rowsOf<Record<string, unknown>>(
    await db.execute(sql`with c as (select vn.person_id, ${COUNT_COLUMNS} from ${customerRows} group by vn.person_id),
        a as (${attendedIn}),
        recent as (select vn.person_id, count(*)::int as n from v_no_show_report vn
                   where vn.status = 'no_show' and not vn.is_session_cancelled and vn.person_id in (select person_id from c)
                     and vn.starts_at <= ${ref} and vn.starts_at > ${ref} - make_interval(days => ${cfg.no_show_pattern_days}::int)
                   group by vn.person_id)
      select c.*, coalesce(a.attended, 0)::int as attended, coalesce(recent.n, 0)::int as recent,
             nullif(trim(concat_ws(' ', pe.first_name, pe.last_name)), '') as name
      from c join persons pe on pe.id = c.person_id left join a on a.person_id = c.person_id left join recent on recent.person_id = c.person_id
      order by (coalesce(recent.n, 0) >= ${cfg.no_show_pattern_count}::int) desc, c.no_shows desc, c.late_cancelled desc, c.cancelled desc, c.person_id
      limit ${NO_SHOW_CUSTOMER_ROWS}`),
  );

  const templates = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select vn.template_id, t.name, ${COUNT_COLUMNS}
      from v_no_show_report vn join persons pe on pe.id = vn.person_id left join session_templates t on t.id = vn.template_id
      where pe.is_tester = false and not vn.is_session_cancelled and ${inRange(sql`vn.starts_at`, range)}
      group by vn.template_id, t.name order by count(*) desc, vn.template_id nulls last`),
  );

  const grid = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select vn.weekday, vn.hour, ${COUNT_COLUMNS} from ${customerRows} group by vn.weekday, vn.hour order by vn.weekday, vn.hour`),
  );

  const attended = num(attendedTotal?.n);
  const totalCounts = counts(total as never);
  return {
    range,
    totals: { ...totalCounts, attended, rate: rate(totalCounts.noShows, attended), valueForfeitedCents: num(total?.value_forfeited), creditUnitsForfeited: num(total?.units_forfeited) },
    sessionCancelled: { bookings: num(cancelledByBeam?.bookings), sessions: num(cancelledByBeam?.sessions) },
    pattern: { count: cfg.no_show_pattern_count, days: cfg.no_show_pattern_days },
    customers: people.map((r) => {
      const c = counts(r as never);
      return {
        personId: String(r.person_id),
        name: (r.name as string | null) ?? null,
        ...c,
        attended: num(r.attended),
        rate: rate(c.noShows, num(r.attended)),
        valueForfeitedCents: num(r.value_forfeited),
        creditUnitsForfeited: num(r.units_forfeited),
        recentNoShows: num(r.recent),
        pattern: num(r.recent) >= cfg.no_show_pattern_count,
      };
    }),
    byTemplate: templates.map((r) => ({
      templateId: (r.template_id as string | null) ?? null,
      name: (typeof r.name === "string" ? (JSON.parse(r.name) as Record<string, string>) : (r.name as Record<string, string> | null)) ?? null,
      ...counts(r as never),
      valueForfeitedCents: num(r.value_forfeited),
    })),
    byWeekdayHour: grid.map((r) => ({ weekday: num(r.weekday), hour: num(r.hour), ...counts(r as never) })),
  };
}

export const NO_SHOW_CSV_COLUMNS = [
  "person_id",
  "cancelled",
  "late_cancelled",
  "no_shows",
  "attended",
  "no_show_rate",
  "value_forfeited_cents",
  "credit_units_forfeited",
  "recent_no_shows",
  "pattern",
] as const;

/** The per-customer table of the page, with the page's `from` and `to`. */
export async function* noShowCsvRows(ctx: OpsReadCtx, filters: ReportFilters): AsyncIterable<unknown[]> {
  let cfg = RETENTION_DEFAULTS;
  try {
    cfg = await getSetting(ctx.tx, "retention_defaults");
  } catch {
    // the registry default applies when the setting cannot be read (as on the page)
  }
  const report = await computeNoShowReport(ctx.tx, { range: parseDateRange(filters, ctx.now), now: ctx.now, cfg });
  for (const c of report.customers) {
    yield [c.personId, c.cancelled, c.lateCancelled, c.noShows, c.attended, c.rate ?? "", c.valueForfeitedCents, c.creditUnitsForfeited, c.recentNoShows, c.pattern];
  }
}
