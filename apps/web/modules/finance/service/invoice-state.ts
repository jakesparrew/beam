/**
 * The one writer of issued documents (finance spec 2.1 and 2.2, finance-P2). After insert an
 * invoice or credit note changes only through `updateInvoiceState()`, which takes the typed
 * `InvoiceMutableFields` patch, applies the transition table of 2.1 (`nextInvoiceStatus`,
 * `InvalidTransitionError` -> `conflict`) and the column rules of 2.2 (`assertMutableUpdate`,
 * `InvoiceImmutableError` -> `conflict`) before the database trigger `invoices_guard_immutable()`
 * checks the same again. A patch that changes nothing is a no-op (idempotent jobs).
 *
 * Also the small shared helpers of the issuing service: loading a document as an
 * `InvoiceRecord`, the `issued_by` actor, the customer-actor guard and the finance job enqueue.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { invoices } from "@beam/db/schema";
import {
  assertMutableUpdate,
  nextInvoiceStatus,
  type InvoiceBillitPaymentStatus,
  type InvoiceBillitStatus,
  type InvoicePdfStatus,
  type InvoicePeppolStatus,
  type InvoiceRecord,
  type InvoiceSettledVia,
  type InvoiceStatus,
  type IssuedBy,
  type SellerSnapshot,
} from "@beam/core/finance";
import { actorJson, eq, loadJobRegistry, NotFoundError, sql, type Ctx, type EnqueueInput } from "@/lib/ctx";
import { logger } from "@/lib/logger";

/** The columns a normal update may touch (section 2.2); every other column is frozen after issue. */
export type InvoiceMutableFields = {
  status?: InvoiceStatus;
  paidAt?: Date | null;
  settledVia?: InvoiceSettledVia | null;
  pdfFileId?: string;
  pdfStatus?: InvoicePdfStatus;
  emailedAt?: Date | null;
  billitId?: string | null;
  billitStatus?: InvoiceBillitStatus;
  billitSyncedAt?: Date | null;
  billitAttempts?: number;
  billitLastError?: string | null;
  billitFailedSince?: Date | null;
  billitPaymentStatus?: InvoiceBillitPaymentStatus;
  peppolStatus?: InvoicePeppolStatus;
  /** Set once, from null, when an `open` invoice is settled. */
  paymentId?: string;
  paymentProvider?: string;
  paymentMethod?: string;
  paymentTransactionRef?: string;
  /** Only while no PDF was rendered and the document is not in Billit (edge case 16). */
  sellerSnapshot?: SellerSnapshot;
};

const MUTABLE_KEYS = [
  "status",
  "paidAt",
  "settledVia",
  "pdfFileId",
  "pdfStatus",
  "emailedAt",
  "billitId",
  "billitStatus",
  "billitSyncedAt",
  "billitAttempts",
  "billitLastError",
  "billitFailedSince",
  "billitPaymentStatus",
  "peppolStatus",
  "paymentId",
  "paymentProvider",
  "paymentMethod",
  "paymentTransactionRef",
  "sellerSnapshot",
] as const satisfies readonly (keyof InvoiceMutableFields)[];

/** One document as an `InvoiceRecord`, optionally locked `for update`; `null` when it does not exist. */
export async function findInvoice(tx: DbOrTx, id: string, opts: { forUpdate?: boolean } = {}): Promise<InvoiceRecord | null> {
  const q = tx.select().from(invoices).where(eq(invoices.id, id));
  const rows = opts.forUpdate ? await q.for("update") : await q;
  return (rows[0]) ?? null;
}

/** Like `findInvoice`, but a missing document is `not_found`. */
export async function loadInvoice(tx: DbOrTx, id: string, opts: { forUpdate?: boolean } = {}): Promise<InvoiceRecord> {
  const row = await findInvoice(tx, id, opts);
  if (!row) throw new NotFoundError("finance.errors.invoice_not_found");
  return row;
}

/**
 * Applies `patch` to document `id` under a row lock. Throws `InvalidTransitionError` for a status
 * change outside the table of 2.1 and `InvoiceImmutableError` for a column 2.2 does not allow;
 * both carry `code = 'conflict'`. Unknown keys are refused (the type is the contract).
 */
export async function updateInvoiceState(tx: Tx, id: string, patch: InvoiceMutableFields): Promise<void> {
  for (const key of Object.keys(patch)) {
    if (!(MUTABLE_KEYS as readonly string[]).includes(key)) throw new TypeError(`updateInvoiceState: ${key} is not a mutable invoice field`);
  }
  const current = await loadInvoice(tx, id, { forUpdate: true });
  if (patch.status !== undefined) nextInvoiceStatus(current.kind, current.status, patch.status);
  assertMutableUpdate(patch, current, "normal");

  const changes: Record<string, unknown> = {};
  const cur = current as unknown as Record<string, unknown>;
  for (const key of MUTABLE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!sameValue(value, cur[key])) changes[key] = value;
  }
  if (Object.keys(changes).length === 0) return;
  await tx
    .update(invoices)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(eq(invoices.id, id));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : a == null ? null : new Date(a as string).getTime();
    const tb = b instanceof Date ? b.getTime() : b == null ? null : new Date(b as string).getTime();
    return ta === tb;
  }
  if (a && typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return (a ?? null) === (b ?? null);
}

/** `invoices.issued_by` for the context's actor. */
export function issuedByOf(ctx: Ctx): IssuedBy {
  const a = actorJson(ctx.actor);
  return { kind: a.kind, id: a.id ?? null };
}

/**
 * Customer actors only reach their own documents and orders (spec 4.2, rule 40): anything else
 * is `not_found`, never `forbidden`, so ids cannot be probed. Staff, system, job and webhook
 * actors pass; the calling action checks their permission.
 */
export function assertCustomerOwns(ctx: Ctx, personId: string | null | undefined): void {
  if (ctx.actor.kind === "customer" && (!personId || personId !== ctx.actor.personId)) {
    throw new NotFoundError("finance.errors.not_found");
  }
  if (ctx.actor.kind === "public") throw new NotFoundError("finance.errors.not_found");
}

/**
 * Enqueues a finance job in the context's transaction. The handlers of `finance.render_pdf`
 * (finance-P3), `billit.push_payment` and `billit.push_customer` (finance-P4) land in later
 * packages; until a kind is registered the enqueue is skipped with a warning instead of failing
 * the caller's (commerce's paid) transaction. Documents keep `pdf_status = 'pending'` and
 * `billit_status = 'pending'`, which the later packages' re-render and `billit.sync_pending`
 * pick up (rule 34).
 */
export async function enqueueFinanceJob(
  ctx: Ctx,
  input: Omit<EnqueueInput, "kind"> & { kind: string },
): Promise<{ id: string; inserted: boolean } | null> {
  const registry = await loadJobRegistry();
  if (!registry[input.kind]) {
    logger.warn({ kind: input.kind, key: input.key }, "finance job kind not registered yet; enqueue skipped");
    return null;
  }
  return ctx.enqueue({ ...input, kind: input.kind as EnqueueInput["kind"] });
}

/** The subject of a document's activity events: the person, else the company, else none (rule 14a). */
export function eventSubject(doc: { personId: string | null; companyId: string | null }): { personId: string } | { companyId: string } | null {
  if (doc.personId) return { personId: doc.personId };
  if (doc.companyId) return { companyId: doc.companyId };
  return null;
}
