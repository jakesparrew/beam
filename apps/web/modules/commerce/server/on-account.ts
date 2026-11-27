/**
 * On account ("Op rekening", owner decision November 2026). At the till staff put an order on a
 * client's account: it stays `pending_payment` on that person, without expiry (`on_account_at`
 * set, `expires_at` cleared), and its walk-in seats are confirmed so the client can attend. The
 * client settles later by one of three paths, each through the existing flows:
 * - a payment link (`sendPaymentLink`, Stripe through the pay page);
 * - an open invoice for a bank transfer (`issueOnAccountInvoice` -> `startBankTransfer`, allowed
 *   with session lines because the seat no longer waits for the money);
 * - at the till (`posPayOrder` with cash or Kaart (terminal)).
 * Whichever path pays first runs the paid transaction once (order lock); `finalizePaidOrder`
 * then cancels a transfer still open, so nothing is counted twice. Packages, memberships and
 * vouchers are delivered when the order is paid, as for any order.
 */
import { orders, persons } from "@beam/db/schema";
import { and, asc, eq, isNotNull, sql, ConflictError, NotFoundError, ValidationError, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import { startBankTransfer } from "./bank-transfer";
import { lockOrder, PAID_PAYMENT_STATUSES, type OrderRow } from "./paid";

/** booking's api, loaded on first use (booking's order flow imports commerce's api). */
const bookingApi = () => import("@/modules/booking/api");

/** Puts the locked `pending_payment` order on its person's account (the till's "Op rekening"). */
export async function putOnAccount(tx: Tx, ctx: Ctx, order: OrderRow): Promise<{ orderId: string; status: "pending_payment" }> {
  if (!order.personId) throw new ValidationError("validation", { personId: "person_required" });
  if (order.status !== "pending_payment") throw new ConflictError("invalid_transition");
  if (!order.onAccountAt) {
    await tx.update(orders).set({ onAccountAt: ctx.now, expiresAt: null, updatedAt: ctx.now }).where(eq(orders.id, order.id));
    // The walk-in seats are the client's now: confirmed, so check-in works before the payment.
    await (await bookingApi()).confirmBookingsForOrder(tx, ctx, { orderId: order.id });
    await ctx.audit({
      action: "pos.on_account",
      entityType: "order",
      entityId: order.id,
      personId: order.personId,
      newValue: { reference: order.reference, totalCents: order.totalCents, channel: order.channel },
    });
  }
  return { orderId: order.id, status: "pending_payment" };
}

/** `issueOnAccountInvoice` (staff, `invoices.issue`): the open invoice with due date and structured communication. */
export async function issueOnAccountInvoice(tx: Tx, ctx: Ctx, input: { orderId: string }): Promise<{ paymentId: string; dueOn: string; invoiceId: string | null }> {
  const order = await lockOrder(tx, input.orderId);
  if (!order) throw new NotFoundError("order_not_found");
  if (!order.onAccountAt) throw new ConflictError("invalid_transition");
  const out = await startBankTransfer(tx, ctx, { orderId: order.id });
  await ctx.audit({ action: "pos.on_account_invoiced", entityType: "order", entityId: order.id, personId: order.personId, newValue: { paymentId: out.paymentId, dueOn: out.dueOn, invoiceId: out.invoiceId } });
  return out;
}

export type OpenAccountRow = {
  orderId: string;
  reference: string;
  personId: string;
  personName: string | null;
  personEmail: string | null;
  channel: OrderRow["channel"];
  totalCents: number;
  dueCents: number;
  since: Date;
};

/** The open on-account orders, oldest first (the "Op te volgen" tab, the person's profile, the dashboard). */
export async function listOpenAccounts(db: DbOrTx, opts: { personId?: string; limit: number }): Promise<OpenAccountRow[]> {
  const rows = await db
    .select({
      orderId: orders.id,
      reference: orders.reference,
      personId: orders.personId,
      channel: orders.channel,
      totalCents: orders.totalCents,
      paidCents: sql<number>`(select coalesce(sum(p.amount_cents), 0)::int from payments p where p.order_id = "orders"."id" and p.status in (${sql.raw(PAID_PAYMENT_STATUSES.map((st) => `'${st}'`).join(", "))}))`,
      since: orders.onAccountAt,
      firstName: persons.firstName,
      lastName: persons.lastName,
      email: persons.email,
    })
    .from(orders)
    .innerJoin(persons, eq(persons.id, orders.personId))
    .where(and(isNotNull(orders.onAccountAt), eq(orders.status, "pending_payment"), ...(opts.personId ? [eq(orders.personId, opts.personId)] : [])))
    .orderBy(asc(orders.onAccountAt), asc(orders.id))
    .limit(Math.max(1, Math.min(500, Math.floor(opts.limit) || 1)));
  return rows.map((r) => ({
    orderId: r.orderId,
    reference: r.reference,
    personId: r.personId!,
    personName: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
    personEmail: r.email ?? null,
    channel: r.channel,
    totalCents: r.totalCents,
    dueCents: Math.max(0, r.totalCents - Number(r.paidCents)),
    since: r.since!,
  }));
}

/** The person's "Openstaand": the total still due on account and its orders. */
export async function getPersonOpenAccount(db: DbOrTx, personId: string): Promise<{ dueCents: number; orders: OpenAccountRow[] }> {
  const rows = await listOpenAccounts(db, { personId, limit: 100 });
  return { dueCents: rows.reduce((s, r) => s + r.dueCents, 0), orders: rows };
}
