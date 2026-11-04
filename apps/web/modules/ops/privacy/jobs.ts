/**
 * ops jobs, area `privacy` (ops spec 4.4, rules 59a-64; ops-P5): `privacy.export`,
 * `privacy.erase`, `privacy.erase_external`, `privacy.erase_step`, `privacy.finalise`. Registered
 * in `../jobs.ts` by ops-P1 with these names, inputs and signatures. Every key carries
 * `r<run_attempt>`; every handler is idempotent (a second run finds the work recorded and exits).
 *
 * A local step or the export failing on its last attempt (or permanently) marks the request
 * `failed` through `writeDurably`, so the mark survives the job's rollback; run-now reruns it.
 */
import { z } from "zod";
import { formatDate } from "@beam/core/i18n";
import { privacyRequests } from "@beam/db/schema";
import { brusselsDate, ERASE_EXTERNAL_PROVIDERS, ERASE_ORDER } from "@beam/core/ops";
import { and, eq, writeDurably } from "@/lib/ctx";
import { PermanentError, RetryableError, type JobCtx } from "@/lib/job-runner";
import { sendTransactional } from "@/modules/email/api";
import { eraseExternal } from "./external";
import { storeSubjectExport } from "./export-zip";
import { accountPrivacyUrl, enqueueAfterStep, lockPerson, lockRequest, otherRunning, runEraseStep, startErasure } from "./orchestrator";
import { erasedAuditValue, hasFailedExternal, reportOf, retainedOf } from "./report";

const request = z.object({ requestId: z.uuid() });

/** Key `privacy:<id>:r<run_attempt>:export`. */
export const PrivacyExportInput = request;
/** Key `privacy:<id>:r<run_attempt>:start` (run now: `:start:now`). */
export const PrivacyEraseInput = request;
/** Key `privacy:<id>:r<run_attempt>:external:<provider>`. */
export const PrivacyEraseExternalInput = request.extend({ provider: z.enum(ERASE_EXTERNAL_PROVIDERS) });
/** Key `privacy:<id>:r<run_attempt>:step:<module>`. */
export const PrivacyEraseStepInput = request.extend({ module: z.enum(ERASE_ORDER) });
/** Key `privacy:<id>:r<run_attempt>:finalise`. */
export const PrivacyFinaliseInput = request;

/** `maxAttempts` of the privacy jobs in `../jobs.ts` (the defineJob default). */
export const PRIVACY_MAX_ATTEMPTS = 6;

/** Marks a running request `failed` in a write that survives the rollback. */
async function failDurably(ctx: JobCtx, requestId: string, attempt: number): Promise<void> {
  await writeDurably(ctx, async (db) => {
    await db
      .update(privacyRequests)
      .set({ status: "failed", updatedAt: ctx.now })
      .where(and(eq(privacyRequests.id, requestId), eq(privacyRequests.status, "running"), eq(privacyRequests.runAttempt, attempt)));
  });
}

async function failOnLastAttempt<T>(ctx: JobCtx, requestId: string, run: () => Promise<T>): Promise<T> {
  const row = await lockRequest(ctx.tx, requestId);
  const attempt = row?.runAttempt ?? 1;
  try {
    return await run();
  } catch (error) {
    const last = error instanceof PermanentError || (!(error instanceof RetryableError && error.message === "privacy_person_busy") && ctx.job.attempt >= PRIVACY_MAX_ATTEMPTS);
    if (last) await failDurably(ctx, requestId, attempt);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// privacy.export (rule 60)
// ---------------------------------------------------------------------------

async function exportJob(ctx: JobCtx, input: z.infer<typeof PrivacyExportInput>) {
  const row = await lockRequest(ctx.tx, input.requestId);
  if (!row || row.kind !== "export") return { skipped: "missing" };
  if (row.status !== "running") return { skipped: row.status };
  const person = await lockPerson(ctx.tx, row.personId);
  if (!person || person.erasedAt) throw new PermanentError("person_erased");
  // Rule 63a: never while an erasure of the same person runs.
  if (await otherRunning(ctx.tx, row.personId, row.id, "erase")) throw new RetryableError("privacy_person_busy");
  const stored = await storeSubjectExport(ctx, row.id, row.personId);
  const [first, ...rest] = stored.fileIds;
  await ctx.tx
    .update(privacyRequests)
    .set({ status: "done", fileId: first ?? null, partFileIds: rest, completedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(privacyRequests.id, row.id));
  await ctx.recordEvent({ kind: "privacy.exported", personId: row.personId, data: {}, dedupeKey: `privacy:${row.id}:exported` });
  if (person.email) {
    await sendTransactional(ctx, {
      template: "ops.privacy_export_ready",
      personId: row.personId,
      locale: person.locale,
      data: { requestId: row.id, date: formatDate(brusselsDate(stored.expiresAt), person.locale, "long"), accountUrl: accountPrivacyUrl(person.locale) },
      key: `privacy:${row.id}:r${row.runAttempt}:email:export_ready`,
    });
  }
  return { done: true, parts: stored.fileIds.length, bytes: stored.bytes };
}

/** Rule 60: the encrypted subject export zip. */
export function runPrivacyExport(ctx: JobCtx, input: z.infer<typeof PrivacyExportInput>): Promise<unknown> {
  return failOnLastAttempt(ctx, input.requestId, () => exportJob(ctx, input));
}

// ---------------------------------------------------------------------------
// privacy.erase, erase_external, erase_step, finalise (rules 61-64)
// ---------------------------------------------------------------------------

/** Rules 61, 63a: starts the erasure at `scheduled_for_at` and enqueues the external steps. */
export async function runPrivacyErase(ctx: JobCtx, input: z.infer<typeof PrivacyEraseInput>): Promise<unknown> {
  const outcome = await startErasure(ctx, input.requestId);
  if (outcome === "busy") throw new RetryableError("privacy_person_busy");
  return outcome;
}

/** Rules 62-63: Billit, payment mandates and Resend, while the address is still known. */
export function runPrivacyEraseExternal(ctx: JobCtx, input: z.infer<typeof PrivacyEraseExternalInput>): Promise<unknown> {
  return eraseExternal(ctx, input);
}

async function eraseStepJob(ctx: JobCtx, input: z.infer<typeof PrivacyEraseStepInput>) {
  const row = await lockRequest(ctx.tx, input.requestId);
  if (!row || row.kind !== "erase") return { skipped: "missing" };
  if (row.status !== "running") return { skipped: row.status };
  const steps = await runEraseStep(ctx.tx, row.id, input.module);
  await enqueueAfterStep(ctx, row, input.module);
  return { module: input.module, steps: steps.length };
}

/** Rule 62: one module's registry `erase` under `SET LOCAL beam.allow_rewrite = 'on'`. */
export function runPrivacyEraseStep(ctx: JobCtx, input: z.infer<typeof PrivacyEraseStepInput>): Promise<unknown> {
  return failOnLastAttempt(ctx, input.requestId, () => eraseStepJob(ctx, input));
}

async function finaliseJob(ctx: JobCtx, input: z.infer<typeof PrivacyFinaliseInput>) {
  const row = await lockRequest(ctx.tx, input.requestId);
  if (!row || row.kind !== "erase") return { skipped: "missing" };
  if (row.status !== "running") return { skipped: row.status };
  const report = reportOf(row.report);
  report.retained = retainedOf(report.steps);
  report.finishedAt = ctx.now.toISOString();
  await ctx.tx
    .update(privacyRequests)
    .set({ status: "done", report, needsManualFollowup: hasFailedExternal(report), completedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(privacyRequests.id, row.id));
  // Rule 64: entity is the request, no name or email; no event (the person is gone).
  await ctx.audit({ action: "privacy.erased", entityType: "privacy_request", entityId: row.id, newValue: erasedAuditValue(report) });
  return { done: true };
}

/** Rule 64: status `done`, audit `privacy.erased`, no event. */
export function runPrivacyFinalise(ctx: JobCtx, input: z.infer<typeof PrivacyFinaliseInput>): Promise<unknown> {
  return failOnLastAttempt(ctx, input.requestId, () => finaliseJob(ctx, input));
}
