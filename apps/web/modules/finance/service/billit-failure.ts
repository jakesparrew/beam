/**
 * Billit failure bookkeeping (finance spec 4.5 and rule 35, finance-P4). A failed push records
 * `billit_attempts + 1`, `billit_last_error` (scrubbed, no personal data), `billit_status =
 * 'failed'` and the first failure of the current streak in `billit_failed_since`, which stays
 * across attempts until a success clears it. The write runs outside the job's transaction (the
 * job context's `writeDurably`, or an autocommit statement on the database), so it survives the
 * rollback of the failing attempt; `billit.sync_pending` alerts from `billit_failed_since`.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { localHourKey } from "@beam/core/platform";
import { IntegrationError, scrubError } from "@beam/integrations/_shared";
import { isBillitAuthError } from "@beam/integrations/billit";
import { enqueueJob, writeDurably, type Ctx } from "@/lib/ctx";
import { findInvoice, updateInvoiceState } from "./invoice-state";

/** `billit_last_error`: status or code first, then the scrubbed message, at most 500 characters. */
export function billitErrorText(err: IntegrationError | Error): string {
  const head = err instanceof IntegrationError ? (err.statusCode ?? err.code ?? "error") : "error";
  return scrubError(`${head}: ${err.message}`).slice(0, 500);
}

/** Records a failed document push (push_invoice, push_credit_note). A synced document is left alone. */
export async function recordBillitFailure(db: DbOrTx, invoiceId: string, err: IntegrationError): Promise<void> {
  const doc = await findInvoice(db, invoiceId);
  if (!doc || doc.billitStatus === "synced") return;
  await updateInvoiceState(db as Tx, invoiceId, {
    billitStatus: "failed",
    billitAttempts: doc.billitAttempts + 1,
    billitLastError: billitErrorText(err),
    billitFailedSince: doc.billitFailedSince ?? new Date(),
  });
}

/** Records a failed payment registration (push_payment): `billit_payment_status = 'failed'`. */
export async function recordBillitPaymentFailure(db: DbOrTx, invoiceId: string, err: IntegrationError): Promise<void> {
  const doc = await findInvoice(db, invoiceId);
  if (!doc || doc.billitPaymentStatus === "synced") return;
  await updateInvoiceState(db as Tx, invoiceId, { billitPaymentStatus: "failed", billitLastError: billitErrorText(err) });
}

/**
 * A Slack alert enqueued on `db` directly (outside a failing transaction), with the key of
 * platform's `notifySlack` (`slack:<fingerprint>:<Brussels hour>`), so it is still one line per
 * fingerprint per hour.
 */
export async function enqueueAlertOn(db: DbOrTx, now: Date, input: { fingerprint: string; severity: "critical" | "high" | "normal"; text: string }): Promise<void> {
  await enqueueJob(db, { kind: "notify.slack", payload: input, key: `slack:${input.fingerprint}:${localHourKey(now)}` });
}

/**
 * Runs a Billit call sequence for one document. A Billit `IntegrationError` is recorded durably
 * (`recordBillitFailure` or `recordBillitPaymentFailure`), a rejected credential (401/403) also
 * raises the High alert `billit-auth`, and the error is rethrown so the job runner retries
 * (retryable) or marks the job dead (permanent).
 */
export async function withBillitFailure<T>(ctx: Ctx, invoiceId: string, mode: "document" | "payment", work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof IntegrationError && error.provider === "billit") {
      await writeDurably(ctx, (db) => (mode === "document" ? recordBillitFailure(db, invoiceId, error) : recordBillitPaymentFailure(db, invoiceId, error)));
      if (isBillitAuthError(error)) await raiseAuthAlert(ctx);
    }
    throw error;
  }
}

/** "Billit credentials rejected": one High alert per hour (fingerprint `billit-auth`), surviving the rollback. */
export function raiseAuthAlert(ctx: Ctx): Promise<void> {
  return writeDurably(ctx, (db) => enqueueAlertOn(db, ctx.now, { fingerprint: "billit-auth", severity: "high", text: "Billit credentials rejected (401/403): check BILLIT_API_KEY and BILLIT_PARTY_ID" }));
}
