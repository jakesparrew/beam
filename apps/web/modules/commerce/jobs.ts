/**
 * commerce jobs (`defineJob`, commerce spec section 4.5) and the Mollie webhook handler (section
 * 4.4). Facade read by `pnpm gen:indexes`.
 *
 * commerce-P4a: `payments.create` (inline), `payments.sync`, `commerce.render_receipt` and the
 * `mollie` webhook handler, which runs the same `syncPayment()` inside platform's
 * `webhook.process` transaction. `commerce.refund_unavailable_lines` is declared here because the
 * paid transaction enqueues it; it refunds through `refundOrderLine`, which commerce-P6 lands.
 *
 * commerce-P4b: `payments.scan_expired` (every minute), `payments.charge_recurring`,
 * `payments.cancel`, `commerce.revoke_mandate` and `commerce.erase_provider_customer`. After every
 * sync (job and webhook) a provider `paid` for a cancelled order is refunded in full (edge case 36).
 *
 * commerce-P5: `checkouts.mark_abandoned` (every 10 minutes; rules 49, 50). commerce-P8 (R2) adds
 * the recovery attribution of rule 51 to the same run (`./server/recovery`).
 *
 * commerce-P6: `payments.refund` (provider refunds), `payments.create_link` (the
 * `commerce.payment_link` email), `commerce.issue_voucher_email` (rule 45a),
 * `commerce.expire_vouchers` (daily, rule 47a) and the handler of
 * `commerce.refund_unavailable_lines`. After every sync the payment's `sent` refunds take the
 * provider's final status.
 *
 * commerce-P7: `payments.terminal` (inline, the POS card terminal) and
 * `payments.cancel_terminal` (a terminal payment staff cancelled at the counter is cancelled on
 * the device too; a device that already took the money opens a finance task).
 */
import { z } from "zod";
import { files, orders, persons } from "@beam/db/schema";
import { URL_SEGMENT, formatDate, formatMoney, pick, type Locale } from "@beam/core/i18n";
import { and, eq, NotFoundError } from "@/lib/ctx";
import { storeFile } from "@/lib/files";
import { defineJob, type JobCtx } from "@/lib/job-runner";
import { appUrl } from "@/lib/auth";
import { defineWebhookHandler } from "@/lib/webhooks";
import { sendTransactional } from "@/modules/email/api";
import { refundOrderLine } from "./api";
import { orderPageUrl } from "./server/paid";
import { createProviderPayment, syncPayment, type SyncResult } from "./server/payments";
import { scanExpired } from "./server/expiry";
import { markAbandoned, type MarkAbandonedResult } from "./server/checkouts";
import { attributeRecoveries, type AttributeRecoveriesResult } from "./server/recovery";
import { cancelProviderPayment, chargeRecurringPayment, refundLatePaidOnCancelledOrder } from "./server/recurring";
import { eraseProviderCustomer, revokeMandateAtProvider } from "./server/mandates";
import { loadReceiptInput, renderReceiptPdf } from "./ui/receipt-pdf";
import { runProviderRefund, syncProviderRefunds } from "./server/refunds";
import { CreatePayLinkInput, createPayLinkJob } from "./server/payment-links";
import { expireVouchers, issueVoucherEmail } from "./server/vouchers";
import { runCancelTerminal, runTerminalPayment } from "./server/pos";

export const PaymentsCreateInput = z.object({ paymentId: z.uuid(), redirectUrl: z.string().url().optional() });
export const PaymentsSyncInput = z.object({ providerPaymentId: z.string().min(1) });
export const RenderReceiptInput = z.object({ orderId: z.uuid() });
export const RefundUnavailableLinesInput = z.object({ orderId: z.uuid(), orderLineIds: z.array(z.uuid()).min(1) });
export const ScanExpiredInput = z.object({}).passthrough();
export const MarkAbandonedInput = z.object({}).passthrough();
export const ChargeRecurringInput = z.object({ paymentId: z.uuid() });
export const PaymentsCancelInput = z.object({ paymentId: z.uuid() });
export const RevokeMandateInput = z.object({ mandateId: z.uuid() });
export const EraseProviderCustomerInput = z.object({ providerCustomerId: z.string().min(1), mandateIds: z.array(z.string().min(1)) });
export const PaymentsRefundInput = z.object({ refundId: z.uuid() });
export { CreatePayLinkInput };
export const IssueVoucherEmailInput = z.object({ voucherId: z.uuid(), n: z.number().int().min(0), email: z.string().email().optional() });
export const ExpireVouchersInput = z.object({}).passthrough();
export const PaymentsTerminalInput = z.object({ paymentId: z.uuid(), terminalId: z.string().min(1) });
export const PaymentsCancelTerminalInput = z.object({ paymentId: z.uuid() });

/** `payments.terminal` (inline at the POS, key `payment_terminal:<payment_id>`). */
export function runPaymentsTerminal(ctx: JobCtx, input: z.infer<typeof PaymentsTerminalInput>) {
  return runTerminalPayment(ctx, input);
}

/** `payments.cancel_terminal` (key `payment_terminal_cancel:<payment_id>`). */
export function runPaymentsCancelTerminal(ctx: JobCtx, input: z.infer<typeof PaymentsCancelTerminalInput>) {
  return runCancelTerminal(ctx, input);
}

/** `payments.create` (inline at checkout, key `payment_create:<payment_id>`). */
export function runPaymentsCreate(ctx: JobCtx, input: z.infer<typeof PaymentsCreateInput>) {
  return createProviderPayment(ctx, input);
}

/** `payments.sync` (return-page polls and `payments.scan_expired`; key `payment_sync:<id>:<minute>`, recurring debits from the scan `payment_sync:<id>:<hour>`). */
export async function runPaymentsSync(ctx: JobCtx, input: z.infer<typeof PaymentsSyncInput>): Promise<SyncResult> {
  const result = await syncPayment(ctx, input.providerPaymentId);
  await afterSync(ctx, result);
  return result;
}

/** Edge case 36: a provider `paid` that reached a cancelled (renewal) order is refunded in full. */
async function afterSync(ctx: Parameters<typeof refundLatePaidOnCancelledOrder>[0], result: SyncResult): Promise<void> {
  if (result.ignored) return;
  if (result.status === "paid") await refundLatePaidOnCancelledOrder(ctx, result.paymentId);
  await syncProviderRefunds(ctx, result.paymentId);
}

/** `payments.refund` (key `refund:<refund_id>`, staff retries `refund:<id>:retry:<n>`). */
export function runPaymentsRefund(ctx: JobCtx, input: z.infer<typeof PaymentsRefundInput>) {
  return runProviderRefund(ctx, input);
}

/** `payments.create_link` (key `pay_link:<order_id>:<version>`). */
export function runCreatePayLink(ctx: JobCtx, input: z.infer<typeof CreatePayLinkInput>) {
  return createPayLinkJob(ctx, input);
}

/** `commerce.issue_voucher_email` (key `voucher_email:<voucher_id>:<n>`). */
export function runIssueVoucherEmail(ctx: JobCtx, input: z.infer<typeof IssueVoucherEmailInput>) {
  return issueVoucherEmail(ctx, input);
}

/** `commerce.expire_vouchers` (daily 00:20; key `schedule:commerce.expire_vouchers:<minute>`). */
export function runExpireVouchers(ctx: JobCtx) {
  return expireVouchers(ctx);
}

/** `payments.scan_expired` (every minute; rules 22, 22a, 34). */
export function runScanExpired(ctx: JobCtx) {
  return scanExpired(ctx);
}

/**
 * `checkouts.mark_abandoned` (every 10 minutes; key `schedule:checkouts.mark_abandoned:<minute>`):
 * rules 49 and 50, then the rule 51 recovery attribution (R2).
 */
export async function runMarkAbandoned(ctx: JobCtx): Promise<MarkAbandonedResult & AttributeRecoveriesResult> {
  const marked = await markAbandoned(ctx);
  return { ...marked, ...(await attributeRecoveries(ctx)) };
}

/** `payments.charge_recurring` (key `charge_recurring:<payment_id>`). */
export function runChargeRecurring(ctx: JobCtx, input: z.infer<typeof ChargeRecurringInput>) {
  return chargeRecurringPayment(ctx, input);
}

/** `payments.cancel` (key `payment_cancel:<payment_id>`). */
export function runPaymentsCancel(ctx: JobCtx, input: z.infer<typeof PaymentsCancelInput>) {
  return cancelProviderPayment(ctx, input);
}

/** `commerce.revoke_mandate` (key `mandate_revoke:<mandate_id>`). */
export function runRevokeMandate(ctx: JobCtx, input: z.infer<typeof RevokeMandateInput>) {
  return revokeMandateAtProvider(ctx, input);
}

/** `commerce.erase_provider_customer` (key `mollie_customer:<provider_customer_id>:delete`). */
export function runEraseProviderCustomer(ctx: JobCtx, input: z.infer<typeof EraseProviderCustomerInput>) {
  return eraseProviderCustomer(ctx, input);
}

const RECEIPT_STATUSES = new Set(["paid", "partially_refunded", "refunded"]);

/**
 * `commerce.render_receipt` (key `receipt:<order_id>`): renders the receipt PDF of a paid order
 * into `files` (kind `receipt`, one file per order, found again by name on a second run) and
 * sends the order confirmation with it attached (`commerce.order_confirmation`, POS orders
 * `commerce.pos_receipt`; key `order:<order_id>:receipt`) when the buyer has an email address.
 */
export async function runRenderReceipt(ctx: JobCtx, input: z.infer<typeof RenderReceiptInput>): Promise<{ fileId: string | null; emailMessageId: string | null }> {
  const [order] = await ctx.tx.select().from(orders).where(eq(orders.id, input.orderId));
  if (!order) throw new NotFoundError("order_not_found");
  if (!RECEIPT_STATUSES.has(order.status)) return { fileId: null, emailMessageId: null };
  const name = `receipt-${order.reference}.pdf`;
  const [existing] = await ctx.tx.select({ id: files.id }).from(files).where(and(eq(files.kind, "receipt"), eq(files.name, name)));
  let fileId = existing?.id ?? null;
  const receipt = await loadReceiptInput(ctx.tx, order.id);
  if (!receipt) throw new NotFoundError("order_not_found");
  if (!fileId) {
    const bytes = await renderReceiptPdf(receipt);
    fileId = (await storeFile(ctx, { kind: "receipt", name, mime: "application/pdf", bytes, ...(order.personId ? { personId: order.personId } : {}) })).fileId;
  }

  if (!order.personId) return { fileId, emailMessageId: null };
  const [person] = await ctx.tx.select({ email: persons.email }).from(persons).where(eq(persons.id, order.personId));
  if (!person?.email) return { fileId, emailMessageId: null };
  const locale = order.locale as Locale;
  const sent = await sendTransactional(ctx, {
    template: order.channel === "pos" ? "commerce.pos_receipt" : "commerce.order_confirmation",
    personId: order.personId,
    locale,
    data: {
      reference: order.reference,
      total: formatMoney(order.totalCents, locale),
      lines: receipt.lines.map((l) => ({ description: pick(l.description, locale, "order_lines.description"), quantity: l.quantity, amount: formatMoney(l.lineTotalCents, locale) })),
      orderUrl: orderPageUrl(order.id, locale),
      ...(order.withdrawalUntilAt
        ? { withdrawalUntil: formatDate(order.withdrawalUntilAt, locale, "long"), withdrawalUrl: appUrl(`/${URL_SEGMENT[locale]}/account/orders/${order.id}#withdrawal`) }
        : {}),
    },
    key: `order:${order.id}:receipt`,
    attachments: [{ fileId, filename: `BEAM-${order.reference}.pdf` }],
  });
  return { fileId, emailMessageId: sent.emailMessageId };
}

/**
 * `commerce.refund_unavailable_lines` (key `refund_unavailable:<order_id>`): refunds every seat
 * lost after a late payment with reason `seat_no_longer_available` (edge case 4). Each
 * `refundOrderLine` is idempotent per line and reason, so a second run refunds nothing twice.
 */
export async function runRefundUnavailableLines(ctx: JobCtx, input: z.infer<typeof RefundUnavailableLinesInput>) {
  const refunds: { orderLineId: string; refundId: string | null; amountCents: number }[] = [];
  for (const orderLineId of input.orderLineIds) {
    const r = await refundOrderLine(ctx.tx, ctx, { orderLineId, reason: "seat_no_longer_available" });
    refunds.push({ orderLineId, ...r });
  }
  return { refunds };
}

export const jobs = [
  defineJob({ kind: "payments.create", lane: "fast", priority: 1, inline: true, maxAttempts: 6, timeoutMs: 20_000, input: PaymentsCreateInput, run: runPaymentsCreate }),
  defineJob({ kind: "payments.sync", lane: "fast", priority: 1, maxAttempts: 6, input: PaymentsSyncInput, run: runPaymentsSync }),
  defineJob({ kind: "commerce.render_receipt", lane: "fast", priority: 5, maxAttempts: 6, input: RenderReceiptInput, run: runRenderReceipt }),
  defineJob({ kind: "commerce.refund_unavailable_lines", lane: "fast", priority: 2, maxAttempts: 6, input: RefundUnavailableLinesInput, run: runRefundUnavailableLines }),
  defineJob({ kind: "payments.scan_expired", lane: "fast", priority: 3, maxAttempts: 3, input: ScanExpiredInput, run: runScanExpired }),
  defineJob({ kind: "checkouts.mark_abandoned", lane: "fast", priority: 5, maxAttempts: 3, input: MarkAbandonedInput, run: runMarkAbandoned }),
  defineJob({ kind: "payments.charge_recurring", lane: "fast", priority: 2, maxAttempts: 6, input: ChargeRecurringInput, run: runChargeRecurring }),
  defineJob({ kind: "payments.cancel", lane: "fast", priority: 2, maxAttempts: 6, input: PaymentsCancelInput, run: runPaymentsCancel }),
  defineJob({ kind: "commerce.revoke_mandate", lane: "fast", priority: 3, maxAttempts: 6, input: RevokeMandateInput, run: runRevokeMandate }),
  defineJob({ kind: "commerce.erase_provider_customer", lane: "fast", priority: 5, maxAttempts: 6, input: EraseProviderCustomerInput, run: runEraseProviderCustomer }),
  defineJob({ kind: "payments.refund", lane: "fast", priority: 2, maxAttempts: 6, input: PaymentsRefundInput, run: runPaymentsRefund }),
  defineJob({ kind: "payments.create_link", lane: "fast", priority: 2, maxAttempts: 6, input: CreatePayLinkInput, run: runCreatePayLink }),
  defineJob({ kind: "commerce.issue_voucher_email", lane: "fast", priority: 2, maxAttempts: 6, input: IssueVoucherEmailInput, run: runIssueVoucherEmail }),
  defineJob({ kind: "payments.terminal", lane: "fast", priority: 1, inline: true, maxAttempts: 6, timeoutMs: 20_000, input: PaymentsTerminalInput, run: runPaymentsTerminal }),
  defineJob({ kind: "payments.cancel_terminal", lane: "fast", priority: 1, maxAttempts: 6, input: PaymentsCancelTerminalInput, run: runPaymentsCancelTerminal }),
  defineJob({ kind: "commerce.expire_vouchers", lane: "bulk", priority: 9, maxAttempts: 3, input: ExpireVouchersInput, run: runExpireVouchers }),
];

/**
 * The Mollie webhook (section 4.4): the inbox stored `{ id }`; `syncPayment` fetches the payment
 * and applies it in the `webhook.process` transaction. Ids that are not `tr_...` are ignored; a
 * payment not committed yet throws `RetryableError` for the 60 s backoff.
 */
export const webhookHandlers = [
  defineWebhookHandler({
    provider: "mollie",
    handle: async (ctx, event) => {
      const id = (event.payload as { id?: unknown } | null)?.id;
      if (typeof id !== "string") return;
      await afterSync(ctx, await syncPayment(ctx, id));
    },
  }),
];
