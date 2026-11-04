/**
 * Issuing invoices (finance rules 1 to 16). Commerce calls `issueInvoice` inside the transaction
 * that marks an order paid (`status: 'paid'`) and when it places a bank-transfer order
 * (`status: 'open'`). The order's invoices are locked first; any existing invoice of the order,
 * live or cancelled, is returned as `existing` (an `open` one is settled first by a `paid` call,
 * rule 2a), so a repeated `payments.sync` never issues twice. Zero-total orders get no invoice.
 * Lines are copied 1:1 from `order_lines`; their total must equal `orders.total_cents`, else the
 * call throws `conflict` and the caller's transaction rolls back with the number allocation.
 */
import type { Tx } from "@beam/db";
import { companies, invoices, orderLines, orders, payments, persons, products, sessions } from "@beam/db/schema";
import {
  buildCustomerSnapshot,
  buildSellerSnapshot,
  buildVatBreakdown,
  documentTotals,
  FinanceConflictError,
  formatNumber,
  linesFromOrderLines,
  structuredCommunication,
  type CompanySetting,
  type FinanceSetting,
  type FullCustomerSnapshot,
  type OrderLineForInvoice,
} from "@beam/core/finance";
import { isLocale, t, type Locale } from "@beam/core/i18n";
import { and, asc, desc, eq, inArray, NotFoundError, ValidationError, type Ctx } from "@/lib/ctx";
import { logger } from "@/lib/logger";
import { getSetting } from "@/lib/settings";
import type { IssueInvoiceInput, IssueInvoiceResult } from "../api";
import { getOrderBillingDetails } from "./billing-details";
import { assertCustomerOwns, enqueueFinanceJob, eventSubject, issuedByOf } from "./invoice-state";
import { allocateNumberAndInstant } from "./sequences";
import { markInvoicePaidInternal, paymentSnapshot } from "./settle";

/** Payment statuses that count as money received for the payment snapshot. */
const PAID_PAYMENT_STATUSES = ["paid", "refunded", "partially_refunded"] as const;

const FALLBACK_LABELS = {
  "finance.pdf.walk_in": { "nl-BE": "Toevallige klant", "fr-BE": "Client de passage", en: "Walk-in customer" },
  "finance.pdf.partial_credit": { "nl-BE": "Gedeeltelijke creditering:", "fr-BE": "Crédit partiel :", en: "Partial credit:" },
};

/** A finance catalogue label; the built-in copy until finance-P3 adds the `finance.pdf.*` keys. */
export function financeLabel(locale: Locale, key: keyof typeof FALLBACK_LABELS): string {
  return t.has(locale, key) ? t(locale, key) : FALLBACK_LABELS[key][locale];
}

/** The `company` and `finance` settings as finance reads them. */
export async function issuerSettings(tx: Tx): Promise<{ company: CompanySetting; finance: FinanceSetting }> {
  const [company, finance] = await Promise.all([getSetting(tx, "company"), getSetting(tx, "finance")]);
  return { company: company, finance: finance };
}

/** `YYYY-MM-DD` plus `days` calendar days. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function issueInvoice(tx: Tx, ctx: Ctx, input: IssueInvoiceInput): Promise<IssueInvoiceResult> {
  const status = input.status ?? "paid";
  if (input.dueOn !== undefined && !DAY.test(input.dueOn)) throw new ValidationError("finance.errors.due_on_invalid", { dueOn: "date" });

  const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).for("update");
  if (!order) throw new NotFoundError("finance.errors.order_not_found");
  assertCustomerOwns(ctx, order.personId);

  // Rule 1: any invoice of the order, live or cancelled, is returned; the newest first.
  const existing = await tx
    .select({ id: invoices.id, number: invoices.number, status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.orderId, order.id), eq(invoices.kind, "invoice")))
    .orderBy(desc(invoices.issuedAt), desc(invoices.fiscalYear), desc(invoices.sequenceNumber))
    .for("update");
  const newest = existing[0];
  if (newest) {
    if (status === "paid" && newest.status === "open") {
      await markInvoicePaidInternal(tx, ctx, {
        invoiceId: newest.id,
        paidAt: input.paidAt ?? ctx.now,
        settledVia: input.settledVia ?? "manual",
        ...(input.paymentId ? { paymentId: input.paymentId } : {}),
      });
    }
    return { status: "existing", invoiceId: newest.id, number: newest.number };
  }

  if (order.totalCents === 0) return { status: "skipped", reason: "zero_total" };

  const { company, finance } = await issuerSettings(tx);
  const [person] = order.personId ? await tx.select().from(persons).where(eq(persons.id, order.personId)) : [];
  const [crmCompany] = order.companyId ? await tx.select().from(companies).where(eq(companies.id, order.companyId)) : [];
  const billing = await getOrderBillingDetails(tx, order.id);
  const walkIn = !person && !crmCompany && !billing;

  const preferred: Locale = walkIn ? "nl-BE" : (person?.locale ?? (isLocale(order.locale) ? order.locale : "nl-BE"));
  const rows = await orderLinesForInvoice(tx, order.id);
  const { lines, locale } = linesFromOrderLines(rows, preferred, finance.vat_notes);
  if (locale !== preferred) logger.warn({ orderId: order.id, missingLocale: preferred }, "invoice rendered in nl-BE fallback");

  const totals = documentTotals(lines);
  if (totals.totalCents !== order.totalCents) {
    throw new FinanceConflictError("finance.errors.total_mismatch", { orderId: order.id, linesTotalCents: totals.totalCents, orderTotalCents: order.totalCents });
  }

  const snapshot: FullCustomerSnapshot = buildCustomerSnapshot({
    ...(person
      ? { person: { id: person.id, firstName: person.firstName, lastName: person.lastName, email: person.email, phone: person.phone, address: person.address ?? null, locale: person.locale } }
      : {}),
    ...(crmCompany ? { company: { id: crmCompany.id, name: crmCompany.name, vatNumber: crmCompany.vatNumber, address: crmCompany.address ?? null } } : {}),
    ...(billing ? { billing } : {}),
    walkInName: financeLabel(locale, "finance.pdf.walk_in"),
  });
  const isCompany = snapshot.kind === "company" && !!snapshot.vat_number;

  // Rule 12: the issue instant is fixed under the sequence lock, never before it.
  const { fiscalYear, sequenceNumber, issuedAt, issuedOn } = await allocateNumberAndInstant(tx, ctx, "invoice");
  const settlement =
    status === "paid"
      ? await paidSettlement(tx, order, input, issuedAt)
      : { paymentId: null, paymentProvider: null, paymentMethod: null, paymentTransactionRef: null, paidAt: null, settledVia: null };

  const number = formatNumber("invoice", fiscalYear, sequenceNumber);
  const [row] = await tx
    .insert(invoices)
    .values({
      kind: "invoice",
      number,
      fiscalYear,
      sequenceNumber,
      orderId: order.id,
      personId: order.personId ?? null,
      companyId: order.companyId ?? null,
      isCompany,
      locale,
      customerSnapshot: snapshot,
      sellerSnapshot: buildSellerSnapshot(company, finance, locale),
      lines,
      subtotalCents: totals.subtotalCents,
      vatCents: totals.vatCents,
      totalCents: totals.totalCents,
      vatBreakdown: buildVatBreakdown(lines),
      issuedOn,
      issuedAt,
      status,
      ...(status === "open"
        ? { dueOn: input.dueOn ?? addDays(issuedOn, finance.payment_terms_days), paymentReference: structuredCommunication(fiscalYear, sequenceNumber) }
        : {}),
      ...settlement,
      peppolStatus: isCompany ? "pending" : "not_applicable",
      issuedBy: issuedByOf(ctx),
    })
    .returning({ id: invoices.id });
  const invoiceId = row!.id;

  await enqueueFinanceJob(ctx, { kind: "finance.render_pdf", payload: { invoiceId }, key: `invoice_pdf:${invoiceId}` });
  const subject = eventSubject({ personId: order.personId, companyId: order.companyId });
  if (subject) {
    await ctx.recordEvent({
      kind: "invoice.issued",
      ...subject,
      data: { invoice_id: invoiceId, number, total_cents: totals.totalCents, is_company: isCompany, status },
      ref: { type: "invoice", id: invoiceId },
      dedupeKey: `invoice:${invoiceId}:issued`,
    });
  }
  return { status: "issued", invoiceId, number };
}

/** The order lines with their product's credit data and session start, as `linesFromOrderLines` reads them. */
async function orderLinesForInvoice(tx: Tx, orderId: string): Promise<OrderLineForInvoice[]> {
  const rows = await tx
    .select({
      line: orderLines,
      creditKind: products.creditKind,
      creditUnits: products.creditUnits,
      startsAt: sessions.startsAt,
    })
    .from(orderLines)
    .innerJoin(products, eq(products.id, orderLines.productId))
    .leftJoin(sessions, eq(sessions.id, orderLines.sessionId))
    .where(eq(orderLines.orderId, orderId))
    .orderBy(asc(orderLines.lineNo));
  return rows.map(({ line, creditKind, creditUnits, startsAt }) => ({
    id: line.id,
    lineNo: line.lineNo,
    productId: line.productId,
    productKind: line.productKind,
    sku: line.sku,
    description: line.description,
    quantity: line.quantity,
    unitAmountCents: line.unitAmountCents,
    discountCents: line.discountCents,
    lineTotalCents: line.lineTotalCents,
    vatRatePct: line.vatRatePct,
    vatCents: line.vatCents,
    creditKind: creditKind ?? null,
    creditUnits: creditUnits != null ? creditUnits * line.quantity : null,
    sessionStartsAt: startsAt ?? null,
  }));
}

/** Payment snapshot, `paid_at` and `settled_via` of an invoice issued as `paid`. */
async function paidSettlement(tx: Tx, order: typeof orders.$inferSelect, input: IssueInvoiceInput, issuedAt: Date) {
  const paid = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), inArray(payments.status, [...PAID_PAYMENT_STATUSES])));
  if (input.paymentId && !paid.some((p) => p.id === input.paymentId)) {
    const [p] = await tx.select().from(payments).where(eq(payments.id, input.paymentId));
    if (!p || p.orderId !== order.id) throw new NotFoundError("finance.errors.payment_not_found");
    paid.push(p);
  }
  const snap = paymentSnapshot(paid, input.paymentId);
  const settling = paid.find((p) => p.id === snap.paymentId);
  return {
    ...snap,
    paidAt: input.paidAt ?? order.paidAt ?? settling?.paidAt ?? issuedAt,
    settledVia: input.settledVia ?? ("provider" as const),
  };
}
