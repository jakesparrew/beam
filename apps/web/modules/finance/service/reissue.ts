/**
 * Reissue (finance rule 20, section 4.2, finance-P5): in one transaction a full credit note
 * ("Reissued to company" or the staff reason) cancels the original invoice and a new invoice
 * carries the corrected billing snapshot, `replaces_invoice_id`, the same lines, totals,
 * payment and settlement. Used by staff's `reissueInvoice` and by the approval of a customer's
 * company invoice request (`decideCompanyInvoiceRequest`). The new invoice gets its own number,
 * PDF and (rule 38) the invoice email, because it replaces another document.
 */
import type { Tx } from "@beam/db";
import { invoices } from "@beam/db/schema";
import {
  BillingDetailsInput,
  buildCustomerSnapshot,
  buildSellerSnapshot,
  FinanceConflictError,
  formatNumber,
  isAnonymisedSnapshot,
  structuredCommunication,
  type BillingDetails,
} from "@beam/core/finance";
import { and, eq, ValidationError, type Ctx } from "@/lib/ctx";
import { setOrderBillingDetails } from "./billing-details";
import { enqueueFinanceJob, eventSubject, issuedByOf, loadInvoice } from "./invoice-state";
import { issueCreditNote } from "./issue-credit-note";
import { issuerSettings } from "./issue-invoice";
import { allocateNumberAndInstant } from "./sequences";

export type ReissueResult = { creditNoteId: string; invoiceId: string; number: string };

function parseBilling(billing: BillingDetails): BillingDetails {
  const parsed = BillingDetailsInput.safeParse(billing);
  if (parsed.success) return parsed.data;
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues) fields[`billing.${issue.path.join(".")}`] = issue.message;
  throw new ValidationError("finance.errors.billing_invalid", fields);
}

/**
 * Credits invoice `invoiceId` in full and issues its replacement for `billing`. Refused with
 * `conflict` for a credit note, a cancelled invoice, an invoice that already has credit notes
 * (the replacement would bill credited lines again) and an anonymised document.
 */
export async function reissueToCompany(tx: Tx, ctx: Ctx, input: { invoiceId: string; billing: BillingDetails; reason: string }): Promise<ReissueResult> {
  const billing = parseBilling(input.billing);
  const original = await loadInvoice(tx, input.invoiceId, { forUpdate: true });
  if (original.kind !== "invoice") throw new FinanceConflictError("finance.errors.not_an_invoice");
  if (original.status === "cancelled") throw new FinanceConflictError("finance.errors.invalid_transition");
  if (isAnonymisedSnapshot(original.customerSnapshot)) throw new FinanceConflictError("finance.errors.invoice_immutable");
  const [credited] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.kind, "credit_note"), eq(invoices.reversesInvoiceId, original.id)))
    .limit(1);
  if (credited) throw new FinanceConflictError("finance.errors.reissue_after_credit");

  const credit = await issueCreditNote(tx, ctx, { invoiceId: original.id, reason: input.reason, noRefund: true });

  // Later emails and pushes of the order read the corrected identity (rule 39).
  await setOrderBillingDetails(tx, ctx, { orderId: original.orderId, details: billing });

  const previous = original.customerSnapshot;
  const snapshot = buildCustomerSnapshot({
    billing,
    ...(!isAnonymisedSnapshot(previous) && previous.person_id
      ? { person: { id: previous.person_id, firstName: previous.name, lastName: "", email: previous.email, phone: previous.phone, address: null, locale: original.locale } }
      : {}),
  });
  if (original.companyId) snapshot.company_id = original.companyId;
  const isCompany = snapshot.kind === "company" && !!snapshot.vat_number;

  const { company, finance } = await issuerSettings(tx);
  // Rule 12: the issue instant is fixed under the sequence lock, never before it.
  const { fiscalYear, sequenceNumber, issuedAt, issuedOn } = await allocateNumberAndInstant(tx, ctx, "invoice");
  const number = formatNumber("invoice", fiscalYear, sequenceNumber);
  const open = original.status === "open";
  const [row] = await tx
    .insert(invoices)
    .values({
      kind: "invoice",
      number,
      fiscalYear,
      sequenceNumber,
      replacesInvoiceId: original.id,
      orderId: original.orderId,
      paymentId: original.paymentId,
      personId: original.personId,
      companyId: original.companyId,
      isCompany,
      locale: original.locale,
      customerSnapshot: snapshot,
      sellerSnapshot: buildSellerSnapshot(company, finance, original.locale),
      lines: original.lines,
      subtotalCents: original.subtotalCents,
      vatCents: original.vatCents,
      totalCents: original.totalCents,
      vatBreakdown: original.vatBreakdown,
      issuedOn,
      issuedAt,
      status: open ? "open" : "paid",
      ...(open ? { dueOn: original.dueOn, paymentReference: structuredCommunication(fiscalYear, sequenceNumber) } : {}),
      paidAt: original.paidAt,
      settledVia: original.settledVia,
      paymentProvider: original.paymentProvider,
      paymentMethod: original.paymentMethod,
      paymentTransactionRef: original.paymentTransactionRef,
      peppolStatus: isCompany ? "pending" : "not_applicable",
      issuedBy: issuedByOf(ctx),
    })
    .returning({ id: invoices.id });
  const invoiceId = row!.id;

  await enqueueFinanceJob(ctx, { kind: "finance.render_pdf", payload: { invoiceId }, key: `invoice_pdf:${invoiceId}` });
  const subject = eventSubject(original);
  if (subject) {
    await ctx.recordEvent({
      kind: "invoice.issued",
      ...subject,
      data: { invoice_id: invoiceId, number, total_cents: original.totalCents, is_company: isCompany, status: open ? "open" : "paid" },
      ref: { type: "invoice", id: invoiceId },
      dedupeKey: `invoice:${invoiceId}:issued`,
    });
  }
  return { creditNoteId: credit.creditNoteId, invoiceId, number };
}
