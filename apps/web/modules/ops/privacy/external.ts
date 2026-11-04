/**
 * `privacy.erase_external` (ops rules 62-63, cross-module decision 35): the three providers ops
 * propagates an erasure to, while the address is still known, before any local step.
 *
 * - `billit`: finance's `getBillitCustomerRef(db, personId)`, then `BillitApi.anonymiseCustomer`;
 *   no reference is `not_found` without a call.
 * - `mandates`: commerce's `revokeMandatesForPerson(tx, ctx, personId)` (commerce enqueues its own
 *   provider revocations); `done` when the call returned.
 * - `resend`: email's `ResendClient.deleteContact(email)`; a 404 (`deleted: false`) is `not_found`.
 *
 * A call still failing on its last attempt records `failed` and `needs_manual_followup`, and the
 * local erasure continues (external failures never fail the request). Once all three providers
 * are recorded for this attempt, the first module step is enqueued.
 */
import type { Tx } from "@beam/db";
import { FIRST_ERASE_MODULE, type EraseExternalProvider, type PrivacyExternalOutcome } from "@beam/core/ops";
import { isPermanentFailure } from "@beam/integrations/_shared";
import { eq, sql } from "@/lib/ctx";
import { privacyRequests } from "@beam/db/schema";
import type { JobCtx } from "@/lib/job-runner";
import { reportError } from "@/lib/logger";
import { rowsOf } from "@/lib/sensitive";
import { revokeMandatesForPerson } from "@/modules/commerce/api";
import { getBillitCustomerRef } from "@/modules/finance/api";
import { allExternalRecorded, lockRequest, stepKey } from "./orchestrator";
import { reportOf, setExternal } from "./report";

/** `maxAttempts` of `privacy.erase_external` in `../jobs.ts` (the defineJob default). */
export const EXTERNAL_MAX_ATTEMPTS = 6;

async function personEmail(tx: Tx, personId: string): Promise<string | null> {
  const rows = rowsOf<{ email: string | null }>(await tx.execute(sql`select email from persons where id = ${personId}::uuid`));
  return rows[0]?.email ?? null;
}

/** One provider call; throws when the provider fails (the job retries). */
export async function callProvider(ctx: JobCtx, provider: EraseExternalProvider, personId: string): Promise<PrivacyExternalOutcome> {
  switch (provider) {
    case "billit": {
      const partyId = await getBillitCustomerRef(ctx.tx, personId);
      if (!partyId) return "not_found";
      await ctx.integrations.billit.anonymiseCustomer(partyId);
      return "done";
    }
    case "mandates": {
      // A savepoint keeps the job transaction usable when commerce's writes fail.
      await ctx.tx.transaction(async (sp) => {
        await revokeMandatesForPerson(sp, ctx, personId);
      });
      return "done";
    }
    case "resend": {
      const email = await personEmail(ctx.tx, personId);
      if (!email) return "not_found";
      const { deleted } = await ctx.integrations.resend.deleteContact(email);
      return deleted ? "done" : "not_found";
    }
  }
}

export type ExternalResult = { skipped?: string; provider?: EraseExternalProvider; outcome?: PrivacyExternalOutcome; nextEnqueued?: boolean };

/** The job body: skip unless running, call once per attempt, record, then maybe start the steps. */
export async function eraseExternal(ctx: JobCtx, input: { requestId: string; provider: EraseExternalProvider }): Promise<ExternalResult> {
  const row = await lockRequest(ctx.tx, input.requestId);
  if (!row || row.kind !== "erase") return { skipped: "missing" };
  if (row.status !== "running") return { skipped: row.status };
  const before = reportOf(row.report);
  const recorded = before.external.find((e) => e.provider === input.provider);
  let outcome: PrivacyExternalOutcome;
  if (recorded) {
    outcome = recorded.outcome;
  } else {
    try {
      outcome = await callProvider(ctx, input.provider, row.personId);
    } catch (error) {
      // A 404 means the provider no longer knows the person; a permanent error is not retried.
      if ((error as { statusCode?: unknown } | null)?.statusCode === 404) outcome = "not_found";
      else if (!isPermanentFailure(error) && ctx.job.attempt < EXTERNAL_MAX_ATTEMPTS) throw error;
      else {
        reportError(error, { tags: { job: "privacy.erase_external", provider: input.provider } });
        outcome = "failed";
      }
    }
  }
  // Re-read under the lock: the other two providers may have recorded meanwhile.
  const current = reportOf((await lockRequest(ctx.tx, row.id))!.report);
  const report = { ...current, external: setExternal(current.external, input.provider, outcome) };
  await ctx.tx
    .update(privacyRequests)
    .set({ report, ...(outcome === "failed" ? { needsManualFollowup: true } : {}), updatedAt: ctx.now })
    .where(eq(privacyRequests.id, row.id));
  let nextEnqueued = false;
  if (allExternalRecorded(report)) {
    await ctx.enqueue({ kind: "privacy.erase_step", payload: { requestId: row.id, module: FIRST_ERASE_MODULE }, key: stepKey(row, FIRST_ERASE_MODULE) });
    nextEnqueued = true;
  }
  return { provider: input.provider, outcome, nextEnqueued };
}
