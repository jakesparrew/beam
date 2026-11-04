/**
 * The front-desk POS (commerce spec rules 21, 24 to 26b, 42 to 44, 55; edge cases 16, 18, 31, 34;
 * commerce-P7).
 *
 * - `posSell` sells a basket at the counter: a `pos` order through `createOrder` (walk-in
 *   session and ticket lines carry no booking ids), then one `reserved` booking per dated line
 *   through `booking.createBookingForPosLine` in the same transaction (a booking conflict rolls
 *   the whole sale back as `conflict: sold_out`), the company billing details, and the payment.
 * - `posPayOrder` takes payment at the counter for an existing `pending_payment` order (booking's
 *   pay-at-desk orders, staff orders on the POS path, renewal link orders; `/admin/pos?order=`).
 * - Payments: cash is paid at once (`cash_received_cents >= due`, change returned; refused on a
 *   closed day), bank transfer opens the transfer and its open invoice (refused for dated lines),
 *   terminal writes a `terminal` payment and runs `payments.terminal` inline; its result arrives
 *   through the Mollie webhook. `posCancelTerminal` cancels a hanging terminal payment (source
 *   staff) and queues `payments.cancel_terminal` to cancel it on the device.
 * - Anonymous sales are allowed only for items and vouchers (rule 42).
 */
import { orderLines, orders, payments, persons, products } from "@beam/db/schema";
import { BookingConflictError } from "@beam/core/booking";
import { CartItem, DATED_PRODUCT_KINDS, type OrderStatus } from "@beam/core/commerce";
import type { BillingDetails } from "@beam/core/finance";
import { t, type Locale, type LocalizedText } from "@beam/core/i18n";
import { IntegrationError } from "@beam/integrations/_shared";
import { and, asc, desc, eq, inArray, sql, AppError, ConflictError, NotFoundError, ValidationError, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import { getIntegrations, type Integrations } from "@/lib/integrations";
import { runJobInline, type JobCtx } from "@/lib/job-runner";
import { createTask } from "@/modules/crm/api";
import { consumeCredits, getEuroBalance } from "@/modules/credits/api";
import { setOrderBillingDetails } from "@/modules/finance/api";
import { startBankTransfer } from "./bank-transfer";
import { LIVE_STATUSES } from "./cancel";
import { createOrder } from "./orders";
import { commerceSettings, finalizePaidOrder, lockOrder, paidCentsOf, type OrderRow, type PaymentRow } from "./paid";
import { applyProviderStatus, mollieWebhookUrl } from "./payments";
import { assertCashDayOpen } from "./pos-day";

/** booking's api, loaded on first use (booking's order flow imports commerce's api). */
const bookingApi = () => import("@/modules/booking/api");

export type PosMethod = "terminal" | "cash" | "bank_transfer";

/** Product kinds an anonymous buyer may take home (rule 42). */
export const ANONYMOUS_KINDS = ["item", "voucher"] as const;

/** `conflict: sold_out` with booking's reason (`session_full`, `member_only`, `already_booked`). */
export class PosSoldOutError extends AppError {
  override readonly name: string = "PosSoldOutError";
  constructor(readonly reason: string) {
    super("conflict", "sold_out", { items: reason });
  }
}

export type PosPaymentInput = {
  method: PosMethod;
  terminalId?: string | undefined;
  cashReceivedCents?: number | undefined;
  useEuroCredit?: boolean | undefined;
  billingDetails?: BillingDetails | undefined;
  clientKey: string;
};

export type PosSellInput = PosPaymentInput & {
  personId?: string | null | undefined;
  items: CartItem[];
  promoCode?: string | null | undefined;
  locale?: Locale | undefined;
};

export type PosPayResult = {
  orderId: string;
  status: OrderStatus;
  changeCents?: number;
  paymentId?: string;
  dueOn?: string;
};

const isDated = (kind: string) => (DATED_PRODUCT_KINDS as readonly string[]).includes(kind);
const PAID_ORDER = new Set<OrderStatus>(["paid", "partially_refunded", "refunded"]);

function parseItems(raw: readonly unknown[]): CartItem[] {
  const fields: Record<string, string> = {};
  const out: CartItem[] = [];
  raw.forEach((item, i) => {
    const r = CartItem.safeParse(item);
    if (r.success) out.push(r.data);
    else for (const issue of r.error.issues) fields[`items.${i}.${issue.path.join(".") || "item"}`] = issue.message;
  });
  if (!raw.length) fields.items = "required";
  if (Object.keys(fields).length) throw new ValidationError("validation", fields);
  return out;
}

/** Checks the method's own fields before anything is written. */
async function checkMethod(tx: Tx, ctx: Ctx, input: PosPaymentInput): Promise<void> {
  if (input.method === "cash") {
    if (input.cashReceivedCents == null || !Number.isInteger(input.cashReceivedCents) || input.cashReceivedCents < 0) {
      throw new ValidationError("validation", { cashReceivedCents: "required" });
    }
    await assertCashDayOpen(tx, ctx.now);
  }
  if (input.method === "terminal") {
    const settings = await commerceSettings(tx);
    if (!input.terminalId || !settings.pos_terminals.some((term) => term.id === input.terminalId)) throw new ValidationError("validation", { terminalId: "unknown_terminal" });
  }
}

/** The state a repeated submit answers with (rule 20): the order and its latest payment. */
async function currentState(db: DbOrTx, orderId: string): Promise<PosPayResult> {
  const [order] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  const [last] = await db.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId)).orderBy(desc(payments.createdAt)).limit(1);
  return { orderId, status: order?.status ?? "pending_payment", ...(last ? { paymentId: last.id } : {}) };
}

/** `posSell` (staff, `commerce.sell`). */
export async function posSell(tx: Tx, ctx: Ctx, input: PosSellInput): Promise<PosPayResult> {
  const items = parseItems(input.items);
  const personId = input.personId ?? null;
  const [existing] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.clientKey, input.clientKey));
  if (existing) return currentState(tx, existing.id);

  const productRows = await tx.select({ id: products.id, kind: products.kind }).from(products).where(inArray(products.id, [...new Set(items.map((i) => i.productId))]));
  const kindOf = new Map(productRows.map((p) => [p.id, p.kind]));
  const kinds = items.map((i) => kindOf.get(i.productId)).filter((k): k is NonNullable<typeof k> => !!k);
  if (!personId && kinds.some((k) => !(ANONYMOUS_KINDS as readonly string[]).includes(k))) throw new ValidationError("validation", { personId: "person_required" });
  if (input.method === "bank_transfer" && kinds.some(isDated)) throw new ConflictError("bank_transfer_not_allowed");
  if (input.useEuroCredit && !personId) throw new ValidationError("validation", { useEuroCredit: "person_required" });
  await checkMethod(tx, ctx, input);

  const created = await createOrder(tx, ctx, {
    personId,
    channel: "pos",
    items,
    promoCode: input.promoCode ?? null,
    clientKey: input.clientKey,
    locale: input.locale ?? ctx.locale,
    useEuroCredit: !!input.useEuroCredit,
  });
  if (created.isExisting) return currentState(tx, created.orderId);

  // Rule 21: each walk-in session or ticket line gets its reserved row under booking's lock.
  const datedLines = items.map((item, i) => ({ item, lineId: created.lineIds[i]! })).filter(({ item }) => isDated(kindOf.get(item.productId) ?? ""));
  if (datedLines.length) {
    const booking = await bookingApi();
    for (const { item, lineId } of datedLines) {
      try {
        await booking.createBookingForPosLine(tx, ctx, { orderLineId: lineId, sessionId: item.sessionId!, personId: personId! });
      } catch (error) {
        if (error instanceof BookingConflictError) throw new PosSoldOutError(error.reason);
        throw error;
      }
    }
    // A sale paid in createOrder (0 total, full euro credit) ran its paid transaction before
    // the rows existed: confirm them now (idempotent per line).
    if (created.status === "paid") await booking.confirmBookingsForOrder(tx, ctx, { orderId: created.orderId });
  }
  if (input.billingDetails) await setOrderBillingDetails(tx, ctx, { orderId: created.orderId, details: input.billingDetails });

  const order = (await lockOrder(tx, created.orderId))!;
  const result = created.status === "paid" ? { orderId: order.id, status: "paid" as const } : await takePayment(tx, ctx, order, input);
  await ctx.audit({
    action: "pos.sale",
    entityType: "order",
    entityId: order.id,
    ...(personId ? { personId } : {}),
    newValue: { reference: order.reference, method: input.method, totalCents: order.totalCents, discountCents: order.discountCents, promotionId: order.promotionId, status: result.status },
  });
  return result;
}

/** `posPayOrder` (staff, `commerce.sell`): pays an existing `pending_payment` order at the counter. */
export async function posPayOrder(tx: Tx, ctx: Ctx, input: PosPaymentInput & { orderId: string }): Promise<PosPayResult> {
  const order = await lockOrder(tx, input.orderId);
  if (!order) throw new NotFoundError("order_not_found");
  const [repeat] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.orderId, order.id), sql`${payments.raw} ->> 'client_key' = ${input.clientKey}`))
    .limit(1);
  if (repeat || PAID_ORDER.has(order.status)) return currentState(tx, order.id);
  if (order.status !== "pending_payment") throw new ConflictError("invalid_transition");
  if (order.expiresAt && order.expiresAt.getTime() <= ctx.now.getTime()) throw new ConflictError("order_expired");
  const lines = await tx.select({ kind: orderLines.productKind }).from(orderLines).where(eq(orderLines.orderId, order.id));
  if (input.method === "bank_transfer" && lines.some((l) => isDated(l.kind))) throw new ConflictError("bank_transfer_not_allowed");
  if (input.useEuroCredit && !order.personId) throw new ValidationError("validation", { useEuroCredit: "person_required" });
  await checkMethod(tx, ctx, input);
  if (input.billingDetails) await setOrderBillingDetails(tx, ctx, { orderId: order.id, details: input.billingDetails });

  let result: PosPayResult;
  if (input.useEuroCredit && (await useEuroCredit(tx, ctx, order)) && order.totalCents - (await paidCentsOf(tx, order.id)) <= 0) {
    await finalizePaidOrder(tx, ctx, order.id);
    result = { orderId: order.id, status: "paid" };
  } else {
    result = await takePayment(tx, ctx, order, input);
  }
  await ctx.audit({
    action: "pos.order_paid",
    entityType: "order",
    entityId: order.id,
    ...(order.personId ? { personId: order.personId } : {}),
    newValue: { reference: order.reference, method: input.method, channel: order.channel, status: result.status },
  });
  return result;
}

/** Rule 25 for an existing order: the person's euro credit pays what it can (once per order). */
async function useEuroCredit(tx: Tx, ctx: Ctx, order: OrderRow): Promise<boolean> {
  if (!order.personId) return false;
  const [already] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.provider, "credit_balance"), eq(payments.status, "paid")))
    .limit(1);
  if (already) return false;
  const due = order.totalCents - (await paidCentsOf(tx, order.id));
  const cents = Math.min((await getEuroBalance(tx, order.personId)).remainingCents, due);
  if (cents <= 0) return false;
  await consumeCredits(tx, ctx, { personId: order.personId, beneficiaryPersonId: order.personId, kind: "euro", units: cents, ref: { type: "order", id: order.id } });
  await tx.insert(payments).values({
    orderId: order.id,
    provider: "credit_balance",
    method: "credit_balance",
    status: "paid",
    amountCents: cents,
    paidAt: ctx.now,
    statusHistory: [{ status: "paid", at: ctx.now.toISOString(), source: "staff" }],
    createdByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
  });
  return true;
}

/** Takes the rest of the order's total with the chosen method (the order row is locked). */
async function takePayment(tx: Tx, ctx: Ctx, order: OrderRow, input: PosPaymentInput): Promise<PosPayResult> {
  const due = order.totalCents - (await paidCentsOf(tx, order.id));
  if (due <= 0) {
    await finalizePaidOrder(tx, ctx, order.id);
    return { orderId: order.id, status: "paid" };
  }
  const live = await tx
    .select({ id: payments.id, provider: payments.provider })
    .from(payments)
    .where(and(eq(payments.orderId, order.id), inArray(payments.status, [...LIVE_STATUSES])));
  if (live.some((p) => p.provider !== "bank_transfer") || (input.method !== "bank_transfer" && live.length)) throw new ConflictError("payment_in_progress");
  const staffUserId = ctx.actor.kind === "staff" ? ctx.actor.userId : null;

  if (input.method === "bank_transfer") {
    const transfer = await startBankTransfer(tx, ctx, { orderId: order.id });
    return { orderId: order.id, status: "pending_payment", paymentId: transfer.paymentId, dueOn: transfer.dueOn };
  }

  if (input.method === "cash") {
    const received = input.cashReceivedCents ?? 0;
    if (received < due) throw new ValidationError("validation", { cashReceivedCents: "too_low" });
    const [payment] = await tx
      .insert(payments)
      .values({
        orderId: order.id,
        provider: "cash",
        method: "cash",
        status: "paid",
        amountCents: due,
        cashReceivedCents: received,
        paidAt: ctx.now,
        raw: { client_key: input.clientKey },
        statusHistory: [{ status: "paid", at: ctx.now.toISOString(), source: "staff" }],
        createdByUserId: staffUserId,
      })
      .returning({ id: payments.id });
    await finalizePaidOrder(tx, ctx, order.id, { paymentId: payment!.id });
    return { orderId: order.id, status: "paid", changeCents: received - due, paymentId: payment!.id };
  }

  // Terminal: the device is asked inline; its result comes back through the webhook.
  const [payment] = await tx
    .insert(payments)
    .values({
      orderId: order.id,
      provider: "terminal",
      method: "pointofsale",
      status: "open",
      amountCents: due,
      terminalId: input.terminalId!,
      raw: { client_key: input.clientKey },
      createdByUserId: staffUserId,
    })
    .returning();
  // Rule 22: a pending order expires 30 minutes after its last payment; pay-at-desk (admin) and
  // renewal orders keep their own expiry.
  if (order.channel !== "admin" && !order.renewalMembershipId) {
    const settings = await commerceSettings(tx);
    await tx
      .update(orders)
      .set({ expiresAt: new Date(ctx.now.getTime() + settings.order_expiry_minutes * 60_000), updatedAt: ctx.now })
      .where(eq(orders.id, order.id));
  }
  try {
    await runJobInline("payments.terminal", { paymentId: payment!.id, terminalId: input.terminalId! }, { key: `payment_terminal:${payment!.id}`, requestId: ctx.requestId, db: tx });
  } catch {
    const [row] = await tx.select().from(payments).where(eq(payments.id, payment!.id)).for("update");
    if (row && row.status === "open" && !row.providerPaymentId) await applyProviderStatus(tx, ctx, row, { status: "failed", reason: "payment_unavailable" });
  }
  const [after] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id));
  return { orderId: order.id, status: after?.status ?? "pending_payment", paymentId: payment!.id };
}

// ---------------------------------------------------------------------------
// The terminal
// ---------------------------------------------------------------------------

function paymentsClient(ctx: Ctx & { integrations?: Integrations }) {
  return (ctx.integrations ?? getIntegrations()).payments;
}

export type TerminalJobResult = { providerPaymentId: string } | { skipped: true; status: PaymentRow["status"] } | { failed: true; reason: string };

/**
 * `payments.terminal` (inline, key `payment_terminal:<payment_id>`): sends the amount to the
 * device (`provider.createTerminalPayment`, job key as `Idempotency-Key`) and stores the provider
 * id. A provider 4xx fails the payment; a 5xx or timeout throws for the caller's fallback.
 */
export async function runTerminalPayment(ctx: JobCtx, input: { paymentId: string; terminalId: string }): Promise<TerminalJobResult> {
  const [payment] = await ctx.tx.select().from(payments).where(eq(payments.id, input.paymentId)).for("update");
  if (!payment) throw new NotFoundError("payment_not_found");
  if (payment.providerPaymentId) return { providerPaymentId: payment.providerPaymentId };
  if (payment.status !== "open") return { skipped: true, status: payment.status };
  const [order] = await ctx.tx.select().from(orders).where(eq(orders.id, payment.orderId));
  if (!order) throw new NotFoundError("order_not_found");
  try {
    const created = await paymentsClient(ctx).createTerminalPayment({
      terminalId: input.terminalId,
      amountCents: payment.amountCents,
      description: order.reference,
      webhookUrl: mollieWebhookUrl(),
      metadata: { orderId: order.id, paymentId: payment.id },
      idempotencyKey: ctx.job.key,
    });
    await ctx.tx.update(payments).set({ providerPaymentId: created.providerPaymentId, updatedAt: ctx.now }).where(eq(payments.id, payment.id));
    if (created.status !== "open") {
      const [row] = await ctx.tx.select().from(payments).where(eq(payments.id, payment.id));
      await applyProviderStatus(ctx.tx, ctx, row!, { status: created.status, method: "pointofsale" });
    }
    return { providerPaymentId: created.providerPaymentId };
  } catch (error) {
    if (error instanceof IntegrationError && !error.retryable) {
      await applyProviderStatus(ctx.tx, ctx, payment, { status: "failed", reason: "provider_rejected" });
      return { failed: true, reason: "provider_rejected" };
    }
    throw error;
  }
}

/** `posCancelTerminal` (staff, `commerce.sell`): a hanging terminal payment becomes `cancelled` (source staff). */
export async function posCancelTerminal(tx: Tx, ctx: Ctx, input: { paymentId: string }): Promise<{ ok: true; orderId: string }> {
  const [payment] = await tx.select().from(payments).where(eq(payments.id, input.paymentId)).for("update");
  if (!payment || payment.provider !== "terminal") throw new NotFoundError("payment_not_found");
  if (!(LIVE_STATUSES as readonly string[]).includes(payment.status)) throw new ConflictError("invalid_transition");
  const { changed } = await applyProviderStatus(tx, ctx, payment, { status: "cancelled", source: "staff", reason: "cancelled_by_staff" });
  if (!changed) throw new ConflictError("invalid_transition");
  if (payment.providerPaymentId) {
    await ctx.enqueue({ kind: "payments.cancel_terminal", payload: { paymentId: payment.id }, key: `payment_terminal_cancel:${payment.id}` });
  }
  await ctx.audit({ action: "pos.terminal_cancelled", entityType: "payment", entityId: payment.id, oldValue: { status: payment.status }, newValue: { status: "cancelled", orderId: payment.orderId } });
  return { ok: true, orderId: payment.orderId };
}

/**
 * `payments.cancel_terminal` (key `payment_terminal_cancel:<payment_id>`): cancels a payment staff
 * cancelled at the counter on the device as well. When the device already took the money (the
 * provider reports `paid`), the local payment stays `cancelled` and finance gets a task to refund
 * it at the terminal (edge case 16).
 */
export async function runCancelTerminal(ctx: JobCtx, input: { paymentId: string }): Promise<{ cancelled: boolean; paidAtProvider: boolean }> {
  const [payment] = await ctx.tx.select().from(payments).where(eq(payments.id, input.paymentId));
  if (!payment?.providerPaymentId) return { cancelled: false, paidAtProvider: false };
  const provider = paymentsClient(ctx);
  let cancelled = false;
  try {
    ({ cancelled } = await provider.cancelPayment(payment.providerPaymentId));
  } catch (error) {
    if (!(error instanceof IntegrationError && !error.retryable)) throw error;
  }
  if (cancelled) return { cancelled: true, paidAtProvider: false };
  const reported = await provider.getPayment(payment.providerPaymentId);
  if (reported.status !== "paid") return { cancelled: false, paidAtProvider: false };
  const [order] = await ctx.tx.select().from(orders).where(eq(orders.id, payment.orderId));
  await createTask(ctx.tx, ctx, {
    title: t("nl-BE", "commerce.tasks.terminal_paid_after_cancel", { reference: order?.reference ?? payment.orderId }),
    kind: "payment",
    ownerRole: "finance",
    ...(order?.personId ? { personId: order.personId } : {}),
    source: "system",
    ref: { type: "payment", id: payment.id },
    dedupeKey: `terminal_paid_after_cancel:${payment.id}`,
  });
  return { cancelled: false, paidAtProvider: true };
}

// ---------------------------------------------------------------------------
// Reads (the POS screen)
// ---------------------------------------------------------------------------

export type PosOrderView = {
  orderId: string;
  reference: string;
  status: OrderStatus;
  channel: OrderRow["channel"];
  personId: string | null;
  personName: string | null;
  personEmail: string | null;
  totalCents: number;
  dueCents: number;
  expiresAt: Date | null;
  lines: { lineId: string; description: LocalizedText; quantity: number; lineTotalCents: number; productKind: string }[];
  payments: { paymentId: string; provider: PaymentRow["provider"]; status: PaymentRow["status"]; amountCents: number; createdAt: Date }[];
  /** The terminal payment still waiting on the device, if any. */
  liveTerminalPaymentId: string | null;
  hasDatedLines: boolean;
};

/** `getPosOrder(db, orderId)`: the order the `?order=` deep link opens read-only in the basket. */
export async function getPosOrder(db: DbOrTx, orderId: string): Promise<PosOrderView | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;
  const lines = await db.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(asc(orderLines.lineNo));
  const pays = await db.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(asc(payments.createdAt));
  const [person] = order.personId
    ? await db.select({ firstName: persons.firstName, lastName: persons.lastName, email: persons.email }).from(persons).where(eq(persons.id, order.personId))
    : [];
  const paid = await paidCentsOf(db, orderId);
  const live = pays.find((p) => p.provider === "terminal" && (LIVE_STATUSES as readonly string[]).includes(p.status));
  return {
    orderId: order.id,
    reference: order.reference,
    status: order.status,
    channel: order.channel,
    personId: order.personId,
    personName: person ? [person.firstName, person.lastName].filter(Boolean).join(" ") || null : null,
    personEmail: person?.email ?? null,
    totalCents: order.totalCents,
    dueCents: Math.max(0, order.totalCents - paid),
    expiresAt: order.expiresAt,
    lines: lines.map((l) => ({ lineId: l.id, description: l.description, quantity: l.quantity, lineTotalCents: l.lineTotalCents, productKind: l.productKind })),
    payments: pays.map((p) => ({ paymentId: p.id, provider: p.provider, status: p.status, amountCents: p.amountCents, createdAt: p.createdAt })),
    liveTerminalPaymentId: live?.id ?? null,
    hasDatedLines: lines.some((l) => isDated(l.productKind)),
  };
}

/** The terminal dialog's poll: the payment's and its order's status (database only). */
export async function getPosPaymentState(db: DbOrTx, paymentId: string): Promise<{ paymentStatus: PaymentRow["status"]; orderStatus: OrderStatus; orderId: string } | null> {
  const [row] = await db
    .select({ paymentStatus: payments.status, orderStatus: orders.status, orderId: orders.id })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(eq(payments.id, paymentId));
  return row ?? null;
}
