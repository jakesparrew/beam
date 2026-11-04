/**
 * Staff orders (commerce spec rules 7, 21, 22a, 22b, 26b, 26c, 43; commerce-P6).
 *
 * `createStaffOrder` prices the basket for the person or company (`b2b` when a company is set,
 * rule 7) and writes a `draft` order of channel `admin` with its immutable lines and pending
 * vouchers: no expiry, no promotion reservation, no invoice. `choosePaymentPath` re-quotes the
 * draft (a price that moved since the draft answers `price_changed`, because lines never change),
 * reserves the winning promotions under their row locks (rule 19) and moves it to
 * `pending_payment`:
 * - `pos`: paid at the counter through `/admin/pos?order=<id>` (expires like any pending order);
 * - `link`: the order becomes a `link` order with the current terms version (the pay page asks
 *   for acceptance, rule 26a) and stays payable for the link's validity (`pay_link_days`);
 * - `bank_transfer`: refused with session, night or ticket lines; opens the transfer and its
 *   open invoice (`startBankTransfer`, rule 43).
 * `staffCancelOrder` is rule 22b for the staff action: the api's `{ cancelled: false }` becomes
 * `payment_in_progress` or `invalid_transition`.
 */
import { randomUUID } from "node:crypto";
import { emailMessages, files, orderLines, orders, persons, products, promotionRedemptions, promotions, sessions, vouchers } from "@beam/db/schema";
import { CartItem, DATED_PRODUCT_KINDS, newOrderReference, nextOrderStatus, type QuoteWarning } from "@beam/core/commerce";
import type { BillingDetails } from "@beam/core/finance";
import { formatDateTime, formatMoney, LOCALES, pick, type Locale, type LocalizedText } from "@beam/core/i18n";
import { and, asc, eq, inArray, ne, sql, ConflictError, NotFoundError, ValidationError, type Ctx, type Tx } from "@/lib/ctx";
import { storeFile } from "@/lib/files";
import { sendTransactional } from "@/modules/email/api";
import { setOrderBillingDetails } from "@/modules/finance/api";
import { getCurrentLegalVersion } from "@/modules/site/api";
import { loadReceiptInput, renderReceiptPdf } from "../ui/receipt-pdf";
import { startBankTransfer } from "./bank-transfer";
import { cancelOrderDetailed } from "./cancel";
import { getQuote } from "./catalogue";
import { commerceSettings, finalizePaidOrder, lockOrder, orderPageUrl, paidCentsOf, type OrderRow } from "./paid";

export type StaffOrderInput = {
  personId?: string | null | undefined;
  companyId?: string | null | undefined;
  items: CartItem[];
  promoCode?: string | null | undefined;
  note?: string | null | undefined;
  billingDetails?: BillingDetails | undefined;
  clientKey?: string | undefined;
  locale?: Locale | undefined;
};

export type PaymentPath = "pos" | "link" | "bank_transfer";

/** Quote warnings that make a staff basket unsellable (rule 26c and the catalogue rules). */
const BLOCKING: Partial<Record<QuoteWarning["code"], "conflict" | "validation">> = {
  product_unavailable: "conflict",
  no_price: "conflict",
  amount_out_of_range: "validation",
  already_member: "conflict",
  pending_exists: "conflict",
};

function lineDescription(name: LocalizedText, startsAt: Date | null): LocalizedText {
  if (!startsAt) return name;
  const out: LocalizedText = {};
  for (const l of LOCALES) if (name[l]) out[l] = `${name[l]} · ${formatDateTime(startsAt, l, "medium")}`;
  return out;
}

function assertSellable(warnings: QuoteWarning[]): void {
  for (const w of warnings) {
    const kind = BLOCKING[w.code];
    if (kind === "conflict") throw new ConflictError(w.code === "no_price" ? "product_unavailable" : w.code);
    if (kind === "validation") throw new ValidationError("validation", { items: w.code });
  }
}

/** `createStaffOrder` (staff, `commerce.sell`): a `draft` order of channel `admin` (rule 22a). */
export async function createStaffOrder(tx: Tx, ctx: Ctx, input: StaffOrderInput): Promise<{ orderId: string; reference: string; totalCents: number; isExisting: boolean }> {
  const personId = input.personId ?? null;
  const companyId = input.companyId ?? null;
  if (!personId && !companyId) throw new ValidationError("validation", { personId: "required" });
  const clientKey = input.clientKey ?? randomUUID();
  const [existing] = await tx.select().from(orders).where(eq(orders.clientKey, clientKey));
  if (existing) return { orderId: existing.id, reference: existing.reference, totalCents: existing.totalCents, isExisting: true };

  const fields: Record<string, string> = {};
  const items: CartItem[] = [];
  input.items.forEach((raw, i) => {
    const r = CartItem.safeParse(raw);
    if (r.success) items.push(r.data);
    else for (const issue of r.error.issues) fields[`items.${i}.${issue.path.join(".") || "item"}`] = issue.message;
  });
  if (!input.items.length) fields.items = "required";
  if (Object.keys(fields).length) throw new ValidationError("validation", fields);

  const productRows = await tx.select().from(products).where(inArray(products.id, [...new Set(items.map((i) => i.productId))]));
  const productById = new Map(productRows.map((p) => [p.id, p]));
  items.forEach((item, i) => {
    const product = productById.get(item.productId);
    if (!product) return;
    const dated = (DATED_PRODUCT_KINDS as readonly string[]).includes(product.kind);
    if (dated) {
      if (item.quantity !== 1) fields[`items.${i}.quantity`] = "session_line_quantity";
      if (!item.sessionId) fields[`items.${i}.sessionId`] = "required";
      if ((item.bookingIds ?? []).length !== 1) fields[`items.${i}.bookingIds`] = "exactly_one_booking";
    } else if (item.bookingIds?.length || item.sessionId) fields[`items.${i}.bookingIds`] = "not_a_session_product";
  });
  if (Object.keys(fields).length) throw new ValidationError("validation", fields);

  const quoted = await getQuote(tx, { personId, companyId, items, promoCode: input.promoCode ?? null, channel: "admin", at: ctx.now });
  assertSellable(quoted.warnings);
  if (quoted.lines.length !== items.length) throw new ConflictError("product_unavailable");

  const [order] = await tx
    .insert(orders)
    .values({
      reference: newOrderReference(),
      personId,
      companyId,
      channel: "admin",
      status: "draft",
      subtotalCents: quoted.subtotalCents,
      discountCents: quoted.discountCents,
      vatCents: quoted.vatCents,
      totalCents: quoted.totalCents,
      promotionId: quoted.promotionId,
      locale: input.locale ?? ctx.locale,
      clientKey,
      expiresAt: null,
      createdByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
      note: input.note?.trim() || null,
    })
    .returning();
  const orderId = order!.id;

  const sessionIds = [...new Set(items.map((i) => i.sessionId).filter((x): x is string => !!x))];
  const sessionRows = sessionIds.length ? await tx.select({ id: sessions.id, startsAt: sessions.startsAt }).from(sessions).where(inArray(sessions.id, sessionIds)) : [];
  const startOf = new Map(sessionRows.map((s) => [s.id, s.startsAt]));
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
  if (input.billingDetails) await setOrderBillingDetails(tx, ctx, { orderId, details: input.billingDetails });
  await ctx.audit({ action: "order.created", entityType: "order", entityId: orderId, ...(personId ? { personId } : {}), newValue: { reference: order!.reference, totalCents: quoted.totalCents, companyId } });
  return { orderId, reference: order!.reference, totalCents: quoted.totalCents, isExisting: false };
}

/** The cart items a draft's lines were priced from (for the re-quote of rule 22a). */
async function itemsOfOrder(tx: Tx, orderId: string) {
  const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(asc(orderLines.lineNo));
  const items: CartItem[] = lines.map((l) => ({
    productId: l.productId,
    quantity: l.quantity,
    ...(l.sessionId ? { sessionId: l.sessionId } : {}),
    ...(l.ticketTypeId ? { ticketTypeId: l.ticketTypeId } : {}),
    ...(l.data.booking_ids?.length ? { bookingIds: l.data.booking_ids } : {}),
    ...(l.data.start_on ? { startOn: l.data.start_on } : {}),
    ...(l.productKind === "voucher" && !l.priceVersionId ? { amountCents: l.unitAmountCents } : {}),
  }));
  return { lines, items };
}

/** Rule 19 for a draft: the promotions its lines won, reserved under their row locks. */
async function reservePromotions(tx: Tx, ctx: Ctx, order: OrderRow, promotionIds: string[]): Promise<void> {
  for (const promotionId of promotionIds) {
    const [promo] = await tx.select().from(promotions).where(eq(promotions.id, promotionId)).for("update");
    if (!promo) throw new ConflictError("promo_unknown");
    if (promo.maxUses != null && promo.usesCount >= promo.maxUses) throw new ConflictError("promo_exhausted");
    if (promo.maxUsesPerPerson != null && order.personId) {
      const [used] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(promotionRedemptions)
        .where(and(eq(promotionRedemptions.promotionId, promotionId), eq(promotionRedemptions.personId, order.personId), ne(promotionRedemptions.status, "released")));
      if (Number(used?.n ?? 0) >= promo.maxUsesPerPerson) throw new ConflictError("promo_exhausted");
    }
    await tx.update(promotions).set({ usesCount: sql`${promotions.usesCount} + 1`, updatedAt: ctx.now }).where(eq(promotions.id, promotionId));
    await tx.insert(promotionRedemptions).values({ promotionId, orderId: order.id, personId: order.personId, status: "reserved" }).onConflictDoNothing();
  }
}

/** `choosePaymentPath` (staff, `commerce.sell`): `draft -> pending_payment` on one of the three paths (rule 22a). */
export async function choosePaymentPath(tx: Tx, ctx: Ctx, input: { orderId: string; path: PaymentPath }): Promise<{ status: OrderRow["status"]; dueOn?: string }> {
  const order = await lockOrder(tx, input.orderId);
  if (!order) throw new NotFoundError("order_not_found");
  if (order.status !== "draft" || nextOrderStatus(order.status, "pending_payment") === null) throw new ConflictError("invalid_transition");
  const { lines, items } = await itemsOfOrder(tx, order.id);
  if (input.path === "bank_transfer" && lines.some((l) => (DATED_PRODUCT_KINDS as readonly string[]).includes(l.productKind))) {
    throw new ConflictError("bank_transfer_not_allowed");
  }

  // Re-quote: lines are immutable, so a draft whose price moved is refused (staff create a new one).
  let promoCode: string | null = null;
  if (order.promotionId) {
    const [p] = await tx.select({ code: promotions.code }).from(promotions).where(eq(promotions.id, order.promotionId));
    promoCode = p?.code ?? null;
  }
  const fresh = await getQuote(tx, { personId: order.personId, companyId: order.companyId, items, promoCode, channel: "admin", at: ctx.now });
  assertSellable(fresh.warnings);
  const same =
    fresh.lines.length === lines.length &&
    fresh.lines.every((q, i) => {
      const l = lines[i]!;
      return q.unitAmountCents === l.unitAmountCents && q.discountCents === l.discountCents && q.lineTotalCents === l.lineTotalCents && (q.promotionId ?? null) === (l.promotionId ?? null);
    });
  if (!same) throw new ConflictError("price_changed");
  await reservePromotions(tx, ctx, order, [...new Set(lines.map((l) => l.promotionId).filter((x): x is string => !!x))]);

  const settings = await commerceSettings(tx);
  const patch: Partial<typeof orders.$inferInsert> = { status: "pending_payment", updatedAt: ctx.now };
  if (input.path === "pos") patch.expiresAt = new Date(ctx.now.getTime() + settings.order_expiry_minutes * 60_000);
  if (input.path === "link") {
    const terms = await getCurrentLegalVersion(tx, "terms");
    if (!terms) throw new ConflictError("terms_unavailable");
    patch.channel = "link";
    patch.termsVersionId = terms.versionId;
    patch.expiresAt = new Date(ctx.now.getTime() + settings.pay_link_days * 86_400_000);
  }
  await tx
    .update(orders)
    .set({ ...patch, version: sql`${orders.version} + 1` })
    .where(eq(orders.id, order.id));
  await ctx.audit({ action: "order.payment_path_chosen", entityType: "order", entityId: order.id, ...(order.personId ? { personId: order.personId } : {}), oldValue: { status: "draft" }, newValue: { status: "pending_payment", path: input.path } });

  // Rule 24: nothing due (a 100 % promotion) is paid at once.
  if (order.totalCents - (await paidCentsOf(tx, order.id)) <= 0) {
    await finalizePaidOrder(tx, ctx, order.id);
    return { status: "paid" };
  }
  if (input.path === "bank_transfer") {
    const transfer = await startBankTransfer(tx, ctx, { orderId: order.id });
    return { status: "pending_payment", dueOn: transfer.dueOn };
  }
  return { status: "pending_payment" };
}

/**
 * `emailReceipt` (staff, `commerce.sell`): sends the receipt PDF again, as
 * `commerce.order_confirmation` (online and admin orders) or `commerce.pos_receipt` (POS), with
 * key `order:<order_id>:receipt:<n>` (n = earlier resends + 1).
 */
export async function emailReceipt(tx: Tx, ctx: Ctx, input: { orderId: string; email?: string | undefined }): Promise<{ ok: true; n: number }> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId));
  if (!order) throw new NotFoundError("order_not_found");
  if (!["paid", "partially_refunded", "refunded"].includes(order.status)) throw new ConflictError("invalid_transition");
  let to = input.email?.trim().toLowerCase() || null;
  if (!to && order.personId) {
    const [p] = await tx.select({ email: persons.email }).from(persons).where(eq(persons.id, order.personId));
    to = p?.email ?? null;
  }
  if (!to) throw new ValidationError("validation", { email: "required" });
  const receipt = await loadReceiptInput(tx, order.id);
  if (!receipt) throw new NotFoundError("order_not_found");
  const name = `receipt-${order.reference}.pdf`;
  const [existing] = await tx.select({ id: files.id }).from(files).where(and(eq(files.kind, "receipt"), eq(files.name, name)));
  const fileId =
    existing?.id ??
    (await storeFile(ctx, { kind: "receipt", name, mime: "application/pdf", bytes: await renderReceiptPdf(receipt), ...(order.personId ? { personId: order.personId } : {}) })).fileId;
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(emailMessages)
    .where(sql`${emailMessages.idempotencyKey} like ${`order:${order.id}:receipt:%`}`);
  const n = Number(count?.n ?? 0) + 1;
  const locale = order.locale as Locale;
  await sendTransactional(ctx, {
    template: order.channel === "pos" ? "commerce.pos_receipt" : "commerce.order_confirmation",
    ...(order.personId ? { personId: order.personId } : {}),
    to,
    locale,
    data: {
      reference: order.reference,
      total: formatMoney(order.totalCents, locale),
      lines: receipt.lines.map((l) => ({ description: pick(l.description, locale, "order_lines.description"), quantity: l.quantity, amount: formatMoney(l.lineTotalCents, locale) })),
      orderUrl: orderPageUrl(order.id, locale),
    },
    key: `order:${order.id}:receipt:${n}`,
    attachments: [{ fileId, filename: `BEAM-${order.reference}.pdf` }],
  });
  await ctx.audit({ action: "receipt.emailed", entityType: "order", entityId: order.id, ...(order.personId ? { personId: order.personId } : {}), newValue: { n, toOther: !!input.email } });
  return { ok: true, n };
}

/** The staff `cancelOrder` action (rule 22b): a refusal becomes `payment_in_progress` or `invalid_transition`. */
export async function staffCancelOrder(tx: Tx, ctx: Ctx, input: { orderId: string; reason: string }): Promise<{ ok: true }> {
  const before = await lockOrder(tx, input.orderId);
  if (!before) throw new NotFoundError("order_not_found");
  const outcome = await cancelOrderDetailed(tx, ctx, { orderId: input.orderId, reason: input.reason.trim() });
  if (!outcome.cancelled) throw new ConflictError(outcome.reason);
  await ctx.audit({ action: "order.cancelled", entityType: "order", entityId: before.id, ...(before.personId ? { personId: before.personId } : {}), oldValue: { status: before.status }, newValue: { status: "cancelled", reason: input.reason.trim() } });
  return { ok: true };
}
