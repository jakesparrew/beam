/**
 * commerce jobs (`defineJob`, commerce spec section 4.5) and the Mollie webhook handler (section
 * 4.4). Facade read by `pnpm gen:indexes`.
 *
 * commerce-P4a: `payments.create` (inline), `payments.sync`, `commerce.render_receipt` and the
 * `mollie` webhook handler, which runs the same `syncPayment()` inside platform's
 * `webhook.process` transaction. `commerce.refund_unavailable_lines` is declared here because the
 * paid transaction enqueues it; it refunds through `refundOrderLine`, which commerce-P6 lands.
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
import { createProviderPayment, syncPayment } from "./server/payments";
import { loadReceiptInput, renderReceiptPdf } from "./ui/receipt-pdf";

export const PaymentsCreateInput = z.object({ paymentId: z.uuid(), redirectUrl: z.string().url().optional() });
export const PaymentsSyncInput = z.object({ providerPaymentId: z.string().min(1) });
export const RenderReceiptInput = z.object({ orderId: z.uuid() });
export const RefundUnavailableLinesInput = z.object({ orderId: z.uuid(), orderLineIds: z.array(z.uuid()).min(1) });

/** `payments.create` (inline at checkout, key `payment_create:<payment_id>`). */
export function runPaymentsCreate(ctx: JobCtx, input: z.infer<typeof PaymentsCreateInput>) {
  return createProviderPayment(ctx, input);
}

/** `payments.sync` (return-page polls and `payments.scan_expired`; key `payment_sync:<id>:<minute>`). */
export function runPaymentsSync(ctx: JobCtx, input: z.infer<typeof PaymentsSyncInput>) {
  return syncPayment(ctx, input.providerPaymentId);
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
      await syncPayment(ctx, id);
    },
  }),
];
