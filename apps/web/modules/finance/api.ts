/**
 * finance's cross-module door (02-data-model section 6.6). Wave 0 stubs by platform-P7 with the
 * owner's final signatures: each throws `NotImplementedError('finance.<fn>')` until finance
 * implements it. Retention is not an api function: finance's `privacy.ts` exports `sweep`.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { BillingDetails, FinanceKpis, InvoiceSummary } from "@beam/core/finance";
import type { Ctx } from "@/lib/ctx";
import type { DigestSection } from "@/modules/platform/api";

export type { BillingDetails, FinanceKpis, InvoiceSummary } from "@beam/core/finance";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`finance.${fn}`));

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

export type CreditNoteLineInput = { orderLineId: string; quantity?: number; amountCents?: number };

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
export function issueInvoice(_tx: Tx, _ctx: Ctx, _input: IssueInvoiceInput): Promise<IssueInvoiceResult> {
  return notYet("issueInvoice");
}

/** Called by commerce's refund action in its transaction; also used by finance's own staff actions. */
export function issueCreditNote(_tx: Tx, _ctx: Ctx, _input: IssueCreditNoteInput): Promise<{ creditNoteId: string; number: string; totalCents: number }> {
  return notYet("issueCreditNote");
}

/** Called by commerce when a refund reaches `refunded`. Idempotent. */
export function markCreditNoteSettled(_tx: Tx, _ctx: Ctx, _input: { refundId: string; settledAt: Date }): Promise<void> {
  return notYet("markCreditNoteSettled");
}

/** Called by commerce checkout (company invoice box) and staff order screens. Upsert per order. */
export function setOrderBillingDetails(_tx: Tx, _ctx: Ctx, _input: { orderId: string; details: BillingDetails }): Promise<void> {
  return notYet("setOrderBillingDetails");
}

/** Latest invoice of kind `invoice` for the order (live or cancelled). */
export function getInvoiceForOrder(_db: DbOrTx, _orderId: string): Promise<InvoiceSummary | null> {
  return notYet("getInvoiceForOrder");
}

/** For the crm person page and the ops privacy export. */
export function listInvoicesForPerson(_db: DbOrTx, _personId: string): Promise<InvoiceSummary[]> {
  return notYet("listInvoicesForPerson");
}

/** For ops privacy.erase_external: the person's Billit party id, if any. */
export function getBillitCustomerRef(_db: DbOrTx, _personId: string): Promise<string | null> {
  return notYet("getBillitCustomerRef");
}

/** Enqueues billit.push_customer for the person's party (no-op without a party). */
export function resyncCustomer(_tx: Tx, _ctx: Ctx, _personId: string): Promise<void> {
  return notYet("resyncCustomer");
}

/** For ops.daily_digest. Ids and counts only. */
export function getFinanceDigest(_db: DbOrTx, _day: string): Promise<DigestSection> {
  return notYet("getFinanceDigest");
}

/** R4: KPIs for ops custom dashboards, weekly summary and NL questions. */
export function getFinanceKpis(_db: DbOrTx, _input: { from: string; to: string }): Promise<FinanceKpis> {
  return notYet("getFinanceKpis");
}
