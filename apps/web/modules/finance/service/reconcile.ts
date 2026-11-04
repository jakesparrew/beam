/**
 * The daily Billit reconcile (finance spec rules 13, 28, 35 and section 6; finance-P4). Compares
 * the documents issued in a window with Billit and checks BEAM's own numbering and PDFs. Issues
 * carry ids, numbers and amounts only (no personal data):
 * - `missing_in_billit`: a document Billit does not know (no `billit_id` and not found by
 *   reference, or its `billit_id` answers 404), older than one hour;
 * - `unknown_in_billit`: a Billit order (modified in the window) whose number BEAM never issued;
 * - `amount_mismatch`: Billit's `TotalIncl` differs from ours by more than 1 cent;
 * - `paid_mismatch`: paid in BEAM but not in Billit, paid in Billit but open in BEAM, or a partial
 *   payment in Billit (rule 28, edge case 11);
 * - `sequence_gap`: for the current and previous fiscal year, a (year, kind) whose documents are
 *   not exactly `1..last_number`;
 * - `stale_pending`: not synced 24 hours after issue;
 * - `pdf_missing`: not rendered one hour after issue, or the rendered file is gone.
 * `upsertReconcileRun` stores one run per Brussels day (a re-run on the same day overwrites it).
 *
 * The job checks the window in chunks (`reconcileDocuments`, keyset on `(issued_at, id)`), each
 * chunk merged into the day's run by `appendReconcileRun`; the last chunk adds the window-wide
 * checks (`reconcileTail`: unknown orders and sequence gaps). `reconcile` runs all of it at once.
 */
import type { DbOrTx } from "@beam/db";
import { billitReconcileRuns, files, invoiceSequences, invoices } from "@beam/db/schema";
import { formatNumber, type InvoiceRecord, type ReconcileIssue } from "@beam/core/finance";
import { IntegrationError } from "@beam/integrations/_shared";
import type { BillitApi, BillitOrder } from "@beam/integrations/billit";
import { and, asc, eq, gte, inArray, lte, sql } from "@/lib/ctx";

const HOUR = 3_600_000;
const MAX_LIST_PAGES = 200;
/** Documents per `billit.reconcile` chunk. */
export const RECONCILE_CHUNK = 200;

export type ReconcileWindow = { from: string; to: string; now?: Date };

export type ReconcileChunkOptions = {
  /** Continue after this document (keyset on `(issued_at, id)`). */
  afterId?: string;
  limit?: number;
  /** Stop the chunk early (not done) once this instant passes. */
  deadline?: number;
  signal?: AbortSignal;
};

export type ReconcileChunk = {
  issues: ReconcileIssue[];
  checked: number;
  /** The last document checked, or the `afterId` passed in when none was. */
  lastId: string | null;
  /** True when every document of the window after `afterId` has been checked. */
  done: boolean;
};

async function amountDue(tx: DbOrTx, invoiceId: string, totalCents: number): Promise<number> {
  const [row] = await tx
    .select({ credited: sql<string>`coalesce(-sum(${invoices.totalCents}), 0)` })
    .from(invoices)
    .where(and(eq(invoices.kind, "credit_note"), eq(invoices.reversesInvoiceId, invoiceId)));
  return totalCents - Number(row?.credited ?? 0);
}

function paidCentsOf(order: BillitOrder): number {
  const total = Math.round(order.TotalIncl * 100);
  if (order.ToPay !== undefined) return total - Math.round(order.ToPay * 100);
  return order.Paid ? total : 0;
}

/** Billit's view of one BEAM document: the order, or null when Billit does not know it. */
async function billitOrderOf(api: BillitApi, doc: InvoiceRecord): Promise<BillitOrder | null> {
  let id = doc.billitId;
  if (!id) id = (await api.findOrderByReference(doc.number))?.orderId ?? null;
  if (!id) return null;
  try {
    return await api.getOrder(id);
  } catch (error) {
    if (error instanceof IntegrationError && error.statusCode === 404) return null;
    throw error;
  }
}

/** Sequence check of rule 13 for every (year, kind) of `years`. */
export async function sequenceGaps(tx: DbOrTx, years: readonly number[]): Promise<ReconcileIssue[]> {
  const issues: ReconcileIssue[] = [];
  const seqs = await tx.select().from(invoiceSequences).where(inArray(invoiceSequences.year, [...years]));
  for (const s of seqs.sort((a, b) => a.year - b.year || a.kind.localeCompare(b.kind))) {
    const [row] = await tx
      .select({ n: sql<string>`count(*)`, min: sql<number | null>`min(${invoices.sequenceNumber})`, max: sql<number | null>`max(${invoices.sequenceNumber})` })
      .from(invoices)
      .where(and(eq(invoices.kind, s.kind), eq(invoices.fiscalYear, s.year)));
    const count = Number(row?.n ?? 0);
    const ok = count === s.lastNumber && (count === 0 || (Number(row?.min) === 1 && Number(row?.max) === s.lastNumber));
    if (!ok) {
      issues.push({
        type: "sequence_gap",
        ...(s.lastNumber > 0 ? { number: formatNumber(s.kind, s.year, s.lastNumber) } : {}),
        detail: `${s.kind} ${s.year}: last_number ${s.lastNumber}, ${count} documents (numbers ${row?.min ?? "-"}..${row?.max ?? "-"})`,
      });
    }
  }
  return issues;
}

/**
 * Checks the documents issued between `from` and `to` (Brussels dates, inclusive) against Billit
 * and BEAM's own records; returns the issues. Billit errors other than 404 propagate (the job
 * records the run as `failed`).
 */
export async function reconcile(tx: DbOrTx, api: BillitApi, window: ReconcileWindow): Promise<ReconcileIssue[]> {
  const issues: ReconcileIssue[] = [];
  let afterId: string | undefined;
  for (;;) {
    const chunk = await reconcileDocuments(tx, api, window, afterId ? { afterId } : {});
    issues.push(...chunk.issues);
    if (chunk.done || !chunk.lastId) break;
    afterId = chunk.lastId;
  }
  issues.push(...(await reconcileTail(tx, api, window)));
  return issues;
}

/**
 * One chunk of the per-document checks: at most `limit` documents of the window after
 * `afterId`, in `(issued_at, id)` order, stopping early (not done) past `deadline`.
 */
export async function reconcileDocuments(tx: DbOrTx, api: BillitApi, window: ReconcileWindow, opts: ReconcileChunkOptions = {}): Promise<ReconcileChunk> {
  const now = window.now ?? new Date();
  const limit = opts.limit ?? RECONCILE_CHUNK;
  const issues: ReconcileIssue[] = [];
  const inWindow = and(gte(invoices.issuedOn, window.from), lte(invoices.issuedOn, window.to));
  const after = opts.afterId
    ? sql`(${invoices.issuedAt}, ${invoices.id}) > (select a.issued_at, a.id from invoices a where a.id = ${opts.afterId}::uuid)`
    : undefined;
  const docs = (await tx
    .select()
    .from(invoices)
    .where(after ? and(inWindow, after) : inWindow)
    .orderBy(asc(invoices.issuedAt), asc(invoices.id))
    .limit(limit)) as InvoiceRecord[];

  const fileIds = docs.map((d) => d.pdfFileId).filter((v): v is string => !!v);
  const existing = new Set(fileIds.length ? (await tx.select({ id: files.id }).from(files).where(inArray(files.id, fileIds))).map((f) => f.id) : []);

  let checked = 0;
  let lastId: string | null = opts.afterId ?? null;
  let stopped = false;
  for (const doc of docs) {
    opts.signal?.throwIfAborted();
    if (opts.deadline !== undefined && checked > 0 && Date.now() > opts.deadline) {
      stopped = true;
      break;
    }
    checked++;
    lastId = doc.id;
    const ref = { invoice_id: doc.id, number: doc.number, ...(doc.billitId ? { billit_id: doc.billitId } : {}) };
    const age = now.getTime() - doc.issuedAt.getTime();

    if (doc.pdfStatus === "rendered" ? !doc.pdfFileId || !existing.has(doc.pdfFileId) : age > HOUR) {
      issues.push({ ...ref, type: "pdf_missing", detail: `pdf_status ${doc.pdfStatus}` });
    }
    if (doc.billitStatus !== "synced" && age > 24 * HOUR) {
      issues.push({ ...ref, type: "stale_pending", detail: `billit_status ${doc.billitStatus} after ${Math.floor(age / HOUR)} h, ${doc.billitAttempts} attempt(s)` });
    }

    const order = await billitOrderOf(api, doc);
    if (!order) {
      if (age > HOUR) issues.push({ ...ref, type: "missing_in_billit", detail: `billit_status ${doc.billitStatus}` });
      continue;
    }
    const withId = { ...ref, billit_id: order.OrderID };
    const ours = Math.abs(doc.totalCents);
    const theirs = Math.round(order.TotalIncl * 100);
    if (Math.abs(ours - theirs) > 1) issues.push({ ...withId, type: "amount_mismatch", detail: `BEAM ${ours} cents, Billit ${theirs} cents` });

    if (doc.kind === "invoice" && doc.status !== "cancelled") {
      const paid = paidCentsOf(order);
      if (doc.status === "paid" && !order.Paid && doc.settledVia !== "billit") {
        issues.push({ ...withId, type: "paid_mismatch", detail: "paid in BEAM, not paid in Billit" });
      } else if (doc.status === "open") {
        const due = await amountDue(tx, doc.id, doc.totalCents);
        if (order.Paid || paid >= due) issues.push({ ...withId, type: "paid_mismatch", detail: `paid in Billit (${paid} cents), open in BEAM` });
        else if (paid > 0) issues.push({ ...withId, type: "paid_mismatch", detail: `partial payment in Billit: ${paid} of ${due} cents` });
      } else if (doc.status === "paid" && paid > Math.abs(doc.totalCents) + 1) {
        issues.push({ ...withId, type: "paid_mismatch", detail: `overpaid in Billit: ${paid} of ${ours} cents` });
      }
    }
  }
  return { issues, checked, lastId, done: !stopped && docs.length < limit };
}

/** The window-wide checks of the last chunk: Billit orders BEAM never issued, and sequence gaps. */
export async function reconcileTail(tx: DbOrTx, api: BillitApi, window: ReconcileWindow, signal?: AbortSignal): Promise<ReconcileIssue[]> {
  const issues: ReconcileIssue[] = [];
  // Orders in Billit that BEAM never issued (edge case 25).
  const since = new Date(`${window.from}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 1);
  const seen: BillitOrder[] = [];
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    signal?.throwIfAborted();
    const { items, hasMore } = await api.listOrdersSince(since, page);
    seen.push(...items);
    if (!hasMore) break;
  }
  const numbers = [...new Set(seen.map((o) => o.OrderNumber))];
  const known = new Set(numbers.length ? (await tx.select({ number: invoices.number }).from(invoices).where(inArray(invoices.number, numbers))).map((r) => r.number) : []);
  for (const o of seen) {
    if (!known.has(o.OrderNumber)) issues.push({ billit_id: o.OrderID, number: o.OrderNumber, type: "unknown_in_billit", detail: `${o.OrderType} not issued by BEAM` });
  }

  const year = Number(window.to.slice(0, 4));
  issues.push(...(await sequenceGaps(tx, [year - 1, year])));
  return issues;
}

/** Stores the day's run (`billit_reconcile_runs`, unique `run_on`): a re-run the same day overwrites it. */
export async function upsertReconcileRun(
  tx: DbOrTx,
  input: { runOn: string; startedAt: Date; finishedAt: Date | null; status: "ok" | "issues" | "failed"; checkedCount: number; issues: ReconcileIssue[] },
): Promise<string> {
  const values = {
    runOn: input.runOn,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.status,
    checkedCount: input.checkedCount,
    issuesCount: input.issues.length,
    issues: input.issues,
  };
  const [row] = await tx
    .insert(billitReconcileRuns)
    .values(values)
    .onConflictDoUpdate({ target: billitReconcileRuns.runOn, set: { ...values, updatedAt: sql`now()` } })
    .returning({ id: billitReconcileRuns.id });
  return row!.id;
}

export type ReconcileRunTotals = { id: string; status: "ok" | "issues" | "failed"; checkedCount: number; issues: ReconcileIssue[] };

/**
 * Merges one chunk into the day's run: appends its issues, adds to `checked_count` and sets the
 * status from all issues so far (`finished_at` stays null until the last chunk passes it).
 * Creates the row when a continuation finds none.
 */
export async function appendReconcileRun(
  tx: DbOrTx,
  input: { runOn: string; startedAt: Date; finishedAt: Date | null; checked: number; issues: ReconcileIssue[] },
): Promise<ReconcileRunTotals> {
  const t = billitReconcileRuns;
  const [row] = await tx
    .insert(t)
    .values({
      runOn: input.runOn,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      status: input.issues.length ? "issues" : "ok",
      checkedCount: input.checked,
      issuesCount: input.issues.length,
      issues: input.issues,
    })
    .onConflictDoUpdate({
      target: t.runOn,
      set: {
        issues: sql`${t.issues} || excluded.issues`,
        issuesCount: sql`${t.issuesCount} + excluded.issues_count`,
        checkedCount: sql`${t.checkedCount} + excluded.checked_count`,
        status: sql`(case when ${t.issuesCount} + excluded.issues_count > 0 then 'issues' else 'ok' end)::billit_reconcile_runs_status`,
        finishedAt: sql`excluded.finished_at`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: t.id, status: t.status, checkedCount: t.checkedCount, issues: t.issues });
  return row!;
}

/** A continuation chunk failed: the day's run reads `failed` (its issues so far are kept). */
export async function failReconcileRun(tx: DbOrTx, runOn: string, finishedAt: Date): Promise<void> {
  await tx.update(billitReconcileRuns).set({ status: "failed", finishedAt, updatedAt: sql`now()` }).where(eq(billitReconcileRuns.runOn, runOn));
}

/** How many documents a window checks (the run's `checked_count`). */
export async function countDocuments(tx: DbOrTx, window: ReconcileWindow): Promise<number> {
  const [row] = await tx
    .select({ n: sql<string>`count(*)` })
    .from(invoices)
    .where(and(gte(invoices.issuedOn, window.from), lte(invoices.issuedOn, window.to)));
  return Number(row?.n ?? 0);
}
