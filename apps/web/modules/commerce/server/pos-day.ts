/**
 * POS day summary and day close (commerce spec rule 55, edge case 31; commerce-P7).
 *
 * The business day is the Europe/Brussels calendar day. Its counter money is:
 * - `cash` and `terminal` payments paid that day (they only start at the counter, whatever the
 *   order's channel: a booking pay-at-desk order paid in cash is drawer money too);
 * - `bank_transfer` payments placed that day and `credit_balance` payments paid that day on POS
 *   orders (no drawer effect, shown for the totals);
 * - refunds created that day on those counter payments; cash refunds leave the drawer.
 *
 * Expected cash = `pos_cash_float_cents` + cash paid - cash refunded. `closePosDay` freezes the
 * totals in `pos_day_closes`, stores the counted amount and the difference (a note is required
 * when it is not 0) and opens one finance task when the difference is above EUR 20 (dedupe
 * `pos_close:<YYYY-MM-DD>`). A closed day refuses cash (`day_closed`) until `reopenPosDay`
 * (`commerce.refund`) opens it again for a recount.
 */
import { orders, payments, posDayCloses, refunds } from "@beam/db/schema";
import { formatMoney, t } from "@beam/core/i18n";
import { localDateKey, wallClock, zonedTimeToUtc } from "@beam/core/platform";
import { and, eq, gte, inArray, lt, or, sql, ConflictError, NotFoundError, ValidationError, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import { createTask } from "@/modules/crm/api";
import { commerceSettings, PAID_PAYMENT_STATUSES } from "./paid";

/** A day difference above this (in cents, either way) opens a finance task (rule 55). */
export const POS_DIFFERENCE_TASK_CENTS = 2000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type PosDayTotals = {
  /** Cents per method. */
  terminal: number;
  cash: number;
  bank_transfer: number;
  credit_balance: number;
  /** Cents refunded on counter payments, and the cash part of it. */
  refunds: number;
  cash_refunds: number;
  /** Counts. */
  orders: number;
  payments: number;
  refund_count: number;
  /** The drawer float the expected cash starts from. */
  float: number;
};

export type PosDaySummary = {
  day: string;
  totals: PosDayTotals;
  expectedCashCents: number;
  close: {
    status: "open" | "closed";
    countedCashCents: number | null;
    differenceCents: number | null;
    note: string | null;
    closedAt: Date | null;
    closedByUserId: string | null;
    /** The totals frozen at close (null while open). */
    frozen: Record<string, number> | null;
  };
};

/** The Brussels business day (`YYYY-MM-DD`) of an instant. */
export function businessDayOf(at: Date): string {
  return localDateKey(wallClock(at));
}

/** `[start, end)` of a Brussels business day, as UTC instants. */
export function businessDayRange(day: string): { from: Date; to: Date } {
  if (!DAY.test(day)) throw new ValidationError("validation", { businessDayOn: "invalid_date" });
  const [year, month, d] = day.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, d + 1));
  return {
    from: zonedTimeToUtc({ year, month, day: d, hour: 0, minute: 0 }),
    to: zonedTimeToUtc({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0 }),
  };
}

/** The money of the day at the counter (see the file comment). */
export async function computePosDayTotals(db: DbOrTx, day: string): Promise<PosDayTotals> {
  const { from, to } = businessDayRange(day);
  const settings = await commerceSettings(db);
  const paidThatDay = and(inArray(payments.status, [...PAID_PAYMENT_STATUSES]), gte(payments.paidAt, from), lt(payments.paidAt, to));
  const rows = await db
    .select({ id: payments.id, orderId: payments.orderId, provider: payments.provider, amountCents: payments.amountCents, status: payments.status })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(
      or(
        and(inArray(payments.provider, ["cash", "terminal"]), paidThatDay),
        and(eq(orders.channel, "pos"), eq(payments.provider, "credit_balance"), paidThatDay),
        and(eq(orders.channel, "pos"), eq(payments.provider, "bank_transfer"), gte(payments.createdAt, from), lt(payments.createdAt, to), sql`${payments.status} not in ('cancelled', 'expired', 'failed')`),
      ),
    );
  const totals: PosDayTotals = { terminal: 0, cash: 0, bank_transfer: 0, credit_balance: 0, refunds: 0, cash_refunds: 0, orders: 0, payments: rows.length, refund_count: 0, float: settings.pos_cash_float_cents };
  for (const r of rows) {
    if (r.provider === "terminal" || r.provider === "cash" || r.provider === "bank_transfer" || r.provider === "credit_balance") totals[r.provider] += r.amountCents;
  }
  totals.orders = new Set(rows.map((r) => r.orderId)).size;

  const refundRows = await db
    .select({ amountCents: refunds.amountCents, provider: payments.provider })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(
      and(
        gte(refunds.createdAt, from),
        lt(refunds.createdAt, to),
        sql`${refunds.status} <> 'failed'`,
        or(inArray(payments.provider, ["cash", "terminal"]), and(eq(orders.channel, "pos"), inArray(payments.provider, ["credit_balance", "bank_transfer"]))),
      ),
    );
  for (const r of refundRows) {
    totals.refunds += r.amountCents;
    totals.refund_count += 1;
    if (r.provider === "cash") totals.cash_refunds += r.amountCents;
  }
  return totals;
}

/** `pos_cash_float_cents` plus cash payments minus cash refunds (rule 55). */
export function expectedCash(totals: Pick<PosDayTotals, "float" | "cash" | "cash_refunds">): number {
  return totals.float + totals.cash - totals.cash_refunds;
}

/** `getPosDaySummary(db, {day})`: totals by method, counts, refunds, expected cash and close state. */
export async function getPosDaySummary(db: DbOrTx, input: { day: string }): Promise<PosDaySummary> {
  const totals = await computePosDayTotals(db, input.day);
  const [row] = await db.select().from(posDayCloses).where(eq(posDayCloses.businessDayOn, input.day));
  return {
    day: input.day,
    totals,
    expectedCashCents: expectedCash(totals),
    close: {
      status: row?.status ?? "open",
      countedCashCents: row?.countedCashCents ?? null,
      differenceCents: row?.differenceCents ?? null,
      note: row?.note ?? null,
      closedAt: row?.closedAt ?? null,
      closedByUserId: row?.closedByUserId ?? null,
      frozen: row?.status === "closed" ? row.totals : null,
    },
  };
}

/** True when the business day is closed (no more cash sales, edge case 31). */
export async function isPosDayClosed(db: DbOrTx, day: string): Promise<boolean> {
  const [row] = await db.select({ status: posDayCloses.status }).from(posDayCloses).where(eq(posDayCloses.businessDayOn, day));
  return row?.status === "closed";
}

/** Refuses cash on a closed business day with `conflict: day_closed`. */
export async function assertCashDayOpen(tx: Tx, at: Date): Promise<void> {
  if (await isPosDayClosed(tx, businessDayOf(at))) throw new ConflictError("day_closed");
}

/** The day's row, created `open` on first use and locked `FOR UPDATE`. */
async function lockDayRow(tx: Tx, day: string) {
  await tx.insert(posDayCloses).values({ businessDayOn: day }).onConflictDoNothing();
  const [row] = await tx.select().from(posDayCloses).where(eq(posDayCloses.businessDayOn, day)).for("update");
  return row!;
}

export type ClosePosDayInput = { businessDayOn: string; countedCashCents: number; note?: string | null | undefined };

/** `closePosDay` (staff, `commerce.sell`; rule 55). */
export async function closePosDay(tx: Tx, ctx: Ctx, input: ClosePosDayInput): Promise<{ differenceCents: number; expectedCashCents: number; taskId: string | null }> {
  const day = input.businessDayOn;
  businessDayRange(day);
  if (day > businessDayOf(ctx.now)) throw new ValidationError("validation", { businessDayOn: "in_the_future" });
  if (!Number.isInteger(input.countedCashCents) || input.countedCashCents < 0) throw new ValidationError("validation", { countedCashCents: "invalid" });
  const row = await lockDayRow(tx, day);
  if (row.status === "closed") throw new ConflictError("invalid_transition");
  const totals = await computePosDayTotals(tx, day);
  const expected = expectedCash(totals);
  const difference = input.countedCashCents - expected;
  const note = input.note?.trim() || null;
  if (difference !== 0 && !note) throw new ValidationError("validation", { note: "required" });
  const closedByUserId = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
  await tx
    .update(posDayCloses)
    .set({
      status: "closed",
      expectedCashCents: expected,
      countedCashCents: input.countedCashCents,
      differenceCents: difference,
      totals: { ...totals },
      note,
      closedByUserId,
      closedAt: ctx.now,
      updatedAt: ctx.now,
    })
    .where(eq(posDayCloses.id, row.id));
  await ctx.audit({
    action: "pos.day_closed",
    entityType: "pos_day_close",
    entityId: row.id,
    oldValue: { status: row.status },
    newValue: { businessDayOn: day, expectedCashCents: expected, countedCashCents: input.countedCashCents, differenceCents: difference, totals },
  });
  let taskId: string | null = null;
  if (Math.abs(difference) > POS_DIFFERENCE_TASK_CENTS) {
    const task = await createTask(tx, ctx, {
      title: t("nl-BE", "commerce.tasks.pos_close_difference", { day, amount: formatMoney(difference, "nl-BE") }),
      kind: "payment",
      ownerRole: "finance",
      source: "system",
      ref: { type: "pos_day_close", id: row.id },
      dedupeKey: `pos_close:${day}`,
    });
    taskId = task.taskId;
  }
  return { differenceCents: difference, expectedCashCents: expected, taskId };
}

/** `reopenPosDay` (staff, `commerce.refund`; rule 55): the day takes cash again and is recounted at the next close. */
export async function reopenPosDay(tx: Tx, ctx: Ctx, input: { businessDayOn: string; reason: string }): Promise<{ ok: true }> {
  ctx.require("commerce.refund");
  businessDayRange(input.businessDayOn);
  const reason = input.reason.trim();
  if (reason.length < 3) throw new ValidationError("validation", { reason: "required" });
  const [row] = await tx.select().from(posDayCloses).where(eq(posDayCloses.businessDayOn, input.businessDayOn)).for("update");
  if (!row) throw new NotFoundError("not_found");
  if (row.status !== "closed") throw new ConflictError("invalid_transition");
  await tx
    .update(posDayCloses)
    .set({ status: "open", countedCashCents: null, differenceCents: null, note: null, closedAt: null, closedByUserId: null, updatedAt: ctx.now })
    .where(eq(posDayCloses.id, row.id));
  await ctx.audit({
    action: "pos.day_reopened",
    entityType: "pos_day_close",
    entityId: row.id,
    oldValue: { status: "closed", countedCashCents: row.countedCashCents, differenceCents: row.differenceCents, note: row.note },
    newValue: { status: "open", reason },
  });
  return { ok: true };
}
