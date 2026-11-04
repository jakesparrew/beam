/**
 * Settlement (finance rules 2a, 24, 26, 27, 30a). An `open` bank-transfer invoice becomes `paid`
 * once, by whichever path comes first (commerce's paid transaction through `issueInvoice`,
 * Billit's paid status, staff "Mark paid"); a later path is a no-op. A credit note becomes `paid`
 * when commerce reports its refund executed. A document settled in BEAM after its Billit push
 * gets `billit_payment_status = 'pending'` and the job `billit.push_payment`; documents settled
 * by Billit itself stay `not_applicable`.
 */
import type { Tx } from "@beam/db";
import { invoices, payments, refunds } from "@beam/db/schema";
import { FinanceConflictError, type InvoiceRecord, type InvoiceSettledVia } from "@beam/core/finance";
import { eq, NotFoundError, type Ctx } from "@/lib/ctx";
import { assertCustomerOwns, enqueueFinanceJob, eventSubject, loadInvoice, updateInvoiceState, type InvoiceMutableFields } from "./invoice-state";

type PaymentRow = typeof payments.$inferSelect;

/** `payment_method` snapshot of one payment (section 2.2): euro credit is `voucher`. */
export function paymentMethodOf(p: Pick<PaymentRow, "provider" | "method">): string | null {
  switch (p.provider) {
    case "credit_balance":
      return "voucher";
    case "cash":
      return "cash";
    case "terminal":
      return "terminal";
    case "bank_transfer":
      return "bank_transfer";
    default: {
      const m = p.method?.trim().toLowerCase();
      if (!m) return null;
      if (m === "card" || m === "credit_card") return "creditcard";
      return m;
    }
  }
}

/**
 * The payment snapshot of a document settled by `paid` (one or more paid payments): provider,
 * method and transaction reference of the single payment, or `mixed` when more than one payment
 * settles the order (rule 8). The settling payment id is the given one, else the largest
 * non-euro-credit payment.
 */
export function paymentSnapshot(
  paid: readonly PaymentRow[],
  settlingId?: string,
): Pick<InvoiceRecord, "paymentId" | "paymentProvider" | "paymentMethod" | "paymentTransactionRef"> {
  if (paid.length === 0) return { paymentId: null, paymentProvider: null, paymentMethod: null, paymentTransactionRef: null };
  const byAmount = [...paid].sort((a, b) => b.amountCents - a.amountCents);
  const main = paid.find((p) => p.id === settlingId) ?? byAmount.find((p) => p.provider !== "credit_balance") ?? byAmount[0]!;
  if (paid.length === 1) {
    return { paymentId: main.id, paymentProvider: main.provider, paymentMethod: paymentMethodOf(main), paymentTransactionRef: main.providerPaymentId ?? null };
  }
  return { paymentId: main.id, paymentProvider: "mixed", paymentMethod: "mixed", paymentTransactionRef: main.providerPaymentId ?? null };
}

export type MarkInvoicePaidInput = {
  invoiceId: string;
  paidAt: Date;
  settledVia: Exclude<InvoiceSettledVia, "credit_note">;
  paymentId?: string;
  /** The bank reference staff recorded (printed as the transaction reference). */
  bankReference?: string;
};

/**
 * Settles an `open` invoice (rules 2a, 26, 27). Returns `{ changed: false }` when it is already
 * `paid`; any other status is an `InvalidTransitionError`. Records `invoice.paid` once.
 */
export async function markInvoicePaidInternal(tx: Tx, ctx: Ctx, input: MarkInvoicePaidInput): Promise<{ changed: boolean }> {
  const invoice = await loadInvoice(tx, input.invoiceId, { forUpdate: true });
  assertCustomerOwns(ctx, invoice.personId);
  if (invoice.kind !== "invoice") throw new FinanceConflictError("finance.errors.not_an_invoice");
  if (invoice.status === "paid") return { changed: false };

  const patch: InvoiceMutableFields = { status: "paid", paidAt: input.paidAt, settledVia: input.settledVia };
  if (input.paymentId) {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, input.paymentId));
    if (!payment || payment.orderId !== invoice.orderId) throw new NotFoundError("finance.errors.payment_not_found");
    const snap = paymentSnapshot([payment], payment.id);
    patch.paymentId = payment.id;
    if (snap.paymentProvider) patch.paymentProvider = snap.paymentProvider;
    if (snap.paymentMethod) patch.paymentMethod = snap.paymentMethod;
    const ref = input.bankReference ?? snap.paymentTransactionRef;
    if (ref) patch.paymentTransactionRef = ref;
  } else {
    patch.paymentProvider = "bank_transfer";
    patch.paymentMethod = "bank_transfer";
    if (input.bankReference) patch.paymentTransactionRef = input.bankReference;
  }
  // Settlement columns are set once: keep whatever an earlier step already stored.
  for (const key of ["paymentId", "paymentProvider", "paymentMethod", "paymentTransactionRef"] as const) {
    if (invoice[key] != null) delete patch[key];
  }
  const pushPayment = invoice.billitId != null && input.settledVia !== "billit";
  if (pushPayment) patch.billitPaymentStatus = "pending";

  await updateInvoiceState(tx, invoice.id, patch);
  if (pushPayment) await enqueuePushPayment(ctx, invoice.id);
  const subject = eventSubject(invoice);
  if (subject) {
    await ctx.recordEvent({
      kind: "invoice.paid",
      ...subject,
      data: { invoice_id: invoice.id, number: invoice.number, settled_via: input.settledVia },
      ref: { type: "invoice", id: invoice.id },
      dedupeKey: `invoice:${invoice.id}:paid`,
    });
  }
  return { changed: true };
}

/** Commerce reports the refund of a credit note executed (rule 24). Idempotent. */
export async function markCreditNoteSettled(tx: Tx, ctx: Ctx, input: { refundId: string; settledAt: Date }): Promise<void> {
  const [found] = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.refundId, input.refundId));
  if (!found) throw new NotFoundError("finance.errors.credit_note_not_found");
  const note = await loadInvoice(tx, found.id, { forUpdate: true });
  assertCustomerOwns(ctx, note.personId);
  if (note.status === "paid") return;

  const [refund] = await tx.select().from(refunds).where(eq(refunds.id, input.refundId));
  const [payment] = refund ? await tx.select().from(payments).where(eq(payments.id, refund.paymentId)) : [];
  const patch: InvoiceMutableFields = { status: "paid", paidAt: input.settledAt, settledVia: "provider" };
  if (payment && note.paymentId == null) {
    const snap = paymentSnapshot([payment], payment.id);
    patch.paymentId = payment.id;
    if (snap.paymentProvider) patch.paymentProvider = snap.paymentProvider;
    if (snap.paymentMethod) patch.paymentMethod = snap.paymentMethod;
    if (snap.paymentTransactionRef) patch.paymentTransactionRef = snap.paymentTransactionRef;
  }
  const pushPayment = note.billitId != null;
  if (pushPayment) patch.billitPaymentStatus = "pending";

  await updateInvoiceState(tx, note.id, patch);
  if (pushPayment) await enqueuePushPayment(ctx, note.id);
  const subject = eventSubject(note);
  if (subject) {
    await ctx.recordEvent({
      kind: "credit_note.settled",
      ...subject,
      data: { credit_note_id: note.id, number: note.number, refund_id: input.refundId },
      ref: { type: "invoice", id: note.id },
      dedupeKey: `credit_note:${note.id}:settled`,
    });
  }
}

function enqueuePushPayment(ctx: Ctx, invoiceId: string) {
  return enqueueFinanceJob(ctx, { kind: "billit.push_payment", payload: { invoiceId }, key: `billit:payment:${invoiceId}` });
}
