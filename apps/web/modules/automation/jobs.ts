/**
 * automation jobs (automation spec 4.4, `defineJob`). Facade read by `pnpm gen:indexes`.
 * automation-P2 declares the evaluator and the fast unsubscribe exit; automation-P3 adds the
 * step, bulk and webhook jobs and the sweep.
 *
 * `automation.step` and `automation.call_webhook` declare platform's `onDead` hook (PL-29a):
 * `recordDeadStep` writes the `failed` run and advances the enrolment (A-35).
 */
import { z } from "zod";
import { defineJob } from "@/lib/job-runner";
import { recordDeadStep } from "./engine/advance";
import { endEnrolments, enrolSegment, migrateEnrolments, resumeEnrolments } from "./engine/bulk";
import { evaluateBatch } from "./engine/evaluate";
import { exitForSuppression } from "./engine/exits";
import { runStep } from "./engine/step";
import { sweepEnrolments } from "./engine/sweep";
import { callWebhook } from "./engine/webhook";

export const EvaluateInput = z.object({ continuation: z.literal(true).optional() });
export const ExitForSuppressionInput = z.object({ suppressionId: z.uuid() });
export const StepInput = z.object({ enrolmentId: z.uuid(), stepKey: z.string().min(1).max(40) });
export const ResumeEnrolmentsInput = z.object({ automationId: z.uuid(), resumedAt: z.iso.datetime({ offset: true }), after: z.uuid().optional() });
export const MigrateEnrolmentsInput = z.object({ automationId: z.uuid(), toVersionId: z.uuid(), after: z.uuid().optional() });
export const EndEnrolmentsInput = z.object({ automationId: z.uuid(), reason: z.literal("archived"), after: z.uuid().optional() });
export const EnrolSegmentInput = z.object({ automationId: z.uuid(), segmentId: z.uuid(), requestId: z.string().min(1).max(100), after: z.uuid().optional() });
export const CallWebhookInput = z.object({ enrolmentId: z.uuid(), stepKey: z.string().min(1).max(40) });
export const SweepInput = z.object({});

export const jobs = [
  defineJob({
    kind: "automation.evaluate",
    lane: "fast",
    priority: 3,
    maxAttempts: 2,
    timeoutMs: 45_000,
    input: EvaluateInput,
    run: (ctx) => evaluateBatch(ctx.tx, ctx.now, { ctx }),
  }),
  defineJob({
    kind: "automation.exit_for_suppression",
    lane: "fast",
    priority: 1,
    maxAttempts: 6,
    timeoutMs: 20_000,
    input: ExitForSuppressionInput,
    run: (ctx, input) => exitForSuppression(ctx.tx, input.suppressionId, ctx.actor),
  }),
  defineJob({
    kind: "automation.step",
    lane: "fast",
    priority: 5,
    maxAttempts: 6,
    timeoutMs: 30_000,
    input: StepInput,
    run: (ctx, input) => runStep(ctx.tx, { ...input, now: ctx.now }, { ctx }),
    onDead: async (ctx, input, error) => {
      await recordDeadStep(ctx, input, error, "automation.step");
    },
  }),
  defineJob({
    kind: "automation.resume_enrolments",
    lane: "bulk",
    priority: 5,
    maxAttempts: 6,
    timeoutMs: 60_000,
    input: ResumeEnrolmentsInput,
    run: (ctx, input) => resumeEnrolments(ctx.tx, ctx, input),
  }),
  defineJob({
    kind: "automation.migrate_enrolments",
    lane: "bulk",
    priority: 5,
    maxAttempts: 6,
    timeoutMs: 60_000,
    input: MigrateEnrolmentsInput,
    run: (ctx, input) => migrateEnrolments(ctx.tx, ctx, input),
  }),
  defineJob({
    kind: "automation.end_enrolments",
    lane: "bulk",
    priority: 5,
    maxAttempts: 6,
    timeoutMs: 60_000,
    input: EndEnrolmentsInput,
    run: (ctx, input) => endEnrolments(ctx.tx, ctx, input),
  }),
  defineJob({
    kind: "automation.enrol_segment",
    lane: "bulk",
    priority: 9,
    maxAttempts: 6,
    timeoutMs: 60_000,
    input: EnrolSegmentInput,
    run: (ctx, input) => enrolSegment(ctx.tx, ctx, input),
  }),
  defineJob({
    kind: "automation.call_webhook",
    lane: "fast",
    priority: 5,
    maxAttempts: 6,
    timeoutMs: 15_000,
    input: CallWebhookInput,
    run: (ctx, input) => callWebhook(ctx.tx, ctx, input),
    onDead: async (ctx, input, error) => {
      await recordDeadStep(ctx, input, error, "automation.call_webhook");
    },
  }),
  defineJob({
    kind: "automation.sweep_enrolments",
    lane: "fast",
    priority: 4,
    maxAttempts: 2,
    timeoutMs: 60_000,
    input: SweepInput,
    run: (ctx) => sweepEnrolments(ctx.tx, ctx, ctx.now),
  }),
];
