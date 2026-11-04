/**
 * Customer checkout (commerce spec rules 16, 20, 26 to 26c, 48 to 50, edge cases 23 and 30;
 * commerce-P5): the `checkouts` lifecycle behind the portal shop and the site guest checkout,
 * the order payment page (`payOrder`), payment retries and `checkouts.mark_abandoned`.
 *
 * - A checkout row is created when the customer opens the checkout step with at least one item;
 *   every step re-quotes and stores `items`, `total_cents` and `last_activity_at` (rule 48).
 * - Quotes use only the person a session proves (edge case 23): a site guest quotes as `public`
 *   even when the email belongs to a member; the order still attaches to that person.
 * - `placeOrder` records the terms acceptance (rule 26a), stores the company invoice details
 *   through finance (rule 26b) and starts the provider payment inline; `createOrder` refuses a
 *   membership the person cannot start (rule 26c).
 * - Guests are recognised by a signed viewer cookie (`beam_checkout`) that lists the checkouts
 *   and orders this browser created; signed-in customers by their person id.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { checkouts, orderLines, orders, payments, products, refunds, vouchers } from "@beam/db/schema";
import { CartItem, type Quote } from "@beam/core/commerce";
import { BillingDetailsInput } from "@beam/core/finance";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { and, asc, desc, eq, inArray, isNotNull, lt, lte, notInArray, or, sql, AppError, ConflictError, NotFoundError, RateLimitedError, ValidationError, type Actor, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { rateLimit } from "@/lib/rate-limit";
import { consumeCredits, getEuroBalance } from "@/modules/credits/api";
import { findOrCreatePersonByEmail } from "@/modules/crm/api";
import { setOrderBillingDetails } from "@/modules/finance/api";
import { getCurrentLegalVersion, recordTermsAcceptance } from "@/modules/site/api";
import { getQuote } from "./catalogue";
import { cancelOrder } from "./cancel";
import { createOrder } from "./orders";
import { lockOrder, paidCentsOf, PAID_PAYMENT_STATUSES, type OrderRow } from "./paid";
import { LIVE_PAYMENT_STATUSES, returnUrlFor, startPayment } from "./payments";

export type CheckoutRow = typeof checkouts.$inferSelect;
export type CheckoutChannel = "portal" | "site";

/** Product kinds the portal shop and the site checkout sell (rule 21: dated lines start in booking). */
export const SHOP_KINDS = ["package", "membership", "voucher", "item"] as const;

/** Rule 49: an abandoned checkout has had no activity for 60 minutes. */
export const ABANDON_AFTER_MS = 60 * 60_000;
/** Rule 50: a checkout expires 30 days after creation. */
export const CHECKOUT_TTL_MS = 30 * 24 * 60 * 60_000;
const BATCH = 500;
const LOCAL_PROVIDERS = ["cash", "bank_transfer", "credit_balance"] as const;

// ---------------------------------------------------------------------------
// The viewer: who may read and change a checkout or an order
// ---------------------------------------------------------------------------

/** The session person (customer) plus the checkouts and orders the signed viewer cookie lists. */
export type CheckoutViewer = { personId: string | null; checkoutIds?: readonly string[]; orderIds?: readonly string[] };

export const VIEWER_COOKIE = "beam_checkout";
const MAX_COOKIE_ENTRIES = 12;

function viewerSecret(): string {
  return process.env.AUTH_SECRET || process.env.VOUCHER_CODE_SECRET || "beam-dev-checkout-viewer";
}

function sign(kind: "c" | "o", id: string): string {
  return createHmac("sha256", viewerSecret()).update(`checkout_viewer:${kind}:${id}`).digest("base64url").slice(0, 32);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Parses `c.<id>.<sig>~o.<id>.<sig>`; entries with a bad signature are dropped. */
export function parseViewerCookie(value: string | null | undefined): { checkoutIds: string[]; orderIds: string[] } {
  const checkoutIds: string[] = [];
  const orderIds: string[] = [];
  for (const entry of (value ?? "").split("~")) {
    const [kind, id, sig] = entry.split(".");
    if ((kind !== "c" && kind !== "o") || !id || !sig || !z.uuid().safeParse(id).success) continue;
    if (!safeEqual(sig, sign(kind, id))) continue;
    (kind === "c" ? checkoutIds : orderIds).push(id);
  }
  return { checkoutIds, orderIds };
}

/** The cookie value with `id` added (newest first, at most 12 entries). */
export function addToViewerCookie(value: string | null | undefined, kind: "checkout" | "order", id: string): string {
  const k = kind === "checkout" ? "c" : "o";
  const entry = `${k}.${id}.${sign(k, id)}`;
  const rest = (value ?? "").split("~").filter((e) => e && e !== entry);
  return [entry, ...rest].slice(0, MAX_COOKIE_ENTRIES).join("~");
}

/** The viewer of the current request: the customer's person id plus the signed cookie entries. */
export async function readViewer(actor: Actor | null): Promise<CheckoutViewer> {
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  const parsed = parseViewerCookie(jar.get(VIEWER_COOKIE)?.value);
  return { personId: actor?.kind === "customer" ? actor.personId : null, ...parsed };
}

/** Adds a checkout or order to the viewer cookie (server actions only; 30 days, http-only). */
export async function rememberInViewer(kind: "checkout" | "order", id: string): Promise<void> {
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  jar.set(VIEWER_COOKIE, addToViewerCookie(jar.get(VIEWER_COOKIE)?.value, kind, id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 24 * 3600,
  });
}

function canSeeCheckout(c: Pick<CheckoutRow, "id" | "personId">, viewer: CheckoutViewer): boolean {
  if (c.personId && viewer.personId === c.personId) return true;
  return !!viewer.checkoutIds?.includes(c.id);
}

export function canSeeOrder(o: Pick<OrderRow, "id" | "personId" | "checkoutId">, viewer: CheckoutViewer): boolean {
  if (o.personId && viewer.personId === o.personId) return true;
  if (viewer.orderIds?.includes(o.id)) return true;
  return !!o.checkoutId && !!viewer.checkoutIds?.includes(o.checkoutId);
}

/** Edge case 23: only a person the session proves gets person pricing. */
function pricingPersonOf(c: Pick<CheckoutRow, "personId">, viewer: CheckoutViewer): string | null {
  return viewer.personId && c.personId === viewer.personId ? viewer.personId : null;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const Utm = z
  .object({ source: z.string().max(200), medium: z.string().max(200), campaign: z.string().max(200), term: z.string().max(200), content: z.string().max(200) })
  .partial();
const Items = z.array(CartItem).min(1).max(20);
const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const StartCheckoutInput = z.object({
  channel: z.enum(["portal", "site"]),
  items: Items,
  locale: z.enum(LOCALES),
  utm: Utm.optional(),
  landingPath: z.string().max(300).optional(),
  email: Email.optional(),
});
export const UpdateCheckoutInput = z.object({
  checkoutId: z.uuid(),
  items: Items.optional(),
  promoCode: z.string().trim().max(40).nullable().optional(),
  email: Email.optional(),
});
export const PlaceOrderInput = z.object({
  checkoutId: z.uuid(),
  clientKey: z.uuid(),
  useEuroCredit: z.boolean(),
  acceptTerms: z.literal(true),
  billingDetails: BillingDetailsInput.optional(),
  /** The total the page showed; a different fresh quote answers `price_changed` (rule 16). */
  expectedTotalCents: z.number().int().min(0).optional(),
});
export const PayOrderInput = z.object({
  orderId: z.uuid(),
  clientKey: z.uuid(),
  useEuroCredit: z.boolean(),
  /** Required unless the order already carries the current terms version (rule 26a). */
  acceptTerms: z.boolean().optional(),
  billingDetails: BillingDetailsInput.optional(),
});
export const RetryPaymentInput = z.object({ orderId: z.uuid(), clientKey: z.uuid() });

/**
 * `checkouts.landing_path` (D56): the `from` query parameter of site buy links when it is a
 * local path, else the path of a same-origin `Referer`.
 */
export function landingPathFrom(from: string | null | undefined, referer: string | null | undefined, origin: string): string | null {
  const local = (p: string) => p.startsWith("/") && !p.startsWith("//") && !p.includes("\\");
  if (from && local(from)) return from.split("#")[0]!.slice(0, 300);
  if (!referer) return null;
  try {
    const url = new URL(referer);
    if (url.origin !== new URL(origin).origin) return null;
    return url.pathname.slice(0, 300);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

async function assertSellable(db: DbOrTx, items: CartItem[]): Promise<void> {
  const ids = [...new Set(items.map((i) => i.productId))];
  const rows = await db.select({ id: products.id, kind: products.kind }).from(products).where(inArray(products.id, ids));
  const kindOf = new Map(rows.map((r) => [r.id, r.kind]));
  const fields: Record<string, string> = {};
  items.forEach((item, i) => {
    const kind = kindOf.get(item.productId);
    if (!kind) fields[`items.${i}.productId`] = "product_unavailable";
    else if (!(SHOP_KINDS as readonly string[]).includes(kind)) fields[`items.${i}.productId`] = "not_sold_online";
    else if (item.bookingIds?.length || item.sessionId) fields[`items.${i}.bookingIds`] = "not_a_session_product";
  });
  if (Object.keys(fields).length) throw new ValidationError("validation", fields);
}

function quoteCheckout(db: DbOrTx, c: Pick<CheckoutRow, "channel" | "items" | "promoCode">, personId: string | null, at: Date): Promise<Quote> {
  return getQuote(db, { personId, items: c.items as CartItem[], promoCode: c.promoCode, channel: c.channel, at });
}

/** Two quotes price the basket the same (lines, promotion and total). */
function sameQuote(a: Quote, b: Quote): boolean {
  if (a.totalCents !== b.totalCents || a.lines.length !== b.lines.length) return false;
  return a.lines.every((l, i) => l.lineTotalCents === b.lines[i]!.lineTotalCents && l.productId === b.lines[i]!.productId);
}

/** Locks an open checkout the viewer may change (`started`, or `abandoned` when the customer comes back). */
async function lockCheckout(tx: Tx, checkoutId: string, viewer: CheckoutViewer, now: Date): Promise<CheckoutRow> {
  const [c] = await tx.select().from(checkouts).where(eq(checkouts.id, checkoutId)).for("update");
  if (!c || !canSeeCheckout(c, viewer)) throw new NotFoundError("checkout_not_found");
  if (c.status !== "started" && c.status !== "abandoned") throw new ConflictError("checkout_closed");
  if (c.expiresAt.getTime() <= now.getTime()) throw new ConflictError("checkout_closed");
  return c;
}

/** Public actions: 5 placements or payments per minute per checkout or order (section 4.2). */
async function limitPay(tx: Tx, ctx: Ctx, id: string): Promise<void> {
  const verdict = await rateLimit(tx, { key: `commerce:pay:${id}`, limit: 5, windowSeconds: 60 }, ctx.now);
  if (!verdict.ok) throw new RateLimitedError(verdict.retryAfterSeconds);
}

async function currentTerms(tx: DbOrTx): Promise<{ versionId: string }> {
  const terms = await getCurrentLegalVersion(tx, "terms");
  if (!terms) throw new ConflictError("terms_unavailable");
  return terms;
}

// ---------------------------------------------------------------------------
// startCheckout, updateCheckout
// ---------------------------------------------------------------------------

/**
 * Rule 48: creates the checkout with its first quote. Portal checkouts belong to the signed-in
 * person; site checkouts to the signed-in person, else to the guest's email (email step first).
 */
export async function startCheckout(
  tx: Tx,
  ctx: Ctx,
  input: z.infer<typeof StartCheckoutInput>,
  viewer: CheckoutViewer,
): Promise<{ checkoutId: string; quote: Quote }> {
  const personId = viewer.personId ?? null;
  if (input.channel === "portal" && !personId) throw new AppError("unauthorized");
  const email = input.email?.trim().toLowerCase() || null;
  if (!personId && !email) throw new ValidationError("validation", { email: "required" });
  await assertSellable(tx, input.items);
  const quote = await getQuote(tx, { personId, items: input.items, promoCode: null, channel: input.channel, at: ctx.now });
  const [row] = await tx
    .insert(checkouts)
    .values({
      personId,
      email,
      channel: input.channel,
      items: input.items,
      totalCents: quote.totalCents,
      locale: input.locale,
      utm: input.utm && Object.keys(input.utm).length ? input.utm : null,
      landingPath: input.landingPath ?? null,
      lastActivityAt: ctx.now,
      expiresAt: new Date(ctx.now.getTime() + CHECKOUT_TTL_MS),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning({ id: checkouts.id });
  const checkoutId = row!.id;
  if (personId) {
    await ctx.recordEvent({
      kind: "checkout.started",
      personId,
      ref: { type: "checkout", id: checkoutId },
      dedupeKey: `checkout:${checkoutId}:started`,
      data: { checkout_id: checkoutId, channel: input.channel },
    });
  }
  return { checkoutId, quote };
}

/**
 * Rules 16 and 48: re-quotes the stored basket (`priceChanged` when that total differs from the
 * stored `total_cents`), applies the change, quotes again and stores the result.
 */
export async function updateCheckout(
  tx: Tx,
  ctx: Ctx,
  input: z.infer<typeof UpdateCheckoutInput>,
  viewer: CheckoutViewer,
): Promise<{ quote: Quote; priceChanged: boolean }> {
  const c = await lockCheckout(tx, input.checkoutId, viewer, ctx.now);
  const pricingPerson = pricingPersonOf(c, viewer);
  const previous = await quoteCheckout(tx, c, pricingPerson, ctx.now);
  const priceChanged = c.totalCents !== null && previous.totalCents !== c.totalCents;
  if (input.items) await assertSellable(tx, input.items);
  const next = {
    items: input.items ?? (c.items as CartItem[]),
    promoCode: input.promoCode !== undefined ? input.promoCode || null : c.promoCode,
  };
  const changed = input.items !== undefined || input.promoCode !== undefined;
  const quote = changed ? await quoteCheckout(tx, { channel: c.channel, ...next }, pricingPerson, ctx.now) : previous;
  await tx
    .update(checkouts)
    .set({
      items: next.items,
      promoCode: next.promoCode,
      totalCents: quote.totalCents,
      ...(input.email && !c.personId ? { email: input.email.trim().toLowerCase() } : {}),
      lastActivityAt: ctx.now,
      updatedAt: ctx.now,
    })
    .where(eq(checkouts.id, c.id));
  return { quote, priceChanged };
}

// ---------------------------------------------------------------------------
// placeOrder, payOrder, retryPayment
// ---------------------------------------------------------------------------

export type PlaceOrderOptions = { referralCode?: string | null };

/**
 * Rules 20, 26 to 26c: creates the order from the checkout (a second submit with the same
 * `clientKey` returns the open order and its provider page), records the terms acceptance and
 * the company invoice details, then runs `payments.create` inline. A zero due is paid in the
 * same transaction and redirects to the return page.
 */
export async function placeOrder(
  tx: Tx,
  ctx: Ctx,
  input: z.infer<typeof PlaceOrderInput>,
  viewer: CheckoutViewer,
  opts: PlaceOrderOptions = {},
): Promise<{ orderId: string; redirectUrl: string }> {
  await limitPay(tx, ctx, input.checkoutId);
  const c = await lockCheckout(tx, input.checkoutId, viewer, ctx.now);
  const items = c.items as CartItem[];
  if (!items.length) throw new ValidationError("validation", { items: "required" });
  const terms = await currentTerms(tx);
  const locale = (LOCALES as readonly string[]).includes(c.locale) ? (c.locale as Locale) : "nl-BE";

  let personId = c.personId ?? viewer.personId ?? null;
  if (!personId) {
    if (!c.email) throw new ValidationError("validation", { email: "required" });
    const utm = c.utm && Object.keys(c.utm).length ? c.utm : undefined;
    const acquisition = {
      source: opts.referralCode ? ("referral" as const) : ("website" as const),
      ...(utm ? { utm, ...(utm.campaign ? { campaign: utm.campaign } : {}) } : {}),
      ...(opts.referralCode ? { referral_code: opts.referralCode } : {}),
    };
    personId = (await findOrCreatePersonByEmail(tx, ctx, { email: c.email, locale, acquisition })).personId;
  }
  const isGuest = !(viewer.personId && viewer.personId === personId);

  const fresh = await quoteCheckout(tx, c, isGuest ? null : personId, ctx.now);
  if (input.expectedTotalCents !== undefined && fresh.totalCents !== input.expectedTotalCents) {
    throw new ConflictError("price_changed");
  }
  // Edge case 23: `createOrder` prices for the person; a guest must not get a person's prices
  // by typing their email, so a basket the person would pay differently needs a login.
  if (isGuest) {
    const personal = await quoteCheckout(tx, c, personId, ctx.now);
    if (!sameQuote(fresh, personal)) throw new ConflictError("login_required");
  }

  const orderInput = {
    personId,
    channel: c.channel,
    items,
    promoCode: c.promoCode,
    clientKey: input.clientKey,
    checkoutId: c.id,
    locale,
    useEuroCredit: input.useEuroCredit && !isGuest,
  };
  let order = await createOrder(tx, ctx, orderInput);
  // Rule 16, edge case 5: the checkout's pending order was placed for a basket the customer has
  // changed since. It is cancelled and a new order is placed for the basket shown; while its
  // provider payment is still live it cannot be cancelled, so the submit is refused.
  if (order.isExisting && order.status === "pending_payment" && !(await orderMatchesBasket(tx, order.orderId, items, fresh.totalCents))) {
    const [stale] = await tx.select({ clientKey: orders.clientKey }).from(orders).where(eq(orders.id, order.orderId));
    if (stale?.clientKey === input.clientKey) throw new ConflictError("price_changed");
    const { cancelled } = await cancelOrder(tx, ctx, { orderId: order.orderId, reason: "checkout_changed" });
    if (!cancelled) throw new ConflictError("payment_in_progress");
    order = await createOrder(tx, ctx, orderInput);
  }
  // Edge case 6: `createOrder` re-quotes under the promotion locks; a promotion used up since the
  // shown quote raises the total, which the customer must see before paying (the transaction
  // rolls back the order, its reservations and any euro credit).
  const shownTotal = input.expectedTotalCents ?? fresh.totalCents;
  if (!order.isExisting && order.totalCents !== shownTotal) throw new ConflictError("price_changed");
  if (!order.isExisting) {
    await recordTermsAcceptance(tx, ctx, { personId, versionId: terms.versionId, context: "checkout", refType: "order", refId: order.orderId, ip: ctx.ip });
    if (input.billingDetails) await setOrderBillingDetails(tx, ctx, { orderId: order.orderId, details: input.billingDetails });
  }
  await tx
    .update(checkouts)
    .set({ personId, orderId: order.orderId, totalCents: order.totalCents, lastActivityAt: ctx.now, updatedAt: ctx.now })
    .where(eq(checkouts.id, c.id));
  const { redirectUrl } = await startPayment(tx, ctx, { orderId: order.orderId });
  return { orderId: order.orderId, redirectUrl };
}

/** The order's lines are the basket's items (product and quantity, in order) at the shown total. */
async function orderMatchesBasket(tx: Tx, orderId: string, items: readonly CartItem[], totalCents: number): Promise<boolean> {
  const [order] = await tx.select({ totalCents: orders.totalCents }).from(orders).where(eq(orders.id, orderId));
  if (!order || order.totalCents !== totalCents) return false;
  const lines = await tx.select({ productId: orderLines.productId, quantity: orderLines.quantity }).from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(asc(orderLines.lineNo));
  return lines.length === items.length && lines.every((l, i) => l.productId === items[i]!.productId && l.quantity === items[i]!.quantity);
}

async function lockPayableOrder(tx: Tx, ctx: Ctx, orderId: string, viewer: CheckoutViewer): Promise<{ order: OrderRow; settled: boolean }> {
  const order = await lockOrder(tx, orderId);
  if (!order || !canSeeOrder(order, viewer)) throw new NotFoundError("order_not_found");
  if ((PAID_PAYMENT_STATUSES as readonly string[]).includes(order.status)) return { order, settled: true };
  if (order.status === "expired") throw new ConflictError("order_expired");
  if (order.status !== "pending_payment") throw new ConflictError("invalid_transition");
  if (order.expiresAt && order.expiresAt.getTime() <= ctx.now.getTime()) throw new ConflictError("order_expired");
  return { order, settled: false };
}

/**
 * Rule 26a for an order that already exists: `link` orders always ask; booking-created orders
 * ask only when the published terms changed since the order stored its version.
 */
export async function orderNeedsTerms(db: DbOrTx, order: Pick<OrderRow, "channel" | "termsVersionId">): Promise<boolean> {
  const terms = await getCurrentLegalVersion(db, "terms");
  if (!terms) return true;
  return order.channel === "link" || order.termsVersionId !== terms.versionId;
}

/** The session proves the order's person: only then is their euro credit shown or spent. */
function ownsOrderCredit(order: Pick<OrderRow, "personId">, viewer: CheckoutViewer): boolean {
  return !!order.personId && !!viewer.personId && viewer.personId === order.personId;
}

/**
 * Rule 25 for an existing order: euro credit pays part or all of what is still due. While a
 * provider payment is live, no credit is consumed: `startPayment` reuses that payment at its
 * amount, so credit on top of it would be paid twice.
 */
async function applyEuroCredit(tx: Tx, ctx: Ctx, order: OrderRow): Promise<void> {
  if (!order.personId) return;
  const [used] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.provider, "credit_balance")))
    .limit(1);
  if (used) return;
  const [live] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.orderId, order.id), inArray(payments.status, [...LIVE_PAYMENT_STATUSES]), notInArray(payments.provider, [...LOCAL_PROVIDERS])))
    .limit(1);
  if (live) return;
  const due = order.totalCents - (await paidCentsOf(tx, order.id));
  if (due <= 0) return;
  const balance = await getEuroBalance(tx, order.personId);
  const cents = Math.min(balance.remainingCents, due);
  if (cents <= 0) return;
  await consumeCredits(tx, ctx, { personId: order.personId, beneficiaryPersonId: order.personId, kind: "euro", units: cents, ref: { type: "order", id: order.id } });
  await tx.insert(payments).values({
    orderId: order.id,
    provider: "credit_balance",
    method: "credit_balance",
    status: "paid",
    amountCents: cents,
    paidAt: ctx.now,
    statusHistory: [{ status: "paid", at: ctx.now.toISOString(), source: "provider" }],
  });
}

/** Pays an existing `pending_payment` order (booking reservations, waitlist claims, renewal links). */
export async function payOrder(tx: Tx, ctx: Ctx, input: z.infer<typeof PayOrderInput>, viewer: CheckoutViewer): Promise<{ redirectUrl: string }> {
  await limitPay(tx, ctx, input.orderId);
  const { order, settled } = await lockPayableOrder(tx, ctx, input.orderId, viewer);
  if (settled) return { redirectUrl: returnUrlFor(order) };
  if (await orderNeedsTerms(tx, order)) {
    const terms = await currentTerms(tx);
    if (!input.acceptTerms) throw new ValidationError("validation", { acceptTerms: "required" });
    if (!order.personId) throw new ValidationError("validation", { personId: "required" });
    await recordTermsAcceptance(tx, ctx, { personId: order.personId, versionId: terms.versionId, context: "checkout", refType: "order", refId: order.id, ip: ctx.ip });
    await tx.update(orders).set({ termsVersionId: terms.versionId, updatedAt: ctx.now }).where(eq(orders.id, order.id));
  }
  if (input.billingDetails) await setOrderBillingDetails(tx, ctx, { orderId: order.id, details: input.billingDetails });
  // Only the person the session proves may spend their euro credit; a viewer who holds the order
  // through the `beam_checkout` cookie only (a guest who typed the email) pays without it.
  if (input.useEuroCredit && ownsOrderCredit(order, viewer)) await applyEuroCredit(tx, ctx, order);
  const { redirectUrl } = await startPayment(tx, ctx, { orderId: order.id });
  return { redirectUrl };
}

/** Rule 23: a new payment on a `pending_payment` order that has not expired. */
export async function retryPayment(tx: Tx, ctx: Ctx, input: z.infer<typeof RetryPaymentInput>, viewer: CheckoutViewer): Promise<{ redirectUrl: string }> {
  await limitPay(tx, ctx, input.orderId);
  const { order, settled } = await lockPayableOrder(tx, ctx, input.orderId, viewer);
  if (settled) return { redirectUrl: returnUrlFor(order) };
  const { redirectUrl } = await startPayment(tx, ctx, { orderId: order.id });
  return { redirectUrl };
}

/**
 * The return page's poll (section 4.4: a server action, not a route): reads the order and, while
 * a provider payment is still live, enqueues `payments.sync` once per minute.
 */
export async function pollOrderStatus(
  tx: Tx,
  ctx: Ctx,
  orderId: string,
  viewer: CheckoutViewer,
): Promise<{ status: OrderRow["status"]; paymentStatus: string | null; dueCents: number }> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (!order || !canSeeOrder(order, viewer)) throw new NotFoundError("order_not_found");
  const [latest] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), notInArray(payments.provider, [...LOCAL_PROVIDERS])))
    .orderBy(desc(payments.createdAt))
    .limit(1);
  if (order.status === "pending_payment" && latest?.providerPaymentId && (LIVE_PAYMENT_STATUSES as readonly string[]).includes(latest.status)) {
    const minute = ctx.now.toISOString().slice(0, 16);
    await ctx.enqueue({ kind: "payments.sync", payload: { providerPaymentId: latest.providerPaymentId }, key: `payment_sync:${latest.providerPaymentId}:${minute}` });
  }
  const due = Math.max(0, order.totalCents - (await paidCentsOf(tx, order.id)));
  return { status: order.status, paymentStatus: latest?.status ?? null, dueCents: due };
}

// ---------------------------------------------------------------------------
// checkouts.mark_abandoned (rules 49, 50)
// ---------------------------------------------------------------------------

/** `payment_failed` / `payment_expired` from the latest provider payment of the checkout's orders, else `left`. */
async function abandonReason(db: DbOrTx, checkoutId: string): Promise<"left" | "payment_failed" | "payment_expired"> {
  const [latest] = await db
    .select({ status: payments.status })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(and(eq(orders.checkoutId, checkoutId), notInArray(payments.provider, [...LOCAL_PROVIDERS])))
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .limit(1);
  if (latest?.status === "expired") return "payment_expired";
  if (latest?.status === "failed" || latest?.status === "cancelled") return "payment_failed";
  return "left";
}

export type MarkAbandonedResult = { abandoned: number; expired: number; events: number };

/**
 * Rule 49: `started` checkouts idle for 60 minutes with a known person or email become
 * `abandoned` (rows chosen `FOR UPDATE SKIP LOCKED`, 500 per batch, so a concurrent `placeOrder`
 * is never overwritten); `checkout.abandoned` is written when a person is known. Rule 50:
 * `started` and `abandoned` checkouts past `expires_at` become `expired`.
 */
export async function markAbandoned(ctx: JobCtx | Ctx): Promise<MarkAbandonedResult> {
  const tx = ctx.tx;
  const now = ctx.now;
  const cutoff = new Date(now.getTime() - ABANDON_AFTER_MS);
  const out: MarkAbandonedResult = { abandoned: 0, expired: 0, events: 0 };

  for (let round = 0; round < 40; round++) {
    const batch = await tx
      .select()
      .from(checkouts)
      .where(
        and(
          eq(checkouts.status, "started"),
          lt(checkouts.lastActivityAt, cutoff),
          sql`${checkouts.expiresAt} > ${now}`,
          or(isNotNull(checkouts.personId), isNotNull(checkouts.email)),
        ),
      )
      .orderBy(asc(checkouts.lastActivityAt), asc(checkouts.id))
      .limit(BATCH)
      .for("update", { skipLocked: true });
    for (const c of batch) {
      const reason = await abandonReason(tx, c.id);
      await tx.update(checkouts).set({ status: "abandoned", abandonedAt: now, abandonedReason: reason, updatedAt: now }).where(eq(checkouts.id, c.id));
      out.abandoned++;
      if (!c.personId) continue;
      const items = (c.items as CartItem[]) ?? [];
      const recorded = await ctx.recordEvent({
        kind: "checkout.abandoned",
        personId: c.personId,
        ref: { type: "checkout", id: c.id },
        dedupeKey: `checkout:${c.id}:abandoned`,
        data: { checkout_id: c.id, total_cents: c.totalCents, product_ids: [...new Set(items.map((i) => i.productId))], channel: c.channel, reason },
      });
      if (recorded.id !== null) out.events++;
    }
    if (batch.length < BATCH) break;
  }

  for (let round = 0; round < 40; round++) {
    const batch = await tx
      .select({ id: checkouts.id })
      .from(checkouts)
      .where(and(inArray(checkouts.status, ["started", "abandoned"]), lte(checkouts.expiresAt, now)))
      .orderBy(asc(checkouts.expiresAt), asc(checkouts.id))
      .limit(BATCH)
      .for("update", { skipLocked: true });
    if (batch.length) {
      await tx
        .update(checkouts)
        .set({ status: "expired", updatedAt: now })
        .where(inArray(checkouts.id, batch.map((b) => b.id)));
      out.expired += batch.length;
    }
    if (batch.length < BATCH) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reads of the customer screens (section 5.2, 5.3)
// ---------------------------------------------------------------------------

type ProductDbRow = typeof products.$inferSelect;

/** The product's name in `locale`, else any filled locale, else the SKU (screens never throw on a gap). */
export function productName(p: Pick<ProductDbRow, "name" | "sku">, locale: Locale): string {
  const name = (p.name ?? {}) as Partial<Record<Locale, string>>;
  return name[locale]?.trim() || Object.values(name).find((v) => v?.trim()) || p.sku;
}

export function productDescription(p: Pick<ProductDbRow, "description">, locale: Locale): string | null {
  const d = (p.description ?? {}) as Partial<Record<Locale, string>>;
  return d[locale]?.trim() || null;
}

export type ShopProduct = {
  productId: string;
  sku: string;
  kind: ProductDbRow["kind"];
  name: string;
  description: string | null;
  creditUnits: number | null;
  creditKind: ProductDbRow["creditKind"];
  validityDays: number | null;
  isSharingAllowed: boolean;
  isCustomAmount: boolean;
  minAmountCents: number | null;
  maxAmountCents: number | null;
  /** The person's own unit price (null for a custom-amount voucher or a product without price). */
  unitCents: number | null;
  /** The base (list) price when the person's price is lower. */
  listCents: number | null;
  /** The winning candidate of the person's quote (`member_discount`, `person_price`, ...). */
  priceSource: string | null;
  /** `already_member` or `pending_exists` for a membership the person cannot start (rule 26c). */
  warning: string | null;
};

function toShopProduct(p: ProductDbRow, locale: Locale, line: Quote["lines"][number] | undefined, warning: string | null): ShopProduct {
  const listCents = line ? line.trace.baseUnitCents : null;
  return {
    productId: p.id,
    sku: p.sku,
    kind: p.kind,
    name: productName(p, locale),
    description: productDescription(p, locale),
    creditUnits: p.creditUnits,
    creditKind: p.creditKind,
    validityDays: p.validityDays,
    isSharingAllowed: p.isSharingAllowed,
    isCustomAmount: p.isCustomAmount,
    minAmountCents: p.minAmountCents,
    maxAmountCents: p.maxAmountCents,
    unitCents: line ? line.lineTotalCents / Math.max(1, line.quantity) : null,
    listCents: line && listCents !== null && listCents > line.lineTotalCents / Math.max(1, line.quantity) ? listCents : null,
    priceSource: line ? line.trace.winner : null,
    warning,
  };
}

async function quoteProducts(db: DbOrTx, rows: ProductDbRow[], personId: string | null, channel: CheckoutChannel, locale: Locale): Promise<ShopProduct[]> {
  const priced = rows.filter((p) => !p.isCustomAmount);
  const at = new Date();
  const quoted = priced.length
    ? await getQuote(db, { personId, items: priced.map((p) => ({ productId: p.id, quantity: 1 })), promoCode: null, channel, at })
    : null;
  const lineOf = new Map((quoted?.lines ?? []).map((l) => [l.productId, l]));
  const warnOf = new Map((quoted?.warnings ?? []).filter((w) => w.productId).map((w) => [w.productId!, w.code as string]));
  return rows
    .map((p) => toShopProduct(p, locale, lineOf.get(p.id), warnOf.get(p.id) ?? null))
    .filter((p) => p.isCustomAmount || p.unitCents !== null);
}

/** `getShopCatalogue(db, {personId, locale})`: shop-visible active products with the person's quoted price. */
export async function getShopCatalogue(db: DbOrTx, input: { personId: string | null; locale: Locale; channel?: CheckoutChannel }): Promise<ShopProduct[]> {
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.isActive, true), eq(products.isShopVisible, true), inArray(products.kind, [...SHOP_KINDS])))
    .orderBy(asc(products.sortOrder), asc(products.sku));
  return quoteProducts(db, rows, input.personId, input.channel ?? "portal", input.locale);
}

/**
 * One sellable product by SKU or id (`/account/shop/[sku]`, `?product=<id>`, site `?sku=`):
 * null for an unknown, inactive, hidden or dated product ("This product is not available").
 */
export async function getShopProduct(
  db: DbOrTx,
  input: { sku?: string; productId?: string; personId: string | null; locale: Locale; channel?: CheckoutChannel; requireShopVisible?: boolean },
): Promise<ShopProduct | null> {
  if (!input.sku && !input.productId) return null;
  if (input.productId && !z.uuid().safeParse(input.productId).success) return null;
  const [row] = await db
    .select()
    .from(products)
    .where(input.productId ? eq(products.id, input.productId) : eq(products.sku, input.sku!));
  if (!row || !row.isActive || !(SHOP_KINDS as readonly string[]).includes(row.kind)) return null;
  if (input.requireShopVisible !== false && !row.isShopVisible) return null;
  const [p] = await quoteProducts(db, [row], input.personId, input.channel ?? "portal", input.locale);
  return p ?? null;
}

export type CheckoutLineView = { productId: string; name: string; kind: string; quantity: number; unitCents: number; lineTotalCents: number; discountCents: number; vatRatePct: number; reason: string | null; item: CartItem };

export type CheckoutView = {
  checkoutId: string;
  channel: CheckoutChannel;
  status: CheckoutRow["status"];
  email: string | null;
  promoCode: string | null;
  quote: Quote;
  lines: CheckoutLineView[];
  /** Rule 16: the fresh quote differs from the total stored at the last save. */
  priceChanged: boolean;
  euroBalanceCents: number;
  termsAvailable: boolean;
  isGuest: boolean;
  orderId: string | null;
};

/** `getCheckout(db, checkoutId, viewer)`: the basket with a fresh quote; null when the viewer may not see it. */
export async function getCheckout(db: DbOrTx, checkoutId: string, viewer: CheckoutViewer, locale: Locale): Promise<CheckoutView | null> {
  if (!z.uuid().safeParse(checkoutId).success) return null;
  const [c] = await db.select().from(checkouts).where(eq(checkouts.id, checkoutId));
  if (!c || !canSeeCheckout(c, viewer)) return null;
  const pricingPerson = pricingPersonOf(c, viewer);
  const items = (c.items as CartItem[]) ?? [];
  const quote = await quoteCheckout(db, c, pricingPerson, new Date());
  const ids = [...new Set(items.map((i) => i.productId))];
  const rows = ids.length ? await db.select().from(products).where(inArray(products.id, ids)) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines: CheckoutLineView[] = [];
  let li = 0;
  for (const item of items) {
    const p = byId.get(item.productId);
    const line = quote.lines[li]?.productId === item.productId ? quote.lines[li] : undefined;
    if (line) li++;
    if (!p || !line) continue;
    const winner = line.trace.winner;
    lines.push({
      productId: p.id,
      name: productName(p, locale),
      kind: p.kind,
      quantity: line.quantity,
      unitCents: line.unitAmountCents,
      lineTotalCents: line.lineTotalCents,
      discountCents: line.discountCents,
      vatRatePct: line.vatRatePct,
      reason: winner === "base" ? null : winner,
      item,
    });
  }
  const balance = pricingPerson ? await getEuroBalance(db, pricingPerson) : { remainingCents: 0 };
  const terms = await getCurrentLegalVersion(db, "terms");
  return {
    checkoutId: c.id,
    channel: c.channel,
    status: c.status,
    email: c.email,
    promoCode: c.promoCode,
    quote,
    lines,
    priceChanged: c.totalCents !== null && c.totalCents !== quote.totalCents,
    euroBalanceCents: balance.remainingCents,
    termsAvailable: !!terms,
    isGuest: !pricingPerson,
    orderId: c.orderId,
  };
}

export type OrderLineView = { id: string; description: string; kind: string; quantity: number; lineTotalCents: number; vatRatePct: number };

export type CustomerOrderView = {
  orderId: string;
  reference: string;
  channel: OrderRow["channel"];
  status: OrderRow["status"];
  createdAt: Date;
  paidAt: Date | null;
  expiresAt: Date | null;
  totalCents: number;
  dueCents: number;
  withdrawalUntilAt: Date | null;
  lines: OrderLineView[];
  payments: { id: string; method: string | null; provider: string; status: string; amountCents: number; createdAt: Date }[];
  refunds: { id: string; amountCents: number; status: string; createdAt: Date }[];
  needsTerms: boolean;
  euroBalanceCents: number;
  /** `expired`, or `pending_payment` past `expires_at` (read time). */
  isExpired: boolean;
  /** The withdrawal deadline (rule 54) has not passed. */
  withdrawalOpen: boolean;
};

function lineText(description: unknown, locale: Locale, fallback: string): string {
  const d = (description ?? {}) as Partial<Record<Locale, string>>;
  return d[locale]?.trim() || Object.values(d).find((v) => v?.trim()) || fallback;
}

async function orderView(db: DbOrTx, order: OrderRow, locale: Locale, viewer: CheckoutViewer): Promise<CustomerOrderView> {
  const lines = await db.select().from(orderLines).where(eq(orderLines.orderId, order.id)).orderBy(asc(orderLines.lineNo));
  const pays = await db.select().from(payments).where(eq(payments.orderId, order.id)).orderBy(asc(payments.createdAt));
  const refundRows = await db.select().from(refunds).where(eq(refunds.orderId, order.id)).orderBy(asc(refunds.createdAt));
  const paid = await paidCentsOf(db, order.id);
  const isPending = order.status === "pending_payment";
  const now = Date.now();
  return {
    orderId: order.id,
    reference: order.reference,
    channel: order.channel,
    status: order.status,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    expiresAt: order.expiresAt,
    totalCents: order.totalCents,
    dueCents: Math.max(0, order.totalCents - paid),
    withdrawalUntilAt: order.withdrawalUntilAt,
    lines: lines.map((l) => ({ id: l.id, description: lineText(l.description, locale, l.sku), kind: l.productKind, quantity: l.quantity, lineTotalCents: l.lineTotalCents, vatRatePct: Number(l.vatRatePct) })),
    payments: pays.map((p) => ({ id: p.id, method: p.method, provider: p.provider, status: p.status, amountCents: p.amountCents, createdAt: p.createdAt })),
    refunds: refundRows.map((r) => ({ id: r.id, amountCents: r.amountCents, status: r.status, createdAt: r.createdAt })),
    needsTerms: isPending ? await orderNeedsTerms(db, order) : false,
    euroBalanceCents: isPending && order.personId && ownsOrderCredit(order, viewer) ? (await getEuroBalance(db, order.personId)).remainingCents : 0,
    isExpired: order.status === "expired" || (isPending && !!order.expiresAt && order.expiresAt.getTime() <= now),
    withdrawalOpen: !!order.withdrawalUntilAt && order.withdrawalUntilAt.getTime() > now,
  };
}

/** `getOrderForPayment(db, orderId, viewer)` and the order detail: owner (or cookie holder) only. */
export async function getOrderForViewer(db: DbOrTx, orderId: string, viewer: CheckoutViewer, locale: Locale): Promise<CustomerOrderView | null> {
  if (!z.uuid().safeParse(orderId).success) return null;
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order || !canSeeOrder(order, viewer)) return null;
  return orderView(db, order, locale, viewer);
}

export type MyOrderRow = { orderId: string; reference: string; createdAt: Date; totalCents: number; status: OrderRow["status"]; channel: OrderRow["channel"] };
export type MyVoucherRow = { voucherId: string; amountCents: number; recipientName: string | null; status: string; expiresAt: Date | null; deliverOn: string | null };

/** `listMyOrders(db, personId)`: the person's orders (newest first) and the vouchers they bought. */
export async function listMyOrders(db: DbOrTx, personId: string): Promise<{ orders: MyOrderRow[]; vouchers: MyVoucherRow[] }> {
  const rows = await db
    .select({ orderId: orders.id, reference: orders.reference, createdAt: orders.createdAt, totalCents: orders.totalCents, status: orders.status, channel: orders.channel })
    .from(orders)
    .where(and(eq(orders.personId, personId), notInArray(orders.status, ["draft"])))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(200);
  const bought = await db
    .select({ voucherId: vouchers.id, amountCents: vouchers.amountCents, recipientName: vouchers.recipientName, status: vouchers.status, expiresAt: vouchers.expiresAt, deliverOn: vouchers.deliverOn })
    .from(vouchers)
    .where(and(eq(vouchers.purchaserPersonId, personId), notInArray(vouchers.status, ["pending"])))
    .orderBy(desc(vouchers.createdAt))
    .limit(200);
  return { orders: rows, vouchers: bought };
}
