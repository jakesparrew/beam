/**
 * Test fixtures of booking-P3a (BS-23): open sessions, actors, transactions with their own
 * context, booking rules and a fake `commerce.createOrder` that writes real `orders` and
 * `order_lines` rows (commerce-P4a lands the real one). Imported by the booking-P3a test files
 * only; never by production code.
 */
import { randomUUID } from "node:crypto";
import type { Db, DbOrTx, Tx } from "@beam/db";
import { orderLines, orders, products, settings } from "@beam/db/schema";
import { makePerson, makeProduct, makeSession, type SessionRow } from "@beam/db/testing";
import { ensureTermsVersion, TERMS_CHANNELS } from "@beam/db/testing/commerce-factories";
import { DEFAULT_BOOKING_RULES, type BookingRules } from "@beam/core/booking";
import { createCtx, eq, type Actor, type Ctx } from "@/lib/ctx";
import type { CreateOrderInput } from "@/modules/commerce/api";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** A published, open session (default: a day block in two days, 10 seats, one day credit). */
export async function openSession(db: DbOrTx, overrides: Parameters<typeof makeSession>[1] = {}): Promise<SessionRow> {
  const startsAt = overrides.startsAt ?? new Date(Date.now() + 2 * DAY);
  return makeSession(db, { startsAt, publishedAt: new Date(Date.now() - DAY), creditCost: 1, ...overrides });
}

/** A `session` product with a public price (order-paid bookings). */
export function sessionProduct(db: DbOrTx, priceCents = 2500) {
  return makeProduct(db, { kind: "session", priceCents });
}

export function customerActor(personId: string, userId: string = randomUUID()): Extract<Actor, { kind: "customer" }> {
  return { kind: "customer", userId, personId };
}

/** Runs `fn` in a real transaction with its own context, the way `action()` does. */
export function inTx<T>(db: Db, actor: Actor, fn: (tx: Tx, ctx: Ctx) => Promise<T>, now: Date = new Date()): Promise<T> {
  return db.transaction(async (tx) => fn(tx, createCtx({ tx, actor, now, durableMode: "immediate", locale: "nl-BE" })));
}

/** Stores `booking_rules` (defaults merged with `patch`). */
export async function setBookingRules(db: DbOrTx, patch: Partial<BookingRules> = {}): Promise<BookingRules> {
  const value: BookingRules = { ...structuredClone(DEFAULT_BOOKING_RULES), ...patch };
  await db
    .insert(settings)
    .values({ key: "booking_rules", value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
  return value;
}

export type CreateOrderCall = CreateOrderInput;

/**
 * A `createOrder` double: one `orders` row (`pending_payment`, `expires_at` = `input.expiresAt`
 * or now + 30 min) and one `order_lines` row per item with `data.booking_ids`; returns the line
 * ids in item order. A `portal`, `site` or `link` order carries the database's terms version
 * (`ensureTermsVersion`). The same `clientKey` twice returns the existing order (`isExisting`).
 */
export function fakeCreateOrder(calls: CreateOrderCall[] = []) {
  return async (tx: Tx, _ctx: Ctx, input: CreateOrderInput) => {
    calls.push(input);
    const [existing] = await tx.select().from(orders).where(eq(orders.clientKey, input.clientKey));
    if (existing) {
      const lines = await tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, existing.id)).orderBy(orderLines.lineNo);
      return {
        orderId: existing.id,
        reference: existing.reference,
        lineIds: lines.map((l) => l.id),
        totalCents: existing.totalCents,
        status: existing.status,
        expiresAt: existing.expiresAt,
        isExisting: true,
      };
    }
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 30 * 60_000);
    const unit = 2500;
    const total = unit * input.items.length;
    const [order] = await tx
      .insert(orders)
      .values({
        personId: input.personId,
        channel: input.channel,
        subtotalCents: total,
        vatCents: 0,
        totalCents: total,
        locale: input.locale,
        clientKey: input.clientKey,
        expiresAt,
        // orders_terms_chk: the real createOrder stores the accepted terms version of a portal order.
        ...(TERMS_CHANNELS.includes(input.channel) ? { termsVersionId: (await ensureTermsVersion(tx)).id } : {}),
      })
      .returning();
    const lineIds: string[] = [];
    let lineNo = 1;
    for (const item of input.items) {
      const [product] = await tx.select().from(products).where(eq(products.id, item.productId));
      const [line] = await tx
        .insert(orderLines)
        .values({
          orderId: order!.id,
          lineNo: lineNo++,
          productId: item.productId,
          productKind: product!.kind,
          sku: product!.sku,
          description: product!.name,
          quantity: item.quantity,
          unitAmountCents: unit,
          lineTotalCents: unit * item.quantity,
          vatRatePct: "0.00",
          vatCents: 0,
          pricingTrace: { test: true },
          sessionId: item.sessionId ?? null,
          data: item.bookingIds ? { booking_ids: item.bookingIds } : {},
        })
        .returning({ id: orderLines.id });
      lineIds.push(line!.id);
    }
    return { orderId: order!.id, reference: order!.reference, lineIds, totalCents: total, status: order!.status, expiresAt, isExisting: false };
  };
}

/** An order with one session line and no booking (a POS sale before `createBookingForPosLine`). */
export async function posOrderLine(db: DbOrTx, sessionId: string, opts: { personId?: string | null; expiresAt?: Date } = {}): Promise<{ orderId: string; lineId: string }> {
  const product = await sessionProduct(db);
  const [order] = await db
    .insert(orders)
    .values({
      personId: opts.personId ?? (await makePerson(db)).id,
      channel: "pos",
      subtotalCents: 2500,
      vatCents: 0,
      totalCents: 2500,
      locale: "nl-BE",
      clientKey: randomUUID(),
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 15 * 60_000),
    })
    .returning();
  const [line] = await db
    .insert(orderLines)
    .values({
      orderId: order!.id,
      lineNo: 1,
      productId: product.id,
      productKind: product.kind,
      sku: product.sku,
      description: product.name,
      quantity: 1,
      unitAmountCents: 2500,
      lineTotalCents: 2500,
      vatRatePct: "0.00",
      vatCents: 0,
      pricingTrace: { test: true },
      sessionId,
    })
    .returning({ id: orderLines.id });
  return { orderId: order!.id, lineId: line!.id };
}

/**
 * fix-w09-booking-review: a `createOrder` double for an order with nothing due (euro credit or a
 * promo covers the total, commerce rule 24): like `fakeCreateOrder`, then the order is `paid` and
 * `confirmBookingsForOrder` runs in the same transaction, as commerce's `finalizePaidOrder` does.
 */
export function fakeSettledCreateOrder(calls: CreateOrderCall[] = []) {
  const create = fakeCreateOrder(calls);
  return async (tx: Tx, ctx: Ctx, input: CreateOrderInput) => {
    const result = await create(tx, ctx, input);
    await tx.update(orders).set({ status: "paid", paidAt: ctx.now, expiresAt: null }).where(eq(orders.id, result.orderId));
    const { confirmOrderBookings } = await import("./order-hooks");
    await confirmOrderBookings(tx, ctx, result.orderId);
    return { ...result, status: "paid" as const, expiresAt: null };
  };
}
