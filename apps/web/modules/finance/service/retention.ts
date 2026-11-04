/**
 * finance's retention sweep handlers (finance rule 45, section 9, edge case 27, cross-module D34
 * and D37). ops' `privacy.retention_sweep` calls `sweep[key](tx, cutoff)` for each
 * `retention_policies` row with `cutoff = now - days`; each handler touches at most the row's
 * `batch_size` documents under `SET LOCAL beam.allow_rewrite = 'on'` and returns the count (ops
 * calls again while the count equals the batch size).
 *
 * `finance.invoices` reads its own policy row for the action (`anonymise` or `delete`) and the
 * days, and derives the run's `now` as `cutoff + days`. A fiscal year Y is swept once
 * `1 January (Y + 1) + days <= now`, and never before the legal floor of 3653 days
 * (`LEGAL_MIN_RETENTION_DAYS`): a policy edited below the floor is applied at the floor and the
 * documents it would otherwise have reached are logged as `skipped_legal_floor`.
 * - `anonymise` (the seeded action): `person_id` and `company_id` null, `customer_snapshot`
 *   `{ "anonymised": true }`, the PDF file deleted (`pdf_file_id` null); totals, lines and
 *   numbers stay.
 * - `delete`: documents and their PDFs are deleted, except a chain that a newer (kept) document
 *   still references through `reverses_invoice_id` or `replaces_invoice_id`, or a credit note a
 *   refund row still points at. `invoice_sequences` rows are never touched.
 * Both delete the `order_billing_details` of orders left without a personal document.
 */
import type { Tx } from "@beam/db";
import { LEGAL_MIN_RETENTION_DAYS, isBelowLegalFloor, retentionCutoffYear, brusselsDateOf } from "@beam/core/finance";
import { sql, type DbOrTx } from "@/lib/ctx";
import { logger } from "@/lib/logger";
import { rowsOf } from "@/lib/sensitive";

export const DEFAULT_SWEEP_BATCH = 1000;
const DAY_MS = 86_400_000;
const ANONYMISED = JSON.stringify({ anonymised: true });

type Policy = { action: "anonymise" | "delete" | "keep"; days: number | null; batchSize: number };

const allowRewrite = (tx: DbOrTx) => tx.execute(sql`set local beam.allow_rewrite = 'on'`);
const at = (d: Date): string => d.toISOString();
const uuidArray = (ids: readonly string[]) => sql`array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;

/** The `retention_policies` row of `key`, or the seeded defaults when ops has not seeded it. */
export async function readPolicy(tx: DbOrTx, key: string, fallback: Omit<Policy, "batchSize">): Promise<Policy> {
  const [row] = rowsOf<{ action: Policy["action"]; days: number | null; batch_size: number }>(
    await tx.execute(sql`select action, days, batch_size from retention_policies where key = ${key}`),
  );
  if (!row) return { ...fallback, batchSize: DEFAULT_SWEEP_BATCH };
  return { action: row.action, days: row.days === null ? null : Number(row.days), batchSize: Number(row.batch_size) || DEFAULT_SWEEP_BATCH };
}

/** The latest fiscal year the `finance.invoices` sweep may touch, and the policy's own year. */
export function sweepYears(cutoff: Date, days: number): { now: Date; lastYear: number; policyYear: number } {
  const now = new Date(cutoff.getTime() + days * DAY_MS);
  const lastYear = retentionCutoffYear(brusselsDateOf(now), days, "anonymise");
  const policyYear = Number(brusselsDateOf(cutoff).slice(0, 4)) - 1;
  return { now, lastYear, policyYear };
}

/** Deletes `files` rows (PDFs) that no document references any more. */
async function deleteFiles(tx: DbOrTx, fileIds: readonly string[]): Promise<void> {
  if (fileIds.length === 0) return;
  await tx.execute(sql`delete from files f where f.id = any(${uuidArray(fileIds)}) and not exists (select 1 from invoices i where i.pdf_file_id = f.id)`);
}

/** Deletes the billing details of `orderIds` whose orders keep no personal document. */
async function deleteBillingDetails(tx: DbOrTx, orderIds: readonly string[]): Promise<void> {
  if (orderIds.length === 0) return;
  await tx.execute(sql`delete from order_billing_details b where b.order_id = any(${uuidArray(orderIds)})
    and not exists (select 1 from invoices i where i.order_id = b.order_id and i.customer_snapshot <> ${ANONYMISED}::jsonb)`);
}

/** `finance.invoices` (rule 45): anonymise or delete the documents of fiscal years past the horizon. */
export async function sweepInvoices(tx: Tx, cutoff: Date): Promise<number> {
  const policy = await readPolicy(tx, "finance.invoices", { action: "anonymise", days: LEGAL_MIN_RETENTION_DAYS });
  if (policy.action === "keep" || policy.days === null) return 0;
  const { lastYear, policyYear } = sweepYears(cutoff, policy.days);
  if (isBelowLegalFloor(policy.days) && policyYear > lastYear) {
    const [row] = rowsOf<{ n: number }>(
      await tx.execute(sql`select count(*)::int as n from invoices where fiscal_year > ${lastYear} and fiscal_year <= ${policyYear}`),
    );
    logger.warn(
      { key: "finance.invoices", status: "skipped_legal_floor", count: Number(row?.n ?? 0), policyDays: policy.days, floorDays: LEGAL_MIN_RETENTION_DAYS },
      "finance retention: policy below the legal floor; documents inside the floor skipped",
    );
  }
  await allowRewrite(tx);
  return policy.action === "delete" ? deleteDocuments(tx, lastYear, policy.batchSize) : anonymiseDocuments(tx, lastYear, policy.batchSize);
}

async function anonymiseDocuments(tx: Tx, lastYear: number, batch: number): Promise<number> {
  const rows = rowsOf<{ id: string; order_id: string; pdf_file_id: string | null }>(
    await tx.execute(sql`select id, order_id, pdf_file_id from invoices
      where fiscal_year <= ${lastYear} and customer_snapshot <> ${ANONYMISED}::jsonb
      order by fiscal_year, issued_at limit ${batch} for update`),
  );
  if (rows.length === 0) return 0;
  await tx.execute(sql`update invoices set person_id = null, company_id = null, customer_snapshot = ${ANONYMISED}::jsonb,
      pdf_file_id = null, updated_at = now()
    where id = any(${uuidArray(rows.map((r) => r.id))})`);
  await deleteFiles(tx, rows.map((r) => r.pdf_file_id).filter((v): v is string => v !== null));
  await deleteBillingDetails(tx, [...new Set(rows.map((r) => r.order_id))]);
  return rows.length;
}

async function deleteDocuments(tx: Tx, lastYear: number, batch: number): Promise<number> {
  // Kept: every document of a younger fiscal year, every credit note a refund points at, and
  // (transitively) every document they reference. The rest of the old years is deleted, newest
  // first, so a batch never deletes a document whose referencing document stays behind.
  const doomed = rowsOf<{ id: string; order_id: string; pdf_file_id: string | null }>(
    await tx.execute(sql`with recursive kept(id) as (
        select s.id from (
          select id from invoices where fiscal_year > ${lastYear}
          union select credit_note_id as id from refunds where credit_note_id is not null
        ) s
        union select r.ref from kept k join invoices i on i.id = k.id
          cross join lateral (values (i.reverses_invoice_id), (i.replaces_invoice_id)) as r(ref) where r.ref is not null
      )
      select id, order_id, pdf_file_id from invoices
      where fiscal_year <= ${lastYear} and id not in (select id from kept where id is not null)
      order by issued_at desc, created_at desc, sequence_number desc limit ${batch}`),
  );
  if (doomed.length === 0) return 0;
  const ids = doomed.map((r) => r.id);
  await tx.execute(sql`delete from invoice_requests where invoice_id = any(${uuidArray(ids)}) or credit_note_id = any(${uuidArray(ids)}) or new_invoice_id = any(${uuidArray(ids)})`);
  await tx.execute(sql`delete from invoices where id = any(${uuidArray(ids)})`);
  await deleteFiles(tx, doomed.map((r) => r.pdf_file_id).filter((v): v is string => v !== null));
  await deleteBillingDetails(tx, [...new Set(doomed.map((r) => r.order_id))]);
  return doomed.length;
}

/** `finance.invoice_requests` (730 days, `delete`): decided or cancelled requests; pending ones stay. */
export async function sweepInvoiceRequests(tx: Tx, cutoff: Date): Promise<number> {
  const { batchSize } = await readPolicy(tx, "finance.invoice_requests", { action: "delete", days: 730 });
  const rows = rowsOf(
    await tx.execute(sql`delete from invoice_requests where id in (
      select id from invoice_requests where status <> 'requested' and coalesce(decided_at, updated_at) < ${at(cutoff)}::timestamptz
      limit ${batchSize}) returning id`),
  );
  return rows.length;
}

/** `finance.billit_reconcile_runs` (400 days, `delete`); no personal data. */
export async function sweepBillitReconcileRuns(tx: Tx, cutoff: Date): Promise<number> {
  const { batchSize } = await readPolicy(tx, "finance.billit_reconcile_runs", { action: "delete", days: 400 });
  const rows = rowsOf(
    await tx.execute(sql`delete from billit_reconcile_runs where id in (
      select id from billit_reconcile_runs where started_at < ${at(cutoff)}::timestamptz limit ${batchSize}) returning id`),
  );
  return rows.length;
}

/** `finance.finance_exports` (90 days, `delete`); a CSV file still present goes with its row. */
export async function sweepFinanceExports(tx: Tx, cutoff: Date): Promise<number> {
  const { batchSize } = await readPolicy(tx, "finance.finance_exports", { action: "delete", days: 90 });
  const rows = rowsOf<{ id: string; file_id: string | null }>(
    await tx.execute(sql`delete from finance_exports where id in (
      select id from finance_exports where created_at < ${at(cutoff)}::timestamptz limit ${batchSize}) returning id, file_id`),
  );
  const fileIds = rows.map((r) => r.file_id).filter((v): v is string => v !== null);
  if (fileIds.length) await tx.execute(sql`delete from files where id = any(${uuidArray(fileIds)})`);
  return rows.length;
}

/** The `sweep` map of finance's privacy registration, keyed by retention policy key (D37). */
export const sweep = {
  "finance.invoices": sweepInvoices,
  "finance.invoice_requests": sweepInvoiceRequests,
  "finance.billit_reconcile_runs": sweepBillitReconcileRuns,
  "finance.finance_exports": sweepFinanceExports,
} satisfies Record<string, (tx: Tx, cutoff: Date) => Promise<number>>;
