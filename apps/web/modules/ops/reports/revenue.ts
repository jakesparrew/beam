/**
 * The revenue report (ops rules 34 and 35, ops-P3) over `v_revenue_daily`: net revenue for the
 * day, ISO week, month to date and year to date of `at`, each against its previous period; the
 * sales mix by product kind and by channel of the selected period; the daily net line of the
 * last 90 days; and the CSV rows of the selected period. The view already excludes tester
 * persons and counts company orders; refunds are rows of `product_kind = 'refund'`.
 *
 * Net revenue incl. VAT = `gross - refunds`; excl. VAT = `gross - vat - (refunds - refunds_vat)`.
 * Sales (the mix) are `gross` incl. VAT or `gross - vat` excl. VAT, refunds left out.
 */
import type { DbOrTx } from "@beam/db";
import { comparePeriods, periodRange, PERIODS, type Period } from "@beam/core/ops";
import { localDateKey, wallClock } from "@beam/core/platform";
import { sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import type { OpsReadCtx, ReportFilters } from "./registry";

export type VatMode = "incl" | "excl";
export type Comparison = ReturnType<typeof comparePeriods>;
export type TilePeriod = "day" | "week" | "month" | "ytd";
export const TILE_PERIODS: readonly TilePeriod[] = ["day", "week", "month", "ytd"];

/** The product kinds of the sales mix (rule 35), in display order. */
export const SALES_KINDS = ["package", "night", "session", "membership", "item", "ticket", "voucher"] as const;
export const SALES_CHANNELS = ["portal", "site", "admin", "pos", "link", "recurring"] as const;

export type RevenueReport = {
  period: Period;
  vat: VatMode;
  /** Brussels dates, `to` exclusive. */
  range: { from: string; to: string; prevFrom: string; prevTo: string };
  /** Net revenue of the selected period against the previous one. */
  net: Comparison;
  sales: Comparison;
  refunds: Comparison;
  orders: Comparison;
  /** Net revenue of the four standard periods of `at` (rule 34). */
  tiles: Record<TilePeriod, Comparison>;
  byKind: { kind: (typeof SALES_KINDS)[number]; orders: number; amountCents: number }[];
  byChannel: { channel: (typeof SALES_CHANNELS)[number]; orders: number; amountCents: number }[];
  /** One row per Brussels day of the last 90 days up to `at`, zero days included. */
  daily: { day: string; netCents: number }[];
};

/** The Brussels calendar date (`YYYY-MM-DD`) of an instant. */
export const brusselsDate = (d: Date): string => localDateKey(wallClock(d));

type Range = { from: string; to: string };

function dateRanges(period: Period, at: Date): { cur: Range; prev: Range } {
  const r = periodRange(period, at);
  return { cur: { from: brusselsDate(r.from), to: brusselsDate(r.to) }, prev: { from: brusselsDate(r.prevFrom), to: brusselsDate(r.prevTo) } };
}

const netExpr = (vat: VatMode): SQL =>
  vat === "incl" ? sql`(gross_cents - refunds_cents)` : sql`(gross_cents - vat_cents - (refunds_cents - refunds_vat_cents))`;
const salesExpr = (vat: VatMode): SQL => (vat === "incl" ? sql`gross_cents` : sql`(gross_cents - vat_cents)`);
const refundsExpr = (vat: VatMode): SQL => (vat === "incl" ? sql`refunds_cents` : sql`(refunds_cents - refunds_vat_cents)`);
const within = (r: Range): SQL => sql`day_on >= ${r.from}::date and day_on < ${r.to}::date`;
const sumIn = (expr: SQL, r: Range): SQL => sql`coalesce(sum(${expr}) filter (where ${within(r)}), 0)::bigint`;

/** Rule 34 and 35 figures for `period` around `at`, VAT included unless `vat = 'excl'`. */
export async function computeRevenueReport(db: DbOrTx, input: { period: Period; at: Date; vat?: VatMode }): Promise<RevenueReport> {
  const vat = input.vat ?? "incl";
  const sel = dateRanges(input.period, input.at);
  const tiles = TILE_PERIODS.map((p) => [p, dateRanges(p, input.at)] as const);
  const all = [sel.cur, sel.prev, ...tiles.flatMap(([, r]) => [r.cur, r.prev])];
  const lo = all.map((r) => r.from).sort()[0]!;
  const hi = all.map((r) => r.to).sort().at(-1)!;

  const sums = rowsOf<Record<string, string | number>>(
    await db.execute(sql`select
        ${sumIn(netExpr(vat), sel.cur)} as net_cur, ${sumIn(netExpr(vat), sel.prev)} as net_prev,
        ${sumIn(salesExpr(vat), sel.cur)} as sales_cur, ${sumIn(salesExpr(vat), sel.prev)} as sales_prev,
        ${sumIn(refundsExpr(vat), sel.cur)} as refunds_cur, ${sumIn(refundsExpr(vat), sel.prev)} as refunds_prev,
        ${sumIn(sql`orders`, sel.cur)} as orders_cur, ${sumIn(sql`orders`, sel.prev)} as orders_prev,
        ${sql.join(
          tiles.map(([p, r]) => sql`${sumIn(netExpr(vat), r.cur)} as ${sql.raw(`tile_${p}_cur`)}, ${sumIn(netExpr(vat), r.prev)} as ${sql.raw(`tile_${p}_prev`)}`),
          sql`, `,
        )}
      from v_revenue_daily where day_on >= ${lo}::date and day_on < ${hi}::date`),
  )[0]!;
  const n = (k: string) => Number(sums[k] ?? 0);

  const mix = rowsOf<{ channel: string; product_kind: string; orders: string | number; amount: string | number }>(
    await db.execute(sql`select channel::text as channel, product_kind, sum(orders)::bigint as orders, sum(${salesExpr(vat)})::bigint as amount
      from v_revenue_daily where ${within(sel.cur)} and product_kind <> 'refund' group by 1, 2`),
  );
  const byKind = SALES_KINDS.map((kind) => {
    const rows = mix.filter((m) => m.product_kind === kind);
    return { kind, orders: rows.reduce((a, m) => a + Number(m.orders), 0), amountCents: rows.reduce((a, m) => a + Number(m.amount), 0) };
  });
  const byChannel = SALES_CHANNELS.map((channel) => {
    const rows = mix.filter((m) => m.channel === channel);
    return { channel, orders: rows.reduce((a, m) => a + Number(m.orders), 0), amountCents: rows.reduce((a, m) => a + Number(m.amount), 0) };
  });

  const last90 = dateRanges("last_90d", input.at).cur;
  const dailyRows = rowsOf<{ day: string | Date; net: string | number }>(
    await db.execute(sql`select day_on as day, sum(${netExpr(vat)})::bigint as net from v_revenue_daily where ${within(last90)} group by 1`),
  );
  const byDay = new Map(dailyRows.map((d) => [typeof d.day === "string" ? d.day.slice(0, 10) : d.day.toISOString().slice(0, 10), Number(d.net)]));
  const daily: RevenueReport["daily"] = [];
  for (let t = Date.parse(`${last90.from}T12:00:00Z`); ; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (day >= last90.to) break;
    daily.push({ day, netCents: byDay.get(day) ?? 0 });
  }

  return {
    period: input.period,
    vat,
    range: { from: sel.cur.from, to: sel.cur.to, prevFrom: sel.prev.from, prevTo: sel.prev.to },
    net: comparePeriods(n("net_cur"), n("net_prev")),
    sales: comparePeriods(n("sales_cur"), n("sales_prev")),
    refunds: comparePeriods(n("refunds_cur"), n("refunds_prev")),
    orders: comparePeriods(n("orders_cur"), n("orders_prev")),
    tiles: Object.fromEntries(tiles.map(([p]) => [p, comparePeriods(n(`tile_${p}_cur`), n(`tile_${p}_prev`))])) as Record<TilePeriod, Comparison>,
    byKind,
    byChannel,
    daily,
  };
}

/**
 * `?at=YYYY-MM-DD` as noon Brussels of that day (so the day never shifts), else `fallback`.
 * Anything else that is not a valid date falls back too.
 */
export function parseReportAt(value: string | undefined, fallback: Date): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const d = new Date(`${value}T11:00:00Z`);
  return Number.isNaN(d.getTime()) || brusselsDate(d) !== value ? fallback : d;
}

export function parsePeriod(value: string | undefined, fallback: Period = "month"): Period {
  return (PERIODS as readonly string[]).includes(value ?? "") ? (value as Period) : fallback;
}

export const parseVat = (value: string | undefined): VatMode => (value === "excl" ? "excl" : "incl");

export const REVENUE_CSV_COLUMNS = ["day", "channel", "product_kind", "orders", "gross_cents", "vat_cents", "refunds_cents", "refunds_vat_cents", "net_cents"] as const;

/** The `v_revenue_daily` rows of the selected period, one per day, channel and product kind (net per the VAT filter). */
export async function* revenueCsvRows(ctx: OpsReadCtx, filters: ReportFilters): AsyncIterable<unknown[]> {
  const period = parsePeriod(filters.period);
  const vat = parseVat(filters.vat);
  const { cur } = dateRanges(period, parseReportAt(filters.at, ctx.now));
  const rows = rowsOf<Record<string, string | number | Date>>(
    await ctx.tx.execute(sql`select to_char(day_on, 'YYYY-MM-DD') as day, channel::text as channel, product_kind, orders, gross_cents, vat_cents,
        refunds_cents, refunds_vat_cents, ${netExpr(vat)} as net_cents
      from v_revenue_daily where ${within(cur)} order by day_on, channel, product_kind`),
  );
  for (const r of rows) yield REVENUE_CSV_COLUMNS.map((c) => (typeof r[c] === "string" && c !== "day" && c !== "channel" && c !== "product_kind" ? Number(r[c]) : r[c]));
}
