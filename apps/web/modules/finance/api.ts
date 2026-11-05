/**
 * finance's cross-module door (finance spec sections 4.1 and 10, 02-data-model section 6.6).
 * finance-P1 declared every function with its final signature; finance-P2 implements issuing,
 * settlement, billing details and the read functions; finance-P5 implements `getFinanceDigest`
 * (`service/digest.ts`); finance-P10 implements `getFinanceKpis` (`service/kpis.ts`, the
 * dashboard's figures for ops' R4 custom dashboards, weekly summary and NL questions; its labels
 * are `FINANCE_KPI_DEFINITIONS`, and the views ops may expose to AI are `FINANCE_AI_VIEWS` in
 * `ai-views.ts`). Retention is
 * not an api function: finance's `privacy.ts` exports `sweep`. The pure helpers other modules use
 * (`BillingDetailsInput`, `computeLineVat`, `normaliseVatNumber`) come from `@beam/core/finance`.
 *
 * Customer actors only reach their own orders and documents (anything else is `not_found`);
 * staff, system, job and webhook actors pass, the calling action checks their permission.
 */
import { createHash } from "node:crypto";
import type { DbOrTx, Tx } from "@beam/db";
import { billitParties, invoices, persons } from "@beam/db/schema";
import type { BillingDetails, CreditNoteLineInput, InvoiceSummary } from "@beam/core/finance";
import { and, desc, eq, type Ctx } from "@/lib/ctx";
import type { DigestSection } from "@/modules/platform/api";
import { setOrderBillingDetails as setBillingDetails } from "./service/billing-details";
import { getFinanceDigest as getFinanceDigestService } from "./service/digest";
import { getFinanceKpis as getFinanceKpisService } from "./service/kpis";
import { assertCustomerOwns, enqueueFinanceJob } from "./service/invoice-state";
import { issueCreditNote as issueCreditNoteService } from "./service/issue-credit-note";
import { issueInvoice as issueInvoiceService } from "./service/issue-invoice";
import { markCreditNoteSettled as markCreditNoteSettledService } from "./service/settle";
// Relative until `@beam/core/finance` re-exports `./kpis` (index.ts is not finance-P10's file).
import type { FinanceKpis } from "../../../../packages/core/src/finance/kpis";

export type { BillingDetails, CreditNoteLineInput, InvoiceSummary } from "@beam/core/finance";
export type { FinanceKpiDefinition, FinanceKpiKey, FinanceKpis, FinanceKpiValues } from "../../../../packages/core/src/finance/kpis";
export { FINANCE_KPI_DEFINITIONS, FINANCE_KPI_KEYS } from "../../../../packages/core/src/finance/kpis";
export { FINANCE_AI_VIEWS, type FinanceAiView } from "./ai-views";

export type IssueInvoiceInput = {
  orderId: string;
  /** Default `paid`; `open` only for bank_transfer orders (rule 2). */
  status?: "paid" | "open";
  /** YYYY-MM-DD; commerce passes the transfer payment's `expires_at` date. */
  dueOn?: string;
  paymentId?: string;
  paidAt?: Date;
  settledVia?: "provider" | "billit" | "manual";
};

export type IssueInvoiceResult = { status: "issued" | "existing"; invoiceId: string; number: string } | { status: "skipped"; reason: "zero_total" };

export type IssueCreditNoteInput = {
  invoiceId?: string;
  orderId?: string;
  refundId?: string;
  reason: string;
  /** Omitted = the full remaining amount. */
  lines?: CreditNoteLineInput[];
  noRefund?: boolean;
};

/** Called by commerce in the payments.sync paid transaction and at bank-transfer order placement. */
export function issueInvoice(tx: Tx, ctx: Ctx, input: IssueInvoiceInput): Promise<IssueInvoiceResult> {
  return issueInvoiceService(tx, ctx, input);
}

/** Called by commerce's refund action in its transaction; also used by finance's own staff actions. */
export function issueCreditNote(tx: Tx, ctx: Ctx, input: IssueCreditNoteInput): Promise<{ creditNoteId: string; number: string; totalCents: number }> {
  return issueCreditNoteService(tx, ctx, input);
}

/** Called by commerce when a refund reaches `refunded`. Idempotent. */
export function markCreditNoteSettled(tx: Tx, ctx: Ctx, input: { refundId: string; settledAt: Date }): Promise<void> {
  return markCreditNoteSettledService(tx, ctx, input);
}

/** Called by commerce checkout (company invoice box) and staff order screens. Upsert per order. */
export function setOrderBillingDetails(tx: Tx, ctx: Ctx, input: { orderId: string; details: BillingDetails }): Promise<void> {
  return setBillingDetails(tx, ctx, input);
}

const summaryColumns = {
  id: invoices.id,
  kind: invoices.kind,
  number: invoices.number,
  issuedOn: invoices.issuedOn,
  status: invoices.status,
  totalCents: invoices.totalCents,
  isCompany: invoices.isCompany,
  pdfStatus: invoices.pdfStatus,
  pdfFileId: invoices.pdfFileId,
};

type SummaryRow = { [K in keyof typeof summaryColumns]: (typeof invoices.$inferSelect)[K] };

function toSummary(r: SummaryRow): InvoiceSummary {
  return {
    id: r.id,
    kind: r.kind,
    number: r.number,
    issuedOn: r.issuedOn,
    status: r.status,
    totalCents: r.totalCents,
    isCompany: r.isCompany,
    pdfReady: r.pdfStatus === "rendered" && r.pdfFileId != null,
  };
}

/** Latest invoice of kind `invoice` for the order (live or cancelled). */
export async function getInvoiceForOrder(db: DbOrTx, orderId: string): Promise<InvoiceSummary | null> {
  const [row] = await db
    .select(summaryColumns)
    .from(invoices)
    .where(and(eq(invoices.orderId, orderId), eq(invoices.kind, "invoice")))
    .orderBy(desc(invoices.issuedAt), desc(invoices.sequenceNumber))
    .limit(1);
  return row ? toSummary(row) : null;
}

/** For the crm person page and the ops privacy export: invoices and credit notes, newest first. */
export async function listInvoicesForPerson(db: DbOrTx, personId: string): Promise<InvoiceSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(invoices)
    .where(eq(invoices.personId, personId))
    .orderBy(desc(invoices.issuedAt), desc(invoices.number));
  return rows.map(toSummary);
}

/** For ops privacy.erase_external: the person's Billit party id, if any. */
export async function getBillitCustomerRef(db: DbOrTx, personId: string): Promise<string | null> {
  const [row] = await db
    .select({ billitPartyId: billitParties.billitPartyId })
    .from(billitParties)
    .where(eq(billitParties.personId, personId))
    .orderBy(desc(billitParties.updatedAt))
    .limit(1);
  return row?.billitPartyId ?? null;
}

/**
 * Enqueues billit.push_customer for the person's party (no-op without a party). The key carries
 * the first 8 hex digits of a hash of the person's billing fields, so an unchanged person never
 * queues a second push and a changed one always does. The handler lands in finance-P4.
 */
export async function resyncCustomer(tx: Tx, ctx: Ctx, personId: string): Promise<void> {
  assertCustomerOwns(ctx, personId);
  const parties = await tx
    .select({ partyKey: billitParties.partyKey, isAnonymised: billitParties.isAnonymised })
    .from(billitParties)
    .where(eq(billitParties.personId, personId));
  if (parties.length === 0) return;
  const [person] = await tx
    .select({
      firstName: persons.firstName,
      lastName: persons.lastName,
      email: persons.email,
      phone: persons.phone,
      address: persons.address,
      locale: persons.locale,
    })
    .from(persons)
    .where(eq(persons.id, personId));
  if (!person) return;
  const hash8 = createHash("sha256").update(JSON.stringify(person)).digest("hex").slice(0, 8);
  for (const party of parties) {
    if (party.isAnonymised) continue;
    await enqueueFinanceJob(ctx, {
      kind: "billit.push_customer",
      payload: { partyKey: party.partyKey },
      key: `billit:customer:${party.partyKey}:${hash8}`,
    });
  }
}

/** For ops.daily_digest: Billit failed and failing over the alert time, PDF failures, overdue open invoices, last reconcile, nl-BE fallbacks. Ids and counts only. */
export function getFinanceDigest(db: DbOrTx, day: string): Promise<DigestSection> {
  return getFinanceDigestService(db, day);
}

/**
 * R4: KPIs for ops custom dashboards, weekly summary and NL questions: the finance dashboard's
 * figures for the Brussels days `from..to` and the equal-length period before (`previous`).
 * The caller checks `reports.finance`. Throws a `RangeError` for an invalid range.
 */
export function getFinanceKpis(db: DbOrTx, input: { from: string; to: string }): Promise<FinanceKpis> {
  return getFinanceKpisService(db, input);
}
