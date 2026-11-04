/**
 * Credit notes (finance rules 21 to 25). A refund in commerce creates exactly one credit note
 * in the refund's transaction (one per `refund_id`); staff corrections and commerce's
 * `cancelOrder` of an unpaid bank-transfer order issue one with `noRefund: true`. The invoice
 * row is locked `for update`, earlier credit notes are summed per line (`creditLines`), and
 * crediting more than is left fails with `finance.errors.credit_exceeds_invoice`. The credit
 * note copies the invoice's customer snapshot (the reduced one for an erased person) and its
 * locale, takes its own `CN-<year>-<n>` number, and stores negative amounts. When the credit
 * notes reach the invoice total, the invoice becomes `cancelled`.
 */
import type { Tx } from "@beam/db";
import { invoices, refunds } from "@beam/db/schema";
import {
  buildSellerSnapshot,
  buildVatBreakdown,
  creditLines,
  documentTotals,
  FinanceConflictError,
  FinanceValidationError,
  formatNumber,
  type InvoiceLine,
  type InvoiceRecord,
} from "@beam/core/finance";
import { and, eq, ne, NotFoundError, type Ctx } from "@/lib/ctx";
import type { IssueCreditNoteInput } from "../api";
import { assertCustomerOwns, enqueueFinanceJob, eventSubject, issuedByOf, loadInvoice, updateInvoiceState } from "./invoice-state";
import { financeLabel, issuerSettings } from "./issue-invoice";
import { allocateNumberAndInstant } from "./sequences";

export type IssueCreditNoteResult = { creditNoteId: string; number: string; totalCents: number };

/** The invoice a credit-note request points at (`invoiceId`, else the live invoice of `orderId`), locked. */
async function targetInvoice(tx: Tx, input: IssueCreditNoteInput): Promise<InvoiceRecord> {
  if (input.invoiceId) return loadInvoice(tx, input.invoiceId, { forUpdate: true });
  if (!input.orderId) throw new FinanceValidationError("finance.errors.invoice_or_order_required");
  const [live] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.orderId, input.orderId), eq(invoices.kind, "invoice"), ne(invoices.status, "cancelled")));
  if (!live) throw new NotFoundError("finance.errors.invoice_not_found");
  return loadInvoice(tx, live.id, { forUpdate: true });
}

export async function issueCreditNote(tx: Tx, ctx: Ctx, input: IssueCreditNoteInput): Promise<IssueCreditNoteResult> {
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 3 || reason.length > 500) throw new FinanceValidationError("finance.errors.reason_required");
  if (ctx.actor.kind === "customer" || ctx.actor.kind === "public") {
    // Customers never issue credit notes; their own documents read as not found, never forbidden.
    throw new NotFoundError("finance.errors.not_found");
  }

  const invoice = await targetInvoice(tx, input);
  assertCustomerOwns(ctx, invoice.personId);
  if (input.orderId && input.invoiceId && invoice.orderId !== input.orderId) throw new NotFoundError("finance.errors.invoice_not_found");
  if (invoice.kind !== "invoice") throw new FinanceConflictError("finance.errors.not_an_invoice");

  if (input.refundId) {
    const [already] = await tx
      .select({ id: invoices.id, number: invoices.number, totalCents: invoices.totalCents })
      .from(invoices)
      .where(eq(invoices.refundId, input.refundId));
    if (already) return { creditNoteId: already.id, number: already.number, totalCents: already.totalCents };
    const [refund] = await tx.select({ orderId: refunds.orderId }).from(refunds).where(eq(refunds.id, input.refundId));
    if (!refund || refund.orderId !== invoice.orderId) throw new NotFoundError("finance.errors.refund_not_found");
  } else if (!input.noRefund && invoice.status !== "open") {
    // Rule 25: without a refund only on an open invoice or with the explicit no-refund flag.
    throw new FinanceConflictError("finance.errors.no_refund_flag_required");
  }
  if (invoice.status === "cancelled") throw new FinanceConflictError("finance.errors.credit_exceeds_invoice", { invoiceId: invoice.id });

  const earlier = await tx
    .select({ lines: invoices.lines, totalCents: invoices.totalCents })
    .from(invoices)
    .where(and(eq(invoices.reversesInvoiceId, invoice.id), eq(invoices.kind, "credit_note")));
  const already: InvoiceLine[][] = earlier.map((n) => n.lines);
  const creditedBefore = -earlier.reduce((sum, n) => sum + n.totalCents, 0);

  const lines = creditLines(invoice.lines, already, input.lines?.length ? input.lines : "full", {
    partialCreditLabel: financeLabel(invoice.locale, "finance.pdf.partial_credit"),
  });
  const totals = documentTotals(lines);
  if (creditedBefore - totals.totalCents > invoice.totalCents || totals.totalCents >= 0) {
    throw new FinanceConflictError("finance.errors.credit_exceeds_invoice", { invoiceId: invoice.id });
  }

  const { company, finance } = await issuerSettings(tx);
  // Rule 12: the issue instant is fixed under the sequence lock, never before it.
  const { fiscalYear, sequenceNumber, issuedAt, issuedOn } = await allocateNumberAndInstant(tx, ctx, "credit_note");
  const number = formatNumber("credit_note", fiscalYear, sequenceNumber);
  const [row] = await tx
    .insert(invoices)
    .values({
      kind: "credit_note",
      number,
      fiscalYear,
      sequenceNumber,
      reversesInvoiceId: invoice.id,
      orderId: invoice.orderId,
      refundId: input.refundId ?? null,
      personId: invoice.personId,
      companyId: invoice.companyId,
      isCompany: invoice.isCompany,
      locale: invoice.locale,
      customerSnapshot: invoice.customerSnapshot,
      sellerSnapshot: buildSellerSnapshot(company, finance, invoice.locale),
      lines,
      subtotalCents: totals.subtotalCents,
      vatCents: totals.vatCents,
      totalCents: totals.totalCents,
      vatBreakdown: buildVatBreakdown(lines),
      issuedOn,
      issuedAt,
      status: "issued",
      reason,
      peppolStatus: invoice.isCompany ? "pending" : "not_applicable",
      issuedBy: issuedByOf(ctx),
    })
    .returning({ id: invoices.id });
  const creditNoteId = row!.id;

  if (creditedBefore - totals.totalCents === invoice.totalCents) {
    await updateInvoiceState(tx, invoice.id, { status: "cancelled" });
  }

  await enqueueFinanceJob(ctx, { kind: "finance.render_pdf", payload: { invoiceId: creditNoteId }, key: `invoice_pdf:${creditNoteId}` });
  const subject = eventSubject(invoice);
  if (subject) {
    await ctx.recordEvent({
      kind: "credit_note.issued",
      ...subject,
      data: { credit_note_id: creditNoteId, number, invoice_number: invoice.number, total_cents: totals.totalCents, refund_id: input.refundId ?? null },
      ref: { type: "invoice", id: creditNoteId },
      dedupeKey: `credit_note:${creditNoteId}:issued`,
    });
  }
  return { creditNoteId, number, totalCents: totals.totalCents };
}
