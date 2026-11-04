/**
 * Payments (commerce spec rules 23, 28 to 30, 33, 35; section 4.4 and 4.5; commerce-P4a).
 *
 * - `startPayment` writes the order's next `payments` row and runs `payments.create` inline
 *   (one of the three documented synchronous provider calls, architecture section 3) inside the
 *   caller's transaction, so the new row is visible to the job and nothing is committed half.
 * - `createProviderPayment` is the `payments.create` handler.
 * - `syncPayment` (the `payments.sync` job and the Mollie webhook) fetches the payment from the
 *   provider (the fetch is the verification, rule 30) and hands the report to
 *   `applyProviderStatus`, the forward-only state machine (rule 28), which runs the paid
 *   transaction when the order is covered (rule 31) and the failure path otherwise (rule 33).
 */
import { randomUUID } from "node:crypto";
import { checkouts, mandates, orders, orderLines, payments, persons, providerCustomers } from "@beam/db/schema";
import {
  nextPaymentStatus,
  type OnlinePaymentProvider,
  type PaymentStatus,
  type StatusSource,
} from "@beam/core/commerce";
import { RetryableError } from "@beam/core/errors";
import { formatMoney, t, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { IntegrationError } from "@beam/integrations/_shared";
import type { PaymentProvider } from "@beam/integrations/payments";
import { appUrl } from "@/lib/auth";
import { and, eq, inArray, notInArray, sql, AppError, ConflictError, NotFoundError, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import { getIntegrations, type Integrations } from "@/lib/integrations";
import { runJobInline, type JobCtx } from "@/lib/job-runner";
import { getSetting } from "@/lib/settings";
import { createTask } from "@/modules/crm/api";
import { applyRenewalFailure, consumeCredits, getEuroBalance } from "@/modules/credits/api";
import { sendTransactional } from "@/modules/email/api";
import { commerceSettings, finalizePaidOrder, lockOrder, orderSubject, paidCentsOf, type OrderRow, type PaymentRow } from "./paid";

/** Payments that are still in flight at the provider (at most one per order, rule 23). */
export const LIVE_PAYMENT_STATUSES = ["open", "pending", "authorized"] as const;
/** Statuses that end a payment unpaid (rule 33). */
export const ENDED_PAYMENT_STATUSES: readonly PaymentStatus[] = ["failed", "expired", "cancelled"];
/** Providers that never call out (rule 29). */
const LOCAL_PROVIDERS = ["cash", "bank_transfer", "credit_balance"] as const;

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** `POST /api/webhooks/mollie`, with `?t=<MOLLIE_WEBHOOK_SECRET>` when a secret is configured. */
export function mollieWebhookUrl(): string {
  const secret = process.env.MOLLIE_WEBHOOK_SECRET;
  return appUrl(`/api/webhooks/mollie${secret ? `?t=${encodeURIComponent(secret)}` : ""}`);
}

/** The page the provider returns the customer to: the caller's path, else the channel's return page. */
export function returnUrlFor(order: Pick<OrderRow, "id" | "channel" | "locale">, returnPath?: string): string {
  const seg = URL_SEGMENT[order.locale as Locale];
  if (returnPath) {
    const path = returnPath.startsWith("/") ? returnPath : `/${returnPath}`;
    const localised = path.startsWith("/admin") || /^\/(nl|fr|en)(\/|$)/.test(path) ? path : `/${seg}${path}`;
    return appUrl(localised);
  }
  if (order.channel === "site") return appUrl(`/${seg}/checkout/return/${order.id}`);
  if (order.channel === "admin" || order.channel === "pos") return appUrl(`/admin/orders/${order.id}`);
  return appUrl(`/${seg}/account/checkout/return/${order.id}`);
}

/** The order payment page where a failed payment is retried (`commerce.payment_failed`). */
export function retryUrlFor(order: Pick<OrderRow, "id" | "locale">): string {
  return appUrl(`/${URL_SEGMENT[order.locale as Locale]}/account/checkout/${order.id}`);
}

function withQuery(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

/** `settings.payment_provider_by_channel[channel]` (rule 29); Mollie when the key is unreadable. */
async function providerFor(db: DbOrTx, channel: OrderRow["channel"]): Promise<OnlinePaymentProvider> {
  try {
    const value = await getSetting(db, "payment_provider_by_channel");
    return value[channel] ?? "mollie";
  } catch {
    return "mollie";
  }
}

function paymentsClient(ctx: Ctx & { integrations?: Integrations }): PaymentProvider {
  return (ctx.integrations ?? getIntegrations()).payments;
}

// ---------------------------------------------------------------------------
// startPayment and payments.create
// ---------------------------------------------------------------------------

export type CreatePaymentJobResult =
  | { providerPaymentId: string; checkoutUrl: string | null }
  | { skipped: true; status: PaymentStatus }
  | { failed: true; reason: string };

/**
 * Starts (or resumes) the provider payment of a `pending_payment` order. Returns the provider
 * page, or the return page when nothing is due or the order is already paid. A live provider
 * payment with a checkout URL is reused (rule 23, edge case 1). A provider outage leaves the
 * order `pending_payment` with a `failed` payment and returns the return page with
 * `?payment=unavailable` (edge case 8). An open bank transfer refuses with `payment_in_progress`.
 */
export async function startPayment(tx: Tx, ctx: Ctx, input: { orderId: string; returnPath?: string }): Promise<{ paymentId: string | null; redirectUrl: string }> {
  const order = await lockOrder(tx, input.orderId);
  if (!order) throw new NotFoundError("order_not_found");
  const returnUrl = returnUrlFor(order, input.returnPath);
  if (order.status === "paid" || order.status === "partially_refunded" || order.status === "refunded") return { paymentId: null, redirectUrl: returnUrl };
  if (order.status !== "pending_payment") throw new ConflictError("invalid_transition");
  if (order.expiresAt && order.expiresAt.getTime() <= ctx.now.getTime()) throw new ConflictError("order_expired");

  const due = order.totalCents - (await paidCentsOf(tx, order.id));
  if (due <= 0) {
    await finalizePaidOrder(tx, ctx, order.id);
    return { paymentId: null, redirectUrl: returnUrl };
  }

  // Rule 23: an open bank transfer is the order's non-final payment (with an open invoice and no
  // expiry), so the order is not paid online beside it.
  const [transfer] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.provider, "bank_transfer"), inArray(payments.status, ["open", "pending"])))
    .limit(1);
  if (transfer) throw new ConflictError("payment_in_progress");

  const [live] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), inArray(payments.status, [...LIVE_PAYMENT_STATUSES]), notInArray(payments.provider, [...LOCAL_PROVIDERS])))
    .limit(1);
  if (live?.checkoutUrl) return { paymentId: live.id, redirectUrl: live.checkoutUrl };

  let payment = live;
  if (!payment) {
    const [membershipLine] = await tx
      .select({ id: orderLines.id })
      .from(orderLines)
      .where(and(eq(orderLines.orderId, order.id), eq(orderLines.productKind, "membership")))
      .limit(1);
    [payment] = await tx
      .insert(payments)
      .values({
        orderId: order.id,
        provider: await providerFor(tx, order.channel),
        sequenceType: membershipLine && order.personId && !order.renewalMembershipId ? "first" : "oneoff",
        status: "open",
        amountCents: due,
        createdByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
      })
      .returning();
    // Rule 22: a pending order expires 30 minutes after its last payment was created; booking's
    // pay-at-desk (admin) orders and renewal orders keep their own expiry.
    if (order.channel !== "admin" && !order.renewalMembershipId) {
      const settings = await commerceSettings(tx);
      await tx
        .update(orders)
        .set({ expiresAt: new Date(ctx.now.getTime() + settings.order_expiry_minutes * 60_000), updatedAt: ctx.now })
        .where(eq(orders.id, order.id));
    }
  }
  const paymentId = payment!.id;
  try {
    const result = await runJobInline<CreatePaymentJobResult>(
      "payments.create",
      { paymentId, redirectUrl: returnUrl },
      { key: `payment_create:${paymentId}`, requestId: ctx.requestId, db: tx },
    );
    if ("checkoutUrl" in result && result.checkoutUrl) return { paymentId, redirectUrl: result.checkoutUrl };
    return { paymentId, redirectUrl: withQuery(returnUrl, "payment", "failed") };
  } catch {
    const [row] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
    if (row && row.status === "open" && !row.providerPaymentId) {
      await applyProviderStatus(tx, ctx, row, { status: "failed", reason: "payment_unavailable" });
    }
    return { paymentId, redirectUrl: withQuery(returnUrl, "payment", "unavailable") };
  }
}

/** The person's provider customer (Mollie recurring needs one for a `first` payment), created once. */
async function ensureProviderCustomer(ctx: JobCtx, personId: string, provider: PaymentProvider, locale: Locale): Promise<string> {
  const [existing] = await ctx.tx
    .select()
    .from(providerCustomers)
    .where(and(eq(providerCustomers.personId, personId), eq(providerCustomers.provider, "mollie")));
  if (existing) return existing.providerCustomerId;
  const [person] = await ctx.tx.select({ firstName: persons.firstName, lastName: persons.lastName, email: persons.email }).from(persons).where(eq(persons.id, personId));
  const name = [person?.firstName, person?.lastName].filter(Boolean).join(" ") || "BEAM customer";
  const { customerId } = await provider.createCustomer({ name, email: person?.email ?? "", locale, idempotencyKey: `customer:${personId}` });
  await ctx.tx.insert(providerCustomers).values({ personId, provider: "mollie", providerCustomerId: customerId }).onConflictDoNothing();
  return customerId;
}

/**
 * `payments.create` (inline, key `payment_create:<payment_id>`): creates the provider payment
 * with the job key as `Idempotency-Key` and stores its id and checkout URL. A payment that is no
 * longer `open` (marked failed by an earlier attempt) is skipped. A provider 4xx fails the
 * payment (rule 33); a 5xx or timeout throws for the job backoff.
 */
export async function createProviderPayment(ctx: JobCtx, input: { paymentId: string; redirectUrl?: string | undefined }): Promise<CreatePaymentJobResult> {
  const [payment] = await ctx.tx.select().from(payments).where(eq(payments.id, input.paymentId)).for("update");
  if (!payment) throw new NotFoundError("payment_not_found");
  if (payment.providerPaymentId) return { providerPaymentId: payment.providerPaymentId, checkoutUrl: payment.checkoutUrl };
  if (payment.status !== "open") return { skipped: true, status: payment.status };
  const [order] = await ctx.tx.select().from(orders).where(eq(orders.id, payment.orderId));
  if (!order) throw new NotFoundError("order_not_found");
  const provider = paymentsClient(ctx);
  const locale = order.locale as Locale;
  try {
    const customerId = payment.sequenceType === "first" && order.personId ? await ensureProviderCustomer(ctx, order.personId, provider, locale) : undefined;
    const created = await provider.createPayment({
      amountCents: payment.amountCents,
      description: order.reference,
      redirectUrl: input.redirectUrl ?? returnUrlFor(order),
      webhookUrl: mollieWebhookUrl(),
      locale,
      ...(customerId ? { customerId } : {}),
      sequenceType: payment.sequenceType === "first" ? "first" : "oneoff",
      metadata: { orderId: order.id, paymentId: payment.id },
      idempotencyKey: ctx.job.key,
    });
    await ctx.tx
      .update(payments)
      .set({ providerPaymentId: created.providerPaymentId, checkoutUrl: created.checkoutUrl, updatedAt: ctx.now })
      .where(eq(payments.id, payment.id));
    return { providerPaymentId: created.providerPaymentId, checkoutUrl: created.checkoutUrl };
  } catch (error) {
    if (error instanceof IntegrationError && !error.retryable) {
      await applyProviderStatus(ctx.tx, ctx, payment, { status: "failed", reason: "provider_rejected" });
      return { failed: true, reason: "provider_rejected" };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/** A status report: the provider's payment (`getPayment`), or a local decision (timeout, staff). */
export type ReportedPayment = {
  status: PaymentStatus;
  method?: string | null;
  paidAt?: Date | null;
  mandateId?: string | null;
  customerId?: string | null;
  chargebackCents?: number;
  details?: Record<string, unknown>;
  /** Default `provider`. */
  source?: StatusSource;
  /** `failed_reason` and `payment.failed.reason` when the payment ends unpaid. */
  reason?: string;
};

/**
 * Applies a reported status to `payment` (its row locked by the caller). Forward moves only
 * (`nextPaymentStatus`, rule 28); every applied change is appended to `status_history`. A move to
 * `paid` upserts the mandate the payment carries and runs the paid transaction once the order's
 * paid payments reach its total (rule 31); a move to `failed`, `expired` or `cancelled` runs the
 * failure path (rule 33).
 */
export async function applyProviderStatus(tx: Tx, ctx: Ctx, payment: PaymentRow, reported: ReportedPayment): Promise<{ changed: boolean; becamePaid: boolean }> {
  const history = payment.statusHistory ?? [];
  const source = reported.source ?? "provider";
  const next = nextPaymentStatus(payment.status, reported.status, source, history.at(-1)?.source ?? "provider");
  if (next === null) return { changed: false, becamePaid: false };

  let mandateId = payment.mandateId;
  if (next === "paid" && reported.mandateId && reported.customerId) {
    mandateId = await upsertMandate(tx, payment, reported.mandateId, reported.customerId, reported.method ?? null);
  }
  const ended = ENDED_PAYMENT_STATUSES.includes(next);
  const reason = reported.reason ?? next;
  await tx
    .update(payments)
    .set({
      status: next,
      statusHistory: [...history, { status: next, at: ctx.now.toISOString(), source }],
      method: reported.method ?? payment.method,
      paidAt: next === "paid" ? (reported.paidAt ?? ctx.now) : payment.paidAt,
      ...(reported.details ? { raw: reported.details } : {}),
      ...(ended ? { failedReason: reason } : {}),
      mandateId,
      updatedAt: ctx.now,
    })
    .where(eq(payments.id, payment.id));

  let becamePaid = false;
  if (next === "paid") {
    const order = await lockOrder(tx, payment.orderId);
    if (order && (order.status === "pending_payment" || order.status === "expired")) {
      let paid = await paidCentsOf(tx, order.id);
      if (order.status === "expired" && paid < order.totalCents) paid += await reconsumeReleasedEuroCredit(tx, ctx, order, order.totalCents - paid);
      if (paid >= order.totalCents) {
        await finalizePaidOrder(tx, ctx, order.id, { paymentId: payment.id });
        becamePaid = true;
      }
    }
  } else if (ended && payment.provider !== "credit_balance") {
    await onPaymentEnded(tx, ctx, payment, next, reason);
  }
  return { changed: true, becamePaid };
}

/**
 * Edge case 4 with euro credit: the expiry released the order's euro credit (its `credit_balance`
 * payment is `cancelled`), so a late provider `paid` no longer covers the total. When the
 * person's euro balance still covers the shortfall, it is consumed again as a new, paid
 * `credit_balance` payment and the order can be finalised. Credits refuses a second consume on a
 * released order ref (`ref_already_released`), so the re-consume is keyed by the new payment's id
 * (`ref = {type: 'order', id: <payment id>}`; a full refund releases both refs). Returns the cents
 * added; 0 leaves the order `expired`, and `refundLatePaidOnCancelledOrder` (after the sync) refunds the
 * provider payment.
 */
async function reconsumeReleasedEuroCredit(tx: Tx, ctx: Ctx, order: OrderRow, shortfallCents: number): Promise<number> {
  const personId = order.personId;
  if (!personId || shortfallCents <= 0) return 0;
  const [released] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.provider, "credit_balance"), eq(payments.status, "cancelled")))
    .limit(1);
  if (!released) return 0;
  const balance = await getEuroBalance(tx, personId);
  if (balance.remainingCents < shortfallCents) return 0;
  const paymentId = randomUUID();
  try {
    // A savepoint: an allocation refusal must not abort the provider status already written.
    await tx.transaction((sp) =>
      consumeCredits(sp, ctx, { personId, beneficiaryPersonId: personId, kind: "euro", units: shortfallCents, ref: { type: "order", id: paymentId } }).then(() => undefined),
    );
  } catch (error) {
    if (error instanceof AppError) return 0;
    throw error;
  }
  await tx.insert(payments).values({
    id: paymentId,
    orderId: order.id,
    provider: "credit_balance",
    method: "credit_balance",
    status: "paid",
    amountCents: shortfallCents,
    paidAt: ctx.now,
    statusHistory: [{ status: "paid", at: ctx.now.toISOString(), source: "provider" }],
  });
  return shortfallCents;
}

/** The mandate a paid `first` or recurring payment carries (rule 32), keyed by the provider id. */
async function upsertMandate(tx: Tx, payment: PaymentRow, providerMandateId: string, providerCustomerId: string, method: string | null): Promise<string> {
  const [order] = await tx.select({ personId: orders.personId }).from(orders).where(eq(orders.id, payment.orderId));
  const [row] = await tx
    .insert(mandates)
    .values({
      personId: order?.personId ?? null,
      provider: payment.provider,
      providerMandateId,
      providerCustomerId,
      method: method === "directdebit" ? "directdebit" : "creditcard",
      status: "valid",
    })
    .onConflictDoUpdate({ target: mandates.providerMandateId, set: { updatedAt: sql`now()` } })
    .returning({ id: mandates.id });
  return row!.id;
}

/**
 * Rule 33: `payment.failed` on the timeline, `credits.applyRenewalFailure` for a renewal order,
 * the checkout's `abandoned_reason`, and `commerce.payment_failed` with a retry link (not for
 * renewal orders, whose reminder credits sends, not for POS, and only while the order can still
 * be paid).
 */
async function onPaymentEnded(tx: Tx, ctx: Ctx, payment: PaymentRow, status: PaymentStatus, reason: string): Promise<void> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId));
  if (!order) return;
  const subject = orderSubject(order);
  if (subject) {
    await ctx.recordEvent({
      kind: "payment.failed",
      ...subject,
      ref: { type: "payment", id: payment.id },
      dedupeKey: `payment:${payment.id}:failed`,
      data: { order_id: order.id, reason },
    });
  }
  if (order.renewalMembershipId) {
    await applyRenewalFailure(tx, ctx, { membershipId: order.renewalMembershipId, paymentId: payment.id, reason });
  }
  if (order.checkoutId) {
    await tx
      .update(checkouts)
      .set({ abandonedReason: status === "expired" ? "payment_expired" : "payment_failed", updatedAt: ctx.now })
      .where(eq(checkouts.id, order.checkoutId));
  }
  if (order.renewalMembershipId || order.channel === "pos" || order.status !== "pending_payment" || !order.personId) return;
  const [person] = await tx.select({ email: persons.email }).from(persons).where(eq(persons.id, order.personId));
  if (!person?.email) return;
  const locale = order.locale as Locale;
  await sendTransactional(ctx, {
    template: "commerce.payment_failed",
    personId: order.personId,
    locale,
    data: { reference: order.reference, amount: formatMoney(payment.amountCents, locale), retryUrl: retryUrlFor(order) },
    key: `payment:${payment.id}:failed`,
  });
}

// ---------------------------------------------------------------------------
// syncPayment (payments.sync and the Mollie webhook)
// ---------------------------------------------------------------------------

export type SyncResult =
  | { ignored: true; reason: "not_a_payment_id" | "unknown" }
  | { ignored: false; paymentId: string; status: PaymentStatus; changed: boolean; becamePaid: boolean };

/**
 * Fetches `providerPaymentId` from the provider and applies it. Ids that are not Mollie payment
 * ids (`tr_...`) and ids the provider does not know are ignored. An id the provider knows but
 * this database does not yet hold (the webhook raced the order transaction) throws
 * `RetryableError`, so the job's backoff resolves it (platform edge case 8). Also syncs
 * chargebacks (rule 35). Runs in the job's transaction; the payment row is locked first.
 */
export async function syncPayment(ctx: Ctx & { integrations?: Integrations }, providerPaymentId: string): Promise<SyncResult> {
  if (!/^tr_[A-Za-z0-9_]+$/.test(providerPaymentId)) return { ignored: true, reason: "not_a_payment_id" };
  const tx = ctx.tx;
  const [row] = await tx.select().from(payments).where(eq(payments.providerPaymentId, providerPaymentId)).for("update");
  let reported: Awaited<ReturnType<PaymentProvider["getPayment"]>>;
  try {
    reported = await paymentsClient(ctx).getPayment(providerPaymentId);
  } catch (error) {
    if (error instanceof IntegrationError && error.statusCode === 404) return { ignored: true, reason: "unknown" };
    throw error;
  }
  if (!row) throw new RetryableError(`payment_not_committed: ${providerPaymentId}`);
  const result = await applyProviderStatus(tx, ctx, row, {
    status: reported.status,
    method: reported.method,
    paidAt: reported.paidAt,
    mandateId: reported.mandateId,
    customerId: reported.customerId,
    details: reported.details,
  });
  await syncChargeback(tx, ctx, row, reported.chargebackCents);
  const [after] = await tx.select({ status: payments.status }).from(payments).where(eq(payments.id, row.id));
  return { ignored: false, paymentId: row.id, status: after?.status ?? row.status, changed: result.changed, becamePaid: result.becamePaid };
}

/** Rule 35: a new chargeback sets `chargeback_cents`, writes the event and a finance task; nothing is revoked. */
async function syncChargeback(tx: Tx, ctx: Ctx, payment: PaymentRow, chargebackCents: number): Promise<void> {
  if (!(chargebackCents > payment.chargebackCents)) return;
  await tx.update(payments).set({ chargebackCents, updatedAt: ctx.now }).where(eq(payments.id, payment.id));
  const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId));
  if (!order) return;
  const subject = orderSubject(order);
  if (subject) {
    await ctx.recordEvent({
      kind: "payment.charged_back",
      ...subject,
      ref: { type: "payment", id: payment.id },
      dedupeKey: `payment:${payment.id}:charged_back:${chargebackCents}`,
      data: { order_id: order.id, amount_cents: chargebackCents },
    });
  }
  await createTask(tx, ctx, {
    title: t("nl-BE", "commerce.tasks.chargeback", { reference: order.reference }),
    kind: "payment",
    ownerRole: "finance",
    ...(order.personId ? { personId: order.personId } : {}),
    ...(order.companyId ? { companyId: order.companyId } : {}),
    source: "system",
    ref: { type: "payment", id: payment.id },
    dedupeKey: `chargeback:${payment.id}`,
  });
}
