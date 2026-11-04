/**
 * The order engine (commerce spec rules 19 to 27, edge cases 1, 6, 10, 11, 33; commerce-P4a).
 *
 * `createOrder` prices the items with `getQuote` at creation (rule 16), writes the order, its
 * immutable lines and pending vouchers, reserves the winning promotions under their row locks
 * (rule 19), consumes euro credit when asked (rule 25) and pays a zero due inline (rule 24). It
 * never calls booking: booking-originated session lines carry exactly one `bookingIds` element,
 * stored in `order_lines.data.booking_ids`, and the line ids come back in item order (rule 21,
 * cross-module D21). Everything runs in the caller's transaction.
 */
import { randomUUID } from "node:crypto";
import { orderLines, orders, payments, products, promotionRedemptions, promotions, sessions, vouchers } from "@beam/db/schema";
import {
  CartItem,
  DATED_PRODUCT_KINDS,
  newOrderReference,
  normalisePromoCode,
  type OrderChannel,
  type OrderStatus,
  type OrderSummary,
  type QuoteWarning,
} from "@beam/core/commerce";
import { formatDateTime, LOCALES, type Locale, type LocalizedText } from "@beam/core/i18n";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql, ConflictError, NotFoundError, ValidationError, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import { consumeCredits, getEuroBalance } from "@/modules/credits/api";
import { getCurrentLegalVersion } from "@/modules/site/api";
import { getQuote } from "./catalogue";
import { commerceSettings, finalizePaidOrder, ONLINE_CHANNELS, paidCentsOf, type OrderRow } from "./paid";

export type CreateOrderInput = {
  personId: string | null;
  companyId?: string | null;
  channel: OrderChannel;
  items: CartItem[];
  promoCode?: string | null;
  clientKey: string;
  checkoutId?: string;
  locale: Locale;
  useEuroCredit?: boolean;
  note?: string;
  /** Channel `admin` only (booking R63 pay-at-desk: the session's `ends_at`). */
  expiresAt?: Date;
};

export type CreateOrderResult = {
  orderId: string;
  reference: string;
  lineIds: string[];
  totalCents: number;
  status: OrderStatus;
  expiresAt: Date | null;
  isExisting: boolean;
};

/** Quote warnings that make an item unsellable: the order is refused instead of shrinking. */
const BLOCKING: Partial<Record<QuoteWarning["code"], "conflict" | "validation">> = {
  product_unavailable: "conflict",
  no_price: "conflict",
  amount_out_of_range: "validation",
  already_member: "conflict",
  pending_exists: "conflict",
};

/** Validates every item with the `CartItem` schema; field errors are keyed `items.<i>.<field>`. */
function parseItems(items: readonly unknown[]): CartItem[] {
  const fields: Record<string, string> = {};
  const out: CartItem[] = [];
  items.forEach((raw, i) => {
    const r = CartItem.safeParse(raw);
    if (r.success) out.push(r.data);
    else for (const issue of r.error.issues) fields[`items.${i}.${issue.path.join(".") || "item"}`] = issue.message;
  });
  if (!items.length) fields.items = "required";
  if (Object.keys(fields).length) throw new ValidationError("validation", fields);
  return out;
}

async function existingResult(tx: DbOrTx, order: OrderRow): Promise<CreateOrderResult> {
  const lines = await tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, order.id)).orderBy(orderLines.lineNo);
  return {
    orderId: order.id,
    reference: order.reference,
    lineIds: lines.map((l) => l.id),
    totalCents: order.totalCents,
    status: order.status,
    expiresAt: order.expiresAt,
    isExisting: true,
  };
}

/** Rule 20 and edge case 1: the same `client_key`, or a pending order of the same checkout. */
async function findExisting(tx: DbOrTx, clientKey: string, checkoutId: string | undefined): Promise<OrderRow | null> {
  const [byKey] = await tx.select().from(orders).where(eq(orders.clientKey, clientKey));
  if (byKey) return byKey;
  if (!checkoutId) return null;
  const [pending] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.checkoutId, checkoutId), eq(orders.status, "pending_payment")))
    .orderBy(desc(orders.createdAt))
    .limit(1);
  return pending ?? null;
}

/**
 * Locks the promotions a quote can use (the typed code and every live automatic promotion)
 * `FOR UPDATE`, so the `uses_count` and per-person counts the quote reads stay true until the
 * reservation below (rule 19, edge case 6).
 */
async function lockCandidatePromotions(tx: Tx, code: string | null | undefined, at: Date): Promise<void> {
  const typed = normalisePromoCode(code);
  const live = and(isNull(promotions.code), eq(promotions.isActive, true), lte(promotions.startsAt, at), or(isNull(promotions.endsAt), gt(promotions.endsAt, at)));
  await tx
    .select({ id: promotions.id })
    .from(promotions)
    .where(typed ? or(live, eq(promotions.code, typed)) : live)
    .orderBy(promotions.id)
    .for("update");
}

/** The line description: the product name, plus the session start for dated lines. */
function lineDescription(name: LocalizedText, startsAt: Date | null): LocalizedText {
  if (!startsAt) return name;
  const out: LocalizedText = {};
  for (const l of LOCALES) if (name[l]) out[l] = `${name[l]} · ${formatDateTime(startsAt, l, "medium")}`;
  return out;
}

export async function createOrder(tx: Tx, ctx: Ctx, input: CreateOrderInput): Promise<CreateOrderResult> {
  const items = parseItems(input.items);
  const channel = input.channel;
  if (input.expiresAt && channel !== "admin") throw new ValidationError("validation", { expiresAt: "admin_only" });
  if (input.expiresAt && input.expiresAt.getTime() <= ctx.now.getTime()) throw new ValidationError("validation", { expiresAt: "in_the_past" });
  const personId = input.personId ?? null;
  const companyId = input.companyId ?? null;
  if (!personId && !companyId && channel !== "pos") throw new ValidationError("validation", { personId: "required" });

  const existing = await findExisting(tx, input.clientKey, input.checkoutId);
  if (existing) return existingResult(tx, existing);

  // Rule 21: one seat per dated line, exactly one booking id except at the POS; checked before
  // anything is written.
  const ids = [...new Set(items.map((i) => i.productId))];
  const productRows = await tx.select().from(products).where(inArray(products.id, ids));
  const productById = new Map(productRows.map((p) => [p.id, p]));
  const fields: Record<string, string> = {};
  items.forEach((item, i) => {
    const product = productById.get(item.productId);
    if (!product) return;
    const dated = (DATED_PRODUCT_KINDS as readonly string[]).includes(product.kind);
    const bookingIds = item.bookingIds ?? [];
    if (dated) {
      if (item.quantity !== 1) fields[`items.${i}.quantity`] = "session_line_quantity";
      if (!item.sessionId) fields[`items.${i}.sessionId`] = "required";
      if (channel === "pos" ? bookingIds.length > 0 : bookingIds.length !== 1) fields[`items.${i}.bookingIds`] = channel === "pos" ? "pos_without_bookings" : "exactly_one_booking";
    } else if (bookingIds.length || item.sessionId) {
      fields[`items.${i}.bookingIds`] = "not_a_session_product";
    }
  });
  if (Object.keys(fields).length) throw new ValidationError("validation", fields);

  // Rule 26a: online orders store the current terms version (booking records the acceptance).
  let termsVersionId: string | null = null;
  if ((ONLINE_CHANNELS as readonly string[]).includes(channel)) {
    const terms = await getCurrentLegalVersion(tx, "terms");
    if (!terms) throw new ConflictError("terms_unavailable");
    termsVersionId = terms.versionId;
  }

  await lockCandidatePromotions(tx, input.promoCode, ctx.now);
  const quoted = await getQuote(tx, { personId, companyId, items, promoCode: input.promoCode ?? null, channel, at: ctx.now });
  for (const w of quoted.warnings) {
    const kind = BLOCKING[w.code];
    if (kind === "conflict") throw new ConflictError(w.code === "no_price" ? "product_unavailable" : w.code);
    if (kind === "validation") throw new ValidationError("validation", { items: w.code });
  }
  if (quoted.lines.length !== items.length) throw new ConflictError("product_unavailable");

  const settings = await commerceSettings(tx);
  const expiresAt = input.expiresAt ?? new Date(ctx.now.getTime() + settings.order_expiry_minutes * 60_000);
  const [order] = await tx
    .insert(orders)
    .values({
      reference: newOrderReference(),
      personId,
      companyId,
      checkoutId: input.checkoutId ?? null,
      channel,
      status: "pending_payment",
      subtotalCents: quoted.subtotalCents,
      discountCents: quoted.discountCents,
      vatCents: quoted.vatCents,
      totalCents: quoted.totalCents,
      promotionId: quoted.promotionId,
      locale: input.locale,
      clientKey: input.clientKey,
      expiresAt,
      termsVersionId,
      createdByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
      note: input.note ?? null,
    })
    .returning();
  const orderId = order!.id;

  // Lines in item order, with the session start in the description of dated lines.
  const sessionIds = [...new Set(items.map((i) => i.sessionId).filter((x): x is string => !!x))];
  const sessionRows = sessionIds.length ? await tx.select({ id: sessions.id, startsAt: sessions.startsAt }).from(sessions).where(inArray(sessions.id, sessionIds)) : [];
  const startOf = new Map(sessionRows.map((s) => [s.id, s.startsAt]));
  const lineIds: string[] = [];
  const voucherRows: (typeof vouchers.$inferInsert)[] = [];
  for (const [i, item] of items.entries()) {
    const q = quoted.lines[i]!;
    const product = productById.get(item.productId)!;
    const voucherIds = product.kind === "voucher" ? Array.from({ length: item.quantity }, () => randomUUID()) : [];
    const data: Record<string, unknown> = {};
    if (item.bookingIds?.length) data.booking_ids = item.bookingIds;
    if (item.startOn) data.start_on = item.startOn;
    if (voucherIds.length === 1) data.voucher_id = voucherIds[0];
    const [line] = await tx
      .insert(orderLines)
      .values({
        orderId,
        lineNo: i + 1,
        productId: product.id,
        productKind: product.kind,
        sku: product.sku,
        priceVersionId: q.priceVersionId,
        description: lineDescription(product.name, item.sessionId ? (startOf.get(item.sessionId) ?? null) : null),
        quantity: item.quantity,
        unitAmountCents: q.unitAmountCents,
        discountCents: q.discountCents,
        lineTotalCents: q.lineTotalCents,
        vatRatePct: q.vatRatePct.toFixed(2),
        vatCents: q.vatCents,
        promotionId: q.promotionId,
        pricingTrace: q.trace,
        sessionId: item.sessionId ?? null,
        ticketTypeId: item.ticketTypeId ?? null,
        data,
      })
      .returning({ id: orderLines.id });
    lineIds.push(line!.id);
    for (const id of voucherIds) {
      voucherRows.push({
        id,
        orderLineId: line!.id,
        amountCents: q.unitAmountCents,
        purchaserPersonId: personId,
        recipientName: item.voucher?.recipientName ?? null,
        recipientEmail: item.voucher?.recipientEmail?.toLowerCase() ?? null,
        message: item.voucher?.message ?? null,
        deliverOn: item.voucher?.deliverOn ?? null,
        status: "pending",
      });
    }
  }
  if (voucherRows.length) await tx.insert(vouchers).values(voucherRows);

  // Rule 19: one reserved redemption per winning promotion (code or automatic).
  const promoIds = [...new Set(quoted.lines.map((l) => l.promotionId).filter((x): x is string => !!x))];
  for (const promotionId of promoIds) {
    await tx.update(promotions).set({ usesCount: sql`${promotions.usesCount} + 1`, updatedAt: ctx.now }).where(eq(promotions.id, promotionId));
    await tx.insert(promotionRedemptions).values({ promotionId, orderId, personId, status: "reserved" });
  }

  // Rule 25: euro credit pays part or all of the order in this transaction.
  let creditCents = 0;
  if (input.useEuroCredit && personId && quoted.totalCents > 0) {
    const balance = await getEuroBalance(tx, personId);
    creditCents = Math.min(balance.remainingCents, quoted.totalCents);
    if (creditCents > 0) {
      await consumeCredits(tx, ctx, { personId, beneficiaryPersonId: personId, kind: "euro", units: creditCents, ref: { type: "order", id: orderId } });
      await tx.insert(payments).values({
        orderId,
        provider: "credit_balance",
        method: "credit_balance",
        status: "paid",
        amountCents: creditCents,
        paidAt: ctx.now,
        statusHistory: [{ status: "paid", at: ctx.now.toISOString(), source: "provider" }],
        createdByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
      });
    }
  }

  // Rule 24: nothing due -> paid in this transaction, without a provider call.
  let status: OrderStatus = "pending_payment";
  if (quoted.totalCents - creditCents <= 0) {
    await finalizePaidOrder(tx, ctx, orderId);
    status = "paid";
  }
  return { orderId, reference: order!.reference, lineIds, totalCents: quoted.totalCents, status, expiresAt, isExisting: false };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The return page's status read (database only, rule 30: the provider is asked by `payments.sync`). */
export async function getOrderStatus(db: DbOrTx, orderId: string): Promise<{ status: OrderStatus; paidAt: Date | null; dueCents: number }> {
  const [order] = await db.select({ status: orders.status, paidAt: orders.paidAt, totalCents: orders.totalCents }).from(orders).where(eq(orders.id, orderId));
  if (!order) throw new NotFoundError("order_not_found");
  const paid = await paidCentsOf(db, orderId);
  return { status: order.status, paidAt: order.paidAt, dueCents: Math.max(0, order.totalCents - paid) };
}

const PAID_ORDER_STATUSES: OrderStatus[] = ["paid", "partially_refunded", "refunded"];

/** ops and crm: paid orders and amounts, open orders and active vouchers bought by the person. */
export async function getPersonCommerceSummary(
  db: DbOrTx,
  personId: string,
): Promise<{ paidOrders: number; paidCents: number; lastPaidAt: Date | null; openOrders: number; activeVouchers: number }> {
  const [paid] = await db
    .select({
      n: sql<number>`count(*)::int`,
      cents: sql<number>`coalesce(sum(${orders.totalCents}), 0)::int`,
      last: sql<Date | string | null>`max(${orders.paidAt})`,
    })
    .from(orders)
    .where(and(eq(orders.personId, personId), inArray(orders.status, PAID_ORDER_STATUSES)));
  const [open] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.personId, personId), eq(orders.status, "pending_payment")));
  const [vouchersActive] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(vouchers)
    .where(and(eq(vouchers.purchaserPersonId, personId), eq(vouchers.status, "active")));
  return {
    paidOrders: Number(paid?.n ?? 0),
    paidCents: Number(paid?.cents ?? 0),
    lastPaidAt: paid?.last ? new Date(paid.last) : null,
    openOrders: Number(open?.n ?? 0),
    activeVouchers: Number(vouchersActive?.n ?? 0),
  };
}

/** crm's person 360 panel: the person's latest orders, newest first. */
export async function listPersonOrders(db: DbOrTx, personId: string, opts: { limit: number }): Promise<OrderSummary[]> {
  const rows = await db
    .select({
      orderId: orders.id,
      reference: orders.reference,
      channel: orders.channel,
      status: orders.status,
      totalCents: orders.totalCents,
      createdAt: orders.createdAt,
      paidAt: orders.paidAt,
      lineCount: sql<number>`(select count(*)::int from order_lines l where l.order_id = "orders"."id")`,
    })
    .from(orders)
    .where(eq(orders.personId, personId))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(Math.max(1, Math.min(200, opts.limit)));
  return rows.map((r) => ({ ...r, lineCount: Number(r.lineCount) }));
}

