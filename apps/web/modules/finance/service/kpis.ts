/**
 * `getFinanceKpis` (finance-P10, R4): the finance numbers ops' custom dashboards, weekly summary
 * and NL questions read through finance's api.ts. Every figure uses the same views, predicates
 * and Brussels days as the finance dashboard (`getFinanceDashboard`, finance-P8) and the deferred
 * revenue page (finance-P9), so a KPI equals the dashboard for the same period
 * (`finance-p10.kpis.test.ts` proves it), but without the series and tables the screens need.
 *
 * Period KPIs are sums over the Brussels days `from..to`. End-of-period KPIs are the state at the
 * end of `to`, capped at now: open invoices come from `v_finance_open_invoices` when the period
 * reaches today (the dashboard's "now"), and are rebuilt from issue, payment and credit-note
 * dates for an earlier day; active memberships use the dashboard's "live at" rule; deferred
 * revenue is `getDeferredRevenue({ asOf: to })` net of VAT. Breakage follows its source view's
 * grain: the Brussels months the period touches (`getBreakage`). Ids and amounts only; no
 * person column is read.
 */
import type { DbOrTx } from "@beam/db";
import { assembleFinanceKpis, brusselsDateOf, financeKpiPeriods, type DateRange, type FinanceKpis, type FinanceKpiValues } from "@beam/core/finance";
import { sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { endOfDayBrussels, getBreakage, getDeferredRevenue } from "./deferred";

const NOT_VOUCHER = sql`category is distinct from 'voucher'`;
const toNum = (v: unknown) => Number(v ?? 0);
const inRange = (r: DateRange, column: SQL = sql`day`) => sql`${column} >= ${r.from}::date and ${column} <= ${r.to}::date`;

/** `sum(expr) filter (where <range> and cond)` for the current (`_c`) and previous (`_p`) period. */
function sums(name: string, expr: SQL, ranges: readonly [DateRange, DateRange], cond: SQL = sql`true`, column: SQL = sql`day`): SQL {
  return sql.join(
    ranges.map((r, i) => sql`coalesce(sum(${expr}) filter (where ${inRange(r, column)} and ${cond}), 0)::bigint as ${sql.raw(`${name}_${"cp"[i]}`)}`),
    sql`, `,
  );
}

/** Both spans' outer bounds, so each view is scanned once. */
const spanOf = (ranges: readonly [DateRange, DateRange], column: SQL = sql`day`) =>
  sql`${column} >= ${ranges[1].from}::date and ${column} <= ${ranges[0].to}::date`;

type Partial2 = { c: Partial<FinanceKpiValues>; p: Partial<FinanceKpiValues> };

function put(out: Partial2, key: keyof FinanceKpiValues, row: Record<string, unknown> | undefined, name: string): void {
  out.c[key] = toNum(row?.[`${name}_c`]);
  out.p[key] = toNum(row?.[`${name}_p`]);
}

async function periodSums(db: DbOrTx, ranges: readonly [DateRange, DateRange], out: Partial2): Promise<void> {
  const [rev] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select ${sums("rev", sql`net_cents`, ranges, NOT_VOUCHER)}, ${sums("vat", sql`vat_cents`, ranges)},
        ${sums("ref", sql`-net_cents`, ranges, sql`kind = 'credit_note' and ${NOT_VOUCHER}`)}
      from v_finance_revenue_daily where ${spanOf(ranges)}`),
  );
  put(out, "netRevenueCents", rev, "rev");
  put(out, "vatCents", rev, "vat");
  put(out, "refundsCents", rev, "ref");

  const [cash] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select ${sums("cin", sql`inflow_cents`, ranges)} from v_finance_cash_inflow_daily where ${spanOf(ranges)}`),
  );
  put(out, "cashInCents", cash, "cin");

  const [failed] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select ${sums("fail", sql`failed_count`, ranges)} from v_finance_failed_payments where ${spanOf(ranges)}`),
  );
  put(out, "failedPaymentsCount", failed, "fail");

  const issuedOn = sql`i.issued_on`;
  const [recurring] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select ${sums("rec", sql`i.subtotal_cents`, ranges, sql`true`, issuedOn)}
      from invoices i join orders o on o.id = i.order_id where o.channel = 'recurring' and ${spanOf(ranges, issuedOn)}`),
  );
  put(out, "recurringRevenueCents", recurring, "rec");
}

/** Memberships live at the end of `r` (capped at now): started, not pending, not ended (the dashboard's rule). */
async function activeMemberships(db: DbOrTx, ranges: readonly [DateRange, DateRange], now: Date, out: Partial2): Promise<void> {
  const liveAt = (r: DateRange, name: string) => {
    const at = sql`least(${now.toISOString()}::timestamptz, ((${r.to}::date + 1)::timestamp at time zone 'Europe/Brussels'))`;
    return sql`(count(*) filter (where m.started_at < ${at} and (m.ended_at is null or m.ended_at >= ${at})))::int as ${sql.raw(name)}`;
  };
  const [row] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select ${liveAt(ranges[0], "mem_c")}, ${liveAt(ranges[1], "mem_p")} from memberships m where m.status <> 'pending'`),
  );
  put(out, "activeMemberships", row, "mem");
}

type OpenState = { count: number; cents: number; overdueCents: number };

/**
 * Open bank-transfer invoices at the end of Brussels day `day`. From today on this is
 * `v_finance_open_invoices` itself. For an earlier day: invoices issued by then that were still
 * unpaid at its end (open now, paid later, or cancelled later while unpaid), owing their total
 * minus the credit notes issued by then; overdue when the due date lies before that day.
 */
async function openAt(db: DbOrTx, day: string, today: string): Promise<OpenState> {
  if (day >= today) {
    const [row] = rowsOf<{ n: number; cents: number; overdue_cents: number }>(
      await db.execute(sql`select count(*)::int as n, coalesce(sum(amount_due_cents), 0)::bigint as cents,
          coalesce(sum(amount_due_cents) filter (where days_overdue > 0), 0)::bigint as overdue_cents
        from v_finance_open_invoices`),
    );
    return { count: toNum(row?.n), cents: toNum(row?.cents), overdueCents: toNum(row?.overdue_cents) };
  }
  const end = endOfDayBrussels(day).toISOString();
  const [row] = rowsOf<{ n: number; cents: number; overdue_cents: number }>(
    await db.execute(sql`with docs as (
        select i.status, i.due_on,
          (i.total_cents + coalesce((select sum(cn.total_cents) from invoices cn
            where cn.reverses_invoice_id = i.id and cn.kind = 'credit_note' and cn.issued_on <= ${day}::date), 0)) as due
        from invoices i
        where i.kind = 'invoice' and i.issued_on <= ${day}::date
          and (i.status = 'open' or (i.paid_at is not null and i.paid_at > ${end}::timestamptz) or (i.status = 'cancelled' and i.paid_at is null))
      ), owed as (select * from docs where status = 'open' or due > 0)
      select count(*)::int as n, coalesce(sum(due), 0)::bigint as cents,
        coalesce(sum(due) filter (where due_on < ${day}::date), 0)::bigint as overdue_cents
      from owed`),
  );
  return { count: toNum(row?.n), cents: toNum(row?.cents), overdueCents: toNum(row?.overdue_cents) };
}

async function endOfPeriodState(db: DbOrTx, ranges: readonly [DateRange, DateRange], now: Date, out: Partial2): Promise<void> {
  const today = brusselsDateOf(now);
  const targets = [out.c, out.p] as const;
  for (const [i, r] of ranges.entries()) {
    const target = targets[i]!;
    const open = await openAt(db, r.to, today);
    target.openInvoicesCount = open.count;
    target.openInvoicesCents = open.cents;
    target.overdueCents = open.overdueCents;
    target.deferredRevenueCents = (await getDeferredRevenue(db, { asOf: r.to, now })).total.netCents;
    target.breakageCents = (await getBreakage(db, r)).reduce((s, row) => s + row.breakage.netCents, 0);
  }
}

/**
 * Finance KPIs for the Brussels days `from..to` (both included) and the equal-length period right
 * before. Throws a `RangeError` for invalid dates, a period that ends before it starts or one
 * longer than 731 days (the dashboard's custom-period rules). `now` is for tests.
 */
export async function getFinanceKpis(db: DbOrTx, input: { from: string; to: string }, now: Date = new Date()): Promise<FinanceKpis> {
  const { current, previous } = financeKpiPeriods(input);
  const ranges = [current, previous] as const;
  const out: Partial2 = { c: {}, p: {} };
  await periodSums(db, ranges, out);
  await activeMemberships(db, ranges, now, out);
  await endOfPeriodState(db, ranges, now, out);
  return assembleFinanceKpis(out.c, out.p);
}
