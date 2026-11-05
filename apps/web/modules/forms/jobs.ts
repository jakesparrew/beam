/**
 * forms jobs (forms spec section 4 "Jobs"). Facade read by `pnpm gen:indexes`. forms-P3 declares
 * `forms.mark_abandoned`, `forms.send_result_link` and `forms.check_cta_targets`; forms-P7 adds
 * `forms.process_import`. Retention is not a forms job (ops' `privacy.retention_sweep` calls the
 * `sweep` handlers of `privacy.ts`), and the result email is queued by `submit` itself.
 */
import { z } from "zod";
import { LOCALES } from "@beam/core/i18n";
import { brusselsDay } from "@beam/core/forms";
import { defineJob, type JobCtx } from "@/lib/job-runner";
import { refreshCtaWarnings } from "./service/cta-targets";
import { markImportFailed, processImportEvent } from "./service/import";
import { markAbandoned, sendResultLink } from "./service/submissions";

export const ABANDON_BATCH = 1000;

const MarkAbandonedInput = z.object({ n: z.number().int().positive().optional() });
const SendResultLinkInput = z.object({ submissionId: z.uuid(), locale: z.enum(LOCALES) });
const CheckCtaTargetsInput = z.object({}).passthrough();
const ProcessImportInput = z.object({ importEventId: z.uuid() });

/** The `YYYY-MM-DDTHH:mm` of the run: from the schedule or continuation key, else the Brussels minute of `now`. */
export function abandonMinute(key: string, now: Date): string {
  const m = /^(?:schedule:forms\.mark_abandoned:|form_abandon:)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(key);
  if (m) return m[1]!;
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return `${brusselsDay(now)}T${t}`;
}

/** U4: one batch; a full batch enqueues its continuation `form_abandon:<minute>:<n + 1>`. */
async function runMarkAbandoned(ctx: JobCtx, input: z.infer<typeof MarkAbandonedInput>): Promise<{ abandoned: number }> {
  const abandoned = await markAbandoned(ctx.tx, ctx, ABANDON_BATCH);
  if (abandoned >= ABANDON_BATCH) {
    const n = (input.n ?? 1) + 1;
    await ctx.enqueue({ kind: "forms.mark_abandoned", payload: { n }, key: `form_abandon:${abandonMinute(ctx.job.key, ctx.now)}:${n}` });
  }
  return { abandoned };
}

/** ID8: the email key is the job key when it has the spec's shape, else the first send of the day. */
async function runSendResultLink(ctx: JobCtx, input: z.infer<typeof SendResultLinkInput>): Promise<{ emailMessageId: string | null }> {
  const key = ctx.job.key.startsWith(`form_result_link:${input.submissionId}:`) ? ctx.job.key : `form_result_link:${input.submissionId}:${brusselsDay(ctx.now)}:1`;
  return sendResultLink(ctx.tx, ctx, { submissionId: input.submissionId, locale: input.locale, key });
}

async function runCheckCtaTargets(ctx: JobCtx): Promise<{ forms: number }> {
  return { forms: await refreshCtaWarnings(ctx.tx, ctx.now) };
}

/** I3, I4: one imported result; a skipped event (no email, invalid mapping) commits its reason and returns. */
async function runProcessImport(ctx: JobCtx, input: z.infer<typeof ProcessImportInput>): Promise<{ status: "processed" | "skipped" }> {
  return { status: await processImportEvent(ctx.tx, ctx, input.importEventId) };
}

export const jobs = [
  defineJob({ kind: "forms.mark_abandoned", lane: "fast", priority: 5, maxAttempts: 6, input: MarkAbandonedInput, run: runMarkAbandoned }),
  defineJob({ kind: "forms.send_result_link", lane: "fast", priority: 1, maxAttempts: 6, input: SendResultLinkInput, run: runSendResultLink }),
  defineJob({ kind: "forms.check_cta_targets", lane: "bulk", priority: 9, maxAttempts: 3, input: CheckCtaTargetsInput, run: (ctx) => runCheckCtaTargets(ctx) }),
  defineJob({
    kind: "forms.process_import",
    lane: "fast",
    priority: 5,
    maxAttempts: 6,
    input: ProcessImportInput,
    run: runProcessImport,
    // Attempts used up: the event shows `failed` with the reason on the source page (reprocess).
    onDead: (ctx, input, error) => markImportFailed(ctx.tx, ctx, input.importEventId, error.message),
  }),
];
