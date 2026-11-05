/**
 * Deferred revenue, breakage and euro voucher redemptions (finance spec rule 43, section 2.9,
 * finance-P9, R3). Finance computes no balance: every figure comes from credits' views and
 * function made for exactly this (credits rules 65, 66, cross-module D29):
 *
 * - Deferred revenue at day D: `v_credit_liability` when D is today (or later), else
 *   `credits.getCreditLiabilityAsOf(db, endOfDayBrussels(D))` (23:59:59.999 Brussels). The value is
 *   the remaining units times the unit value sold, VAT included; finance splits it into net and
 *   VAT per row with `computeLineVat` at the row's rate. `multi_purpose` rows (euro vouchers) are
 *   split at 0 %, because their VAT is charged on the sale they pay; a row without a rate too.
 * - Recognised, breakage and revoked value per Brussels month from `v_credit_movements_monthly`:
 *   recognised = `-(consume + release)`, breakage = `-expire`, revoked = `-revoke` (a refund
 *   reversed it and the credit note already carries it, so it is no breakage).
 * - Euro voucher redemptions from `v_euro_voucher_redemptions`, with the invoice of the order they
 *   paid; no person column is returned.
 */
import type { DbOrTx } from "@beam/db";
import { brusselsDateOf, computeLineVat, toVatRate } from "@beam/core/finance";
import { sql, ValidationError, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { getCreditLiabilityAsOf } from "@/modules/credits/api";

export type Money3 = { grossCents: number; netCents: number; vatCents: number };
export type DeferredCreditKind = "day" | "night" | "euro";
export const DEFERRED_CREDIT_KINDS: readonly DeferredCreditKind[] = ["day", "night", "euro"];

export type DeferredRateRow = { creditKind: DeferredCreditKind; vatTreatment: string; vatRatePct: number | null; units: number } & Money3;
export type DeferredRevenue = {
  total: Money3;
  byKind: Record<DeferredCreditKind, Money3>;
  byRate: DeferredRateRow[];
  /** The Brussels day the figures are for (a future day reads as today). */
  asOf: string;
  /** `today`: `v_credit_liability`; `as_of`: `getCreditLiabilityAsOf` at the end of `asOf`. */
  source: "today" | "as_of";
};

export type BreakageRow = {
  /** First day of the Brussels month (`YYYY-MM-01`). */
  month: string;
  creditKind: DeferredCreditKind;
  vatRatePct: number | null;
  recognised: Money3;
  breakage: Money3;
  revoked: Money3;
};

export type VoucherRedemptionRow = { redeemedOn: string; orderId: string; invoiceNumber: string | null; amountCents: number; isReversed: boolean };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ZERO = (): Money3 => ({ grossCents: 0, netCents: 0, vatCents: 0 });
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** The calendar day of a UTC-midnight date that stands for a plain day (never a wall-clock instant). */
const utcDay = (d: Date) => `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** A valid ISO day, else `validation` with `finance.errors.period_invalid`. */
function assertDay(value: string, field: string): void {
  if (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || utcDay(new Date(`${value}T00:00:00Z`)) !== value) {
    throw new ValidationError("finance.errors.period_invalid", { [field]: "finance.errors.period_invalid" });
  }
}

function assertPeriod(from: string, to: string): void {
  assertDay(from, "from");
  assertDay(to, "to");
  if (to < from) throw new ValidationError("finance.errors.period_invalid", { to: "finance.errors.period_invalid" });
}

/** Minutes Brussels is ahead of UTC at `at` (60 in winter, 120 in summer). */
function brusselsOffsetMinutes(at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Brussels", timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "");
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** 00:00 Brussels of day `day` (`YYYY-MM-DD`) as an instant. */
export function startOfDayBrussels(day: string): Date {
  assertDay(day, "day");
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  let t = utcMidnight - brusselsOffsetMinutes(new Date(utcMidnight)) * 60_000;
  const second = utcMidnight - brusselsOffsetMinutes(new Date(t)) * 60_000;
  if (second !== t) t = second;
  return new Date(t);
}

/** The ISO day after `day`. */
export function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return utcDay(d);
}

/** The last instant of Brussels day `day`: 23:59:59.999 local, across DST changes. */
export function endOfDayBrussels(day: string): Date {
  return new Date(startOfDayBrussels(nextDay(day)).getTime() - 1);
}

/** The rate a row's gross is split at: 0 for `multi_purpose` and for a row without a rate. */
export function splitRate(vatTreatment: string, vatRatePct: number | null): 0 | 6 | 12 | 21 {
  if (vatTreatment === "multi_purpose" || vatRatePct === null) return 0;
  return toVatRate(vatRatePct);
}

/** Gross (VAT included) split into net and VAT at `rate`. */
export function splitGross(grossCents: number, rate: 0 | 6 | 12 | 21): Money3 {
  const { netCents, vatCents } = computeLineVat(grossCents, rate);
  return { grossCents, netCents, vatCents };
}

function add(into: Money3, m: Money3): Money3 {
  into.grossCents += m.grossCents;
  into.netCents += m.netCents;
  into.vatCents += m.vatCents;
  return into;
}

const kindOrder = (k: string) => DEFERRED_CREDIT_KINDS.indexOf(k as DeferredCreditKind);
const rateOrder = (r: number | null) => (r === null ? -1 : r);

type LiabilityRow = { kind: DeferredCreditKind; vatTreatment: string; vatRatePct: number | null; remainingUnits: number; remainingValueCents: number };

async function liabilityToday(db: DbOrTx): Promise<LiabilityRow[]> {
  const rows = rowsOf<{ credit_kind: DeferredCreditKind; vat_treatment: string; vat_rate_pct: string | null; remaining_units: string | number; remaining_value_cents: string | number }>(
    await db.execute(sql`select credit_kind::text as credit_kind, vat_treatment::text as vat_treatment, vat_rate_pct::text as vat_rate_pct, remaining_units, remaining_value_cents from v_credit_liability`),
  );
  return rows.map((r) => ({
    kind: r.credit_kind,
    vatTreatment: r.vat_treatment,
    vatRatePct: r.vat_rate_pct === null ? null : Number(r.vat_rate_pct),
    remainingUnits: Number(r.remaining_units),
    remainingValueCents: Number(r.remaining_value_cents),
  }));
}

/**
 * Deferred revenue (unused paid credits) at the end of Brussels day `asOf`: total, per credit
 * kind and per kind, VAT treatment and rate (units, gross, net, VAT). `now` defaults to the
 * wall clock; a day of today or later reads `v_credit_liability`.
 */
export async function getDeferredRevenue(db: DbOrTx, input: { asOf: string; now?: Date }): Promise<DeferredRevenue> {
  assertDay(input.asOf, "asOf");
  const today = brusselsDateOf(input.now ?? new Date());
  const source: DeferredRevenue["source"] = input.asOf >= today ? "today" : "as_of";
  const asOf = source === "today" ? today : input.asOf;
  const raw: LiabilityRow[] = source === "today" ? await liabilityToday(db) : await getCreditLiabilityAsOf(db, endOfDayBrussels(asOf));

  const merged = new Map<string, DeferredRateRow>();
  for (const r of raw) {
    const key = `${r.kind}|${r.vatTreatment}|${r.vatRatePct ?? ""}`;
    const row = merged.get(key) ?? { creditKind: r.kind, vatTreatment: r.vatTreatment, vatRatePct: r.vatRatePct, units: 0, ...ZERO() };
    row.units += r.remainingUnits;
    add(row, splitGross(r.remainingValueCents, splitRate(r.vatTreatment, r.vatRatePct)));
    merged.set(key, row);
  }
  const byRate = [...merged.values()].sort(
    (a, b) => kindOrder(a.creditKind) - kindOrder(b.creditKind) || a.vatTreatment.localeCompare(b.vatTreatment) || rateOrder(a.vatRatePct) - rateOrder(b.vatRatePct),
  );
  const byKind = { day: ZERO(), night: ZERO(), euro: ZERO() } as Record<DeferredCreditKind, Money3>;
  const total = ZERO();
  for (const row of byRate) {
    const m = { grossCents: row.grossCents, netCents: row.netCents, vatCents: row.vatCents };
    add(byKind[row.creditKind], m);
    add(total, m);
  }
  return { total, byKind, byRate, asOf, source };
}

/** The first day of the month of `day`. */
const monthOf = (day: string) => `${day.slice(0, 7)}-01`;

/**
 * Recognised (used), breakage (expired) and revoked (refunded) value per Brussels month, credit
 * kind and rate, for the months that overlap `from`..`to`. A month without any of the three is
 * left out (for example one with only new grants, or bonus credits of zero value).
 */
export async function getBreakage(db: DbOrTx, input: { from: string; to: string }): Promise<BreakageRow[]> {
  assertPeriod(input.from, input.to);
  const rows = rowsOf<{ month_on: string; credit_kind: DeferredCreditKind; vat_treatment: string; vat_rate_pct: string | null; recognised: string; breakage: string; revoked: string }>(
    await db.execute(sql`
      select m.month_on::text as month_on, m.credit_kind::text as credit_kind, m.vat_treatment::text as vat_treatment, m.vat_rate_pct::text as vat_rate_pct,
        (-coalesce(sum(m.value_cents) filter (where m.entry_kind in ('consume', 'release')), 0))::bigint::text as recognised,
        (-coalesce(sum(m.value_cents) filter (where m.entry_kind = 'expire'), 0))::bigint::text as breakage,
        (-coalesce(sum(m.value_cents) filter (where m.entry_kind = 'revoke'), 0))::bigint::text as revoked
      from v_credit_movements_monthly m
      where m.month_on between ${monthOf(input.from)}::date and ${input.to}::date
      group by m.month_on, m.credit_kind, m.vat_treatment, m.vat_rate_pct`),
  );
  const merged = new Map<string, BreakageRow>();
  for (const r of rows) {
    const rate = r.vat_rate_pct === null ? null : Number(r.vat_rate_pct);
    const split = splitRate(r.vat_treatment, rate);
    const recognised = Number(r.recognised);
    const breakage = Number(r.breakage);
    const revoked = Number(r.revoked);
    if (recognised === 0 && breakage === 0 && revoked === 0) continue;
    const key = `${r.month_on}|${r.credit_kind}|${rate ?? ""}`;
    const row = merged.get(key) ?? { month: r.month_on, creditKind: r.credit_kind, vatRatePct: rate, recognised: ZERO(), breakage: ZERO(), revoked: ZERO() };
    add(row.recognised, splitGross(recognised, split));
    add(row.breakage, splitGross(breakage, split));
    add(row.revoked, splitGross(revoked, split));
    merged.set(key, row);
  }
  return [...merged.values()].sort(
    (a, b) => a.month.localeCompare(b.month) || kindOrder(a.creditKind) - kindOrder(b.creditKind) || rateOrder(a.vatRatePct) - rateOrder(b.vatRatePct),
  );
}

type RedemptionDbRow = { entry_id: string; redeemed_at: string; redeemed_on: string; order_id: string; invoice_number: string | null; amount_cents: number | string; is_reversed: boolean };

/** One page of redemptions in Brussels days `from`..`to`, ordered by time and entry id, after the cursor. */
export async function voucherRedemptionPage(
  db: DbOrTx,
  input: { from: string; to: string; after?: { at: string; entryId: string } | null; limit?: number },
): Promise<{ rows: VoucherRedemptionRow[]; last: { at: string; entryId: string } | null }> {
  const cursor: SQL = input.after ? sql`and (v.redeemed_at, v.entry_id) > (${input.after.at}::timestamptz, ${input.after.entryId}::uuid)` : sql``;
  const limit: SQL = input.limit ? sql`limit ${input.limit}` : sql``;
  const rows = rowsOf<RedemptionDbRow>(
    await db.execute(sql`
      select v.entry_id, v.redeemed_at::text as redeemed_at, (v.redeemed_at at time zone 'Europe/Brussels')::date::text as redeemed_on,
        v.order_id, v.amount_cents, v.is_reversed,
        (select i.number from invoices i where i.order_id = v.order_id and i.kind = 'invoice'
          order by (i.status <> 'cancelled') desc, i.issued_at desc limit 1) as invoice_number
      from v_euro_voucher_redemptions v
      where v.order_id is not null
        and (v.redeemed_at at time zone 'Europe/Brussels')::date between ${input.from}::date and ${input.to}::date ${cursor}
      order by v.redeemed_at, v.entry_id
      ${limit}`),
  );
  const lastRow = rows[rows.length - 1];
  return {
    rows: rows.map((r) => ({ redeemedOn: r.redeemed_on, orderId: r.order_id, invoiceNumber: r.invoice_number ?? null, amountCents: Number(r.amount_cents), isReversed: Boolean(r.is_reversed) })),
    last: lastRow ? { at: lastRow.redeemed_at, entryId: lastRow.entry_id } : null,
  };
}

/** Every euro credit spend on an order in Brussels days `from`..`to`, with the invoice of that order. */
export async function getVoucherRedemptions(db: DbOrTx, input: { from: string; to: string }): Promise<VoucherRedemptionRow[]> {
  assertPeriod(input.from, input.to);
  return (await voucherRedemptionPage(db, { from: input.from, to: input.to })).rows;
}
