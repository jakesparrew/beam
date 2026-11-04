/**
 * Bank transfers (commerce spec rules 43 and 43a, finance rules 2, 2a and 25 to 27; edge case
 * 26; commerce-P4b).
 *
 * - `startBankTransfer` is the payment path the POS and the staff order page choose: an `open`
 *   `bank_transfer` payment with `expires_at` = today + `bank_transfer_due_days` (14) at 23:59
 *   Brussels, the order's own expiry cleared (a transfer waits for the money, not 30 minutes),
 *   and in the same transaction the open invoice through `finance.issueInvoice({status: 'open',
 *   dueOn})`, so commerce's overdue feed and finance's invoice show the same due date. Refused for
 *   orders with session, night or ticket lines (a seat cannot wait 14 days).
 * - `recordBankTransferPaid` is what finance calls when Billit reports the transfer or staff mark
 *   the invoice paid: idempotent on the order, it settles the open transfer and runs the paid
 *   transaction, whose `issueInvoice` returns the open invoice, now settled.
 */
import { orderLines, orders, payments } from "@beam/db/schema";
import { DATED_PRODUCT_KINDS, nextPaymentStatus } from "@beam/core/commerce";
import { localDateKey, wallClock, zonedTimeToUtc } from "@beam/core/platform";
import { and, desc, eq, inArray, ConflictError, NotFoundError, ValidationError, type Ctx, type Tx } from "@/lib/ctx";
import { issueInvoice } from "@/modules/finance/api";
import { liveProviderPayments } from "./cancel";
import { commerceSettings, finalizePaidOrder, lockOrder, paidCentsOf } from "./paid";

/** The due day (`YYYY-MM-DD`, Brussels) `days` after the Brussels day of `now`, and its 23:59 instant. */
export function bankTransferDue(now: Date, days: number): { dueOn: string; expiresAt: Date } {
  const today = wallClock(now);
  const d = new Date(Date.UTC(today.year, today.month - 1, today.day + days));
  const local = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  return { dueOn: localDateKey(local), expiresAt: zonedTimeToUtc({ ...local, hour: 23, minute: 59 }) };
}

/** 12:00 Brussels on `YYYY-MM-DD` (`payments.paid_at` of a settled transfer, rule 43a). */
export function brusselsNoon(day: string): Date {
  const [year, month, dayOfMonth] = day.split("-").map(Number) as [number, number, number];
  return zonedTimeToUtc({ year, month, day: dayOfMonth, hour: 12, minute: 0 });
}

/**
 * Places a `pending_payment` order on bank transfer (rule 43). A second call returns the open
 * transfer that already exists (finance answers the repeated `issueInvoice` with the existing
 * invoice).
 */
export async function startBankTransfer(tx: Tx, ctx: Ctx, input: { orderId: string }): Promise<{ paymentId: string; dueOn: string; invoiceId: string | null }> {
  const order = await lockOrder(tx, input.orderId);
  if (!order) throw new NotFoundError("order_not_found");
  if (order.status !== "pending_payment") throw new ConflictError("invalid_transition");
  const lines = await tx.select({ kind: orderLines.productKind }).from(orderLines).where(eq(orderLines.orderId, order.id));
  if (lines.some((l) => (DATED_PRODUCT_KINDS as readonly string[]).includes(l.kind))) throw new ConflictError("bank_transfer_not_allowed");

  const [open] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.provider, "bank_transfer"), eq(payments.status, "open")))
    .orderBy(desc(payments.createdAt))
    .limit(1);
  let paymentId: string;
  let dueOn: string;
  if (open) {
    paymentId = open.id;
    dueOn = localDateKey(wallClock(open.expiresAt ?? ctx.now));
  } else {
    if ((await liveProviderPayments(tx, order.id)).length) throw new ConflictError("payment_in_progress");
    const due = order.totalCents - (await paidCentsOf(tx, order.id));
    if (due <= 0) throw new ValidationError("validation", { orderId: "nothing_due" });
    const settings = await commerceSettings(tx);
    const when = bankTransferDue(ctx.now, settings.bank_transfer_due_days);
    dueOn = when.dueOn;
    const [row] = await tx
      .insert(payments)
      .values({
        orderId: order.id,
        provider: "bank_transfer",
        method: "banktransfer",
        status: "open",
        amountCents: due,
        expiresAt: when.expiresAt,
        createdByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
      })
      .returning({ id: payments.id });
    paymentId = row!.id;
    await tx.update(orders).set({ expiresAt: null, updatedAt: ctx.now }).where(eq(orders.id, order.id));
  }
  const invoice = await issueInvoice(tx, ctx, { orderId: order.id, status: "open", dueOn, paymentId });
  return { paymentId, dueOn, invoiceId: "invoiceId" in invoice ? invoice.invoiceId : null };
}

/**
 * api `recordBankTransferPaid` (rule 43a): under the order row lock, settles the open
 * `bank_transfer` payment (`paid`, `paid_at` = `paidOn` 12:00 Brussels, amount = the amount still
 * due, `raw = {reference}`) and runs the paid transaction. A second call for the paid order, a
 * call for a `cancelled` order, or an order without an open transfer changes nothing and returns
 * `{ applied: false }`. The amount check is finance's (rule 26).
 */
export async function recordBankTransferPaid(tx: Tx, ctx: Ctx, input: { orderId: string; paidOn: string; reference: string }): Promise<{ applied: boolean }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) throw new ValidationError("validation", { paidOn: "invalid_date" });
  const order = await lockOrder(tx, input.orderId);
  if (!order) throw new NotFoundError("order_not_found");
  if (order.status !== "pending_payment") return { applied: false };
  const [transfer] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.provider, "bank_transfer"), inArray(payments.status, ["open", "pending"])))
    .orderBy(desc(payments.createdAt))
    .limit(1)
    .for("update");
  if (!transfer) return { applied: false };
  const history = transfer.statusHistory ?? [];
  const next = nextPaymentStatus(transfer.status, "paid", "staff", history.at(-1)?.source ?? "provider");
  if (!next) return { applied: false };
  const due = order.totalCents - (await paidCentsOf(tx, order.id));
  await tx
    .update(payments)
    .set({
      status: next,
      paidAt: brusselsNoon(input.paidOn),
      amountCents: due > 0 ? due : transfer.amountCents,
      raw: { reference: input.reference },
      statusHistory: [...history, { status: next, at: ctx.now.toISOString(), source: "staff" }],
      updatedAt: ctx.now,
    })
    .where(eq(payments.id, transfer.id));
  await finalizePaidOrder(tx, ctx, order.id, { paymentId: transfer.id });
  return { applied: true };
}
