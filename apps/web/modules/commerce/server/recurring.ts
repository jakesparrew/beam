/**
 * Membership renewal orders for credits (commerce spec rule 22c, credits rules 48 to 53, edge
 * cases 27 and 36; commerce-P4b).
 *
 * - `createRecurringCharge` creates the period's renewal order (channel `recurring`) or, on a
 *   dunning retry, reuses the live one (`orders_renewal_uq`), inserts a new `recurring` payment
 *   and enqueues `payments.charge_recurring`. A payment still in flight is returned instead of a
 *   second one (rule 23).
 * - `createRenewalLinkOrder` creates the same order with channel `link` and returns its pay link;
 *   idempotent per membership and period.
 * - Renewal orders are priced at the plan's `public` price version valid at creation, without
 *   promotion or member pricing, and expire at the period end + 10 days (the dunning end).
 * - `chargeRecurringPayment` is `payments.charge_recurring`; `cancelProviderPayment` is
 *   `payments.cancel`; `refundLatePaidOnCancelledOrder` refunds a provider `paid` that arrives
 *   for a cancelled renewal order (it runs after every `payments.sync` and Mollie webhook).
 * - `getActiveMandate` is the person's latest `valid` mandate.
 */
import { randomUUID } from "node:crypto";
import { mandates, orderLines, orders, payments, persons, products } from "@beam/db/schema";
import { newOrderReference, nextPaymentStatus, vatOf, type OnlinePaymentProvider, type PricingTrace } from "@beam/core/commerce";
import { t } from "@beam/core/i18n";
import { IntegrationError } from "@beam/integrations/_shared";
import type { PaymentProvider } from "@beam/integrations/payments";
import { and, desc, eq, inArray, ConflictError, NotFoundError, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import { getIntegrations, type Integrations } from "@/lib/integrations";
import { RetryableError, type JobCtx } from "@/lib/job-runner";
import { getSetting } from "@/lib/settings";
import { createTask } from "@/modules/crm/api";
import { getCurrentLegalVersion } from "@/modules/site/api";
import { getProductPrice } from "./catalogue";
import { LIVE_STATUSES } from "./cancel";
import { brusselsMidnight, lockOrder, orderSubject, paidCentsOf, PAID_PAYMENT_STATUSES, type OrderRow } from "./paid";
import { getPayLinkForOrder } from "./payment-links";
import { applyProviderStatus, mollieWebhookUrl } from "./payments";

/** Days after the period end until which a renewal order can still be paid (credits' dunning end). */
export const RENEWAL_GRACE_DAYS = 10;

type RenewalInput = { membershipId: string; personId: string; productId: string; periodEndOn: string };

function paymentsClient(ctx: Ctx & { integrations?: Integrations }): PaymentProvider {
  return (ctx.integrations ?? getIntegrations()).payments;
}

/** `settings.payment_provider_by_channel.recurring` (rule 29); Mollie when the key is unreadable. */
async function recurringProvider(db: DbOrTx): Promise<OnlinePaymentProvider> {
  try {
    return (await getSetting(db, "payment_provider_by_channel")).recurring ?? "mollie";
  } catch {
    return "mollie";
  }
}

/** The live renewal order of a membership period (`orders_renewal_uq`: `pending_payment` or `paid`), locked. */
async function findRenewalOrder(tx: Tx, membershipId: string, periodEndOn: string): Promise<OrderRow | null> {
  const [row] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.renewalMembershipId, membershipId), eq(orders.renewalPeriodEndOn, periodEndOn), inArray(orders.status, ["pending_payment", "paid"])))
    .limit(1)
    .for("update");
  return row ?? null;
}

/**
 * Writes the renewal order of `input` with one membership line at the plan's `public` price
 * (no promotion, no member pricing; rule 22c). `link` orders store the current terms version
 * (`orders_terms_chk`; the pay page records the acceptance).
 */
async function insertRenewalOrder(tx: Tx, ctx: Ctx, input: RenewalInput, channel: "recurring" | "link"): Promise<OrderRow> {
  const [product] = await tx.select().from(products).where(eq(products.id, input.productId));
  if (!product) throw new NotFoundError("product_not_found");
  if (product.kind !== "membership") throw new ConflictError("not_a_membership");
  const price = await getProductPrice(tx, product.id, "public", ctx.now);
  if (!price) throw new ConflictError("product_unavailable");
  if (price.amountCents <= 0) throw new ConflictError("product_unavailable");
  let termsVersionId: string | null = null;
  if (channel === "link") {
    const terms = await getCurrentLegalVersion(tx, "terms");
    if (!terms) throw new ConflictError("terms_unavailable");
    termsVersionId = terms.versionId;
  }
  const [person] = await tx.select({ locale: persons.locale }).from(persons).where(eq(persons.id, input.personId));
  if (!person) throw new NotFoundError("person_not_found");
  const amount = price.amountCents;
  const vatRatePct = Number(product.vatRatePct);
  const vat = vatOf(amount, vatRatePct);
  const [order] = await tx
    .insert(orders)
    .values({
      reference: newOrderReference(),
      personId: input.personId,
      channel,
      status: "pending_payment",
      subtotalCents: amount,
      discountCents: 0,
      vatCents: vat,
      totalCents: amount,
      locale: person.locale,
      clientKey: randomUUID(),
      expiresAt: new Date(brusselsMidnight(input.periodEndOn).getTime() + RENEWAL_GRACE_DAYS * 86_400_000),
      renewalMembershipId: input.membershipId,
      renewalPeriodEndOn: input.periodEndOn,
      termsVersionId,
    })
    .returning();
  const trace: PricingTrace = {
    at: ctx.now.toISOString(),
    audience: "public",
    personStatus: null,
    baseVersionId: price.priceVersionId,
    baseUnitCents: amount,
    candidates: [{ source: "base", sourceId: price.priceVersionId, unitCents: amount, reason: "renewal" }],
    winner: "base",
    winnerSourceId: price.priceVersionId,
    isMember: false,
    quantity: 1,
    vatRatePct,
    rounding: "half_up",
  };
  await tx.insert(orderLines).values({
    orderId: order!.id,
    lineNo: 1,
    productId: product.id,
    productKind: product.kind,
    sku: product.sku,
    priceVersionId: price.priceVersionId,
    description: product.name,
    quantity: 1,
    unitAmountCents: amount,
    discountCents: 0,
    lineTotalCents: amount,
    vatRatePct: product.vatRatePct,
    vatCents: vat,
    pricingTrace: trace,
    data: {},
  });
  return order!;
}

async function findOrCreateRenewalOrder(tx: Tx, ctx: Ctx, input: RenewalInput, channel: "recurring" | "link"): Promise<OrderRow> {
  const existing = await findRenewalOrder(tx, input.membershipId, input.periodEndOn);
  if (existing) return existing;
  return insertRenewalOrder(tx, ctx, input, channel);
}

/**
 * api `createRecurringCharge`: the period's renewal order (created or reused) with a new
 * `recurring` payment on the given mandate, charged by `payments.charge_recurring` (key
 * `charge_recurring:<payment_id>`). A payment still in flight, or the paid payment of a paid
 * order, is returned instead of a new one.
 */
export async function createRecurringCharge(
  tx: Tx,
  ctx: Ctx,
  input: RenewalInput & { mandateId: string },
): Promise<{ orderId: string; paymentId: string }> {
  const [mandate] = await tx.select().from(mandates).where(eq(mandates.id, input.mandateId));
  if (!mandate || mandate.status !== "valid" || mandate.personId !== input.personId) throw new ConflictError("mandate_invalid");
  const order = await findOrCreateRenewalOrder(tx, ctx, input, "recurring");
  const [current] = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.orderId, order.id),
        order.status === "paid" ? inArray(payments.status, [...PAID_PAYMENT_STATUSES]) : inArray(payments.status, [...LIVE_STATUSES]),
      ),
    )
    .orderBy(desc(payments.createdAt))
    .limit(1);
  if (current) return { orderId: order.id, paymentId: current.id };
  if (order.status !== "pending_payment") throw new ConflictError("invalid_transition");

  const due = order.totalCents - (await paidCentsOf(tx, order.id));
  const [payment] = await tx
    .insert(payments)
    .values({
      orderId: order.id,
      provider: await recurringProvider(tx),
      sequenceType: "recurring",
      status: "open",
      amountCents: due,
      mandateId: mandate.id,
    })
    .returning({ id: payments.id });
  const paymentId = payment!.id;
  await ctx.enqueue({ kind: "payments.charge_recurring", payload: { paymentId }, key: `charge_recurring:${paymentId}` });
  return { orderId: order.id, paymentId };
}

/** api `createRenewalLinkOrder` (credits rule 52): the period's renewal order with its pay link. */
export async function createRenewalLinkOrder(tx: Tx, ctx: Ctx, input: RenewalInput): Promise<{ orderId: string; payUrl: string }> {
  const order = await findOrCreateRenewalOrder(tx, ctx, input, "link");
  const { payUrl } = await getPayLinkForOrder(tx, ctx, { orderId: order.id });
  return { orderId: order.id, payUrl };
}

/** api `getActiveMandate`: the person's latest `valid` mandate. */
export async function getActiveMandate(db: DbOrTx, personId: string): Promise<{ mandateId: string; method: string; summary: string | null } | null> {
  const [row] = await db
    .select({ id: mandates.id, method: mandates.method, summary: mandates.detailsSummary })
    .from(mandates)
    .where(and(eq(mandates.personId, personId), eq(mandates.status, "valid")))
    .orderBy(desc(mandates.createdAt), desc(mandates.id))
    .limit(1);
  return row ? { mandateId: row.id, method: row.method, summary: row.summary } : null;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type ChargeRecurringResult =
  | { providerPaymentId: string; status: string }
  | { skipped: true; status: string }
  | { failed: true; reason: string };

/**
 * `payments.charge_recurring` (key `charge_recurring:<payment_id>`): creates the recurring
 * payment at the provider with the job key as `Idempotency-Key` and stores its id; the final
 * status comes through the webhook and `payments.sync`. A provider refusal (a 4xx other than
 * 401/403), or a mandate that is gone locally, fails the payment, which calls
 * `credits.applyRenewalFailure` (rule 33). An unparseable 2xx or a 401/403 retries the job.
 */
export async function chargeRecurringPayment(ctx: JobCtx, input: { paymentId: string }): Promise<ChargeRecurringResult> {
  const tx = ctx.tx;
  const [payment] = await tx.select().from(payments).where(eq(payments.id, input.paymentId)).for("update");
  if (!payment) throw new NotFoundError("payment_not_found");
  if (payment.providerPaymentId) return { providerPaymentId: payment.providerPaymentId, status: payment.status };
  if (payment.status !== "open") return { skipped: true, status: payment.status };
  const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId));
  if (!order) throw new NotFoundError("order_not_found");
  const [mandate] = payment.mandateId ? await tx.select().from(mandates).where(eq(mandates.id, payment.mandateId)) : [];
  if (!mandate || mandate.status !== "valid") {
    await applyProviderStatus(tx, ctx, payment, { status: "failed", reason: "mandate_invalid" });
    return { failed: true, reason: "mandate_invalid" };
  }
  try {
    const created = await paymentsClient(ctx).createRecurringPayment({
      customerId: mandate.providerCustomerId,
      mandateId: mandate.providerMandateId,
      amountCents: payment.amountCents,
      description: order.reference,
      webhookUrl: mollieWebhookUrl(),
      metadata: { orderId: order.id, paymentId: payment.id },
      idempotencyKey: ctx.job.key,
    });
    await tx.update(payments).set({ providerPaymentId: created.providerPaymentId, updatedAt: ctx.now }).where(eq(payments.id, payment.id));
    return { providerPaymentId: created.providerPaymentId, status: payment.status };
  } catch (error) {
    if (error instanceof IntegrationError && !error.retryable) {
      if (isProviderRefusal(error)) {
        await applyProviderStatus(tx, ctx, payment, { status: "failed", reason: "provider_rejected" });
        return { failed: true, reason: "provider_rejected" };
      }
      // An unparseable 2xx (the debit may exist at the provider) or a 401/403 (a BEAM key fault):
      // the job retries with the same Idempotency-Key, so the provider returns the same payment;
      // a fault that persists ends as a dead job with an alert, not as a failed renewal.
      throw new RetryableError(`charge_recurring_unconfirmed: ${error.code ?? error.statusCode ?? "unknown"}`);
    }
    throw error;
  }
}

/** A genuine provider refusal of the charge: a 4xx other than 401/403 with a parsed error body. */
function isProviderRefusal(error: IntegrationError): boolean {
  const status = error.statusCode ?? 0;
  return error.code !== "invalid_response" && status >= 400 && status < 500 && status !== 401 && status !== 403;
}

export type CancelPaymentResult = { cancelled: true } | { notCancelable: true } | { skipped: true; status: string };

/**
 * `payments.cancel` (key `payment_cancel:<payment_id>`): cancels the open recurring payment of a
 * cancelled renewal order at the provider (rule 22c). The local row follows the answer without
 * the failure path (the order already ended, so no `applyRenewalFailure`). A provider "not
 * cancelable" succeeds with `notCancelable`; the later `paid` is refunded by
 * `refundLatePaidOnCancelledOrder`.
 */
export async function cancelProviderPayment(ctx: JobCtx, input: { paymentId: string }): Promise<CancelPaymentResult> {
  const tx = ctx.tx;
  const [payment] = await tx.select().from(payments).where(eq(payments.id, input.paymentId)).for("update");
  if (!payment) throw new NotFoundError("payment_not_found");
  if (!payment.providerPaymentId || !(LIVE_STATUSES as readonly string[]).includes(payment.status)) return { skipped: true, status: payment.status };
  let cancelled: boolean;
  try {
    ({ cancelled } = await paymentsClient(ctx).cancelPayment(payment.providerPaymentId));
  } catch (error) {
    if (error instanceof IntegrationError && !error.retryable) return { notCancelable: true };
    throw error;
  }
  if (!cancelled) return { notCancelable: true };
  const history = payment.statusHistory ?? [];
  const next = nextPaymentStatus(payment.status, "cancelled", "provider", history.at(-1)?.source ?? "provider");
  if (next) {
    await tx
      .update(payments)
      .set({ status: next, statusHistory: [...history, { status: next, at: ctx.now.toISOString(), source: "provider" }], failedReason: "order_cancelled", updatedAt: ctx.now })
      .where(eq(payments.id, payment.id));
  }
  return { cancelled: true };
}

export type LateRefundResult = { refunded: false; failed?: true } | { refunded: true; amountCents: number; providerRefundId: string };

/**
 * Edge case 36: a provider `paid` for a cancelled order (the SEPA debit of a cancelled renewal
 * order could not be cancelled) is refunded in full at once with reason `order_cancelled`. The
 * order stays `cancelled` and no credits function is called, so the ended membership is not
 * revived. No invoice was issued (the paid transaction never ran), so no credit note is due; the
 * refund is recorded on the payment (`refunded_cents`, status `refunded`) and on the timeline
 * (`order.refunded`). A provider refusal opens a finance task instead.
 */
export async function refundLatePaidOnCancelledOrder(ctx: Ctx & { integrations?: Integrations }, paymentId: string): Promise<LateRefundResult> {
  const tx = ctx.tx;
  const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
  if (!payment || payment.status !== "paid" || !payment.providerPaymentId) return { refunded: false };
  const order = await lockOrder(tx, payment.orderId);
  if (!order || order.status !== "cancelled") return { refunded: false };
  const amountCents = payment.amountCents - payment.refundedCents;
  if (amountCents <= 0) return { refunded: false };
  let result: { providerRefundId: string; status: "pending" | "refunded" | "failed" };
  try {
    result = await paymentsClient(ctx).refund({
      providerPaymentId: payment.providerPaymentId,
      amountCents,
      description: `${order.reference} order_cancelled`,
      idempotencyKey: `late_paid_refund:${payment.id}`,
    });
  } catch (error) {
    if (!(error instanceof IntegrationError) || error.retryable) throw error;
    result = { providerRefundId: "", status: "failed" };
  }
  if (result.status === "failed") {
    await createTask(tx, ctx, {
      title: t("nl-BE", "commerce.tasks.late_paid_refund", { reference: order.reference }),
      kind: "payment",
      ownerRole: "finance",
      ...(order.personId ? { personId: order.personId } : {}),
      ...(order.companyId ? { companyId: order.companyId } : {}),
      source: "system",
      ref: { type: "payment", id: payment.id },
      dedupeKey: `late_paid_refund:${payment.id}`,
    });
    return { refunded: false, failed: true };
  }
  const history = payment.statusHistory ?? [];
  await tx
    .update(payments)
    .set({
      status: "refunded",
      refundedCents: payment.amountCents,
      statusHistory: [...history, { status: "refunded", at: ctx.now.toISOString(), source: "provider" }],
      updatedAt: ctx.now,
    })
    .where(eq(payments.id, payment.id));
  const subject = orderSubject(order);
  if (subject) {
    await ctx.recordEvent({
      kind: "order.refunded",
      ...subject,
      ref: { type: "payment", id: payment.id },
      dedupeKey: `order:${order.id}:refunded:${payment.id}`,
      data: { order_id: order.id, amount_cents: amountCents, reason: "order_cancelled" },
    });
  }
  return { refunded: true, amountCents, providerRefundId: result.providerRefundId };
}
