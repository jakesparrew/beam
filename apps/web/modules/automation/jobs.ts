/**
 * automation jobs (automation spec 4.4, `defineJob`). Facade read by `pnpm gen:indexes`.
 * automation-P2 declares the evaluator and the fast unsubscribe exit; automation-P3 adds the
 * step, bulk and webhook jobs.
 */
import { z } from "zod";
import { defineJob } from "@/lib/job-runner";
import { evaluateBatch } from "./engine/evaluate";
import { exitForSuppression } from "./engine/exits";

export const EvaluateInput = z.object({ continuation: z.literal(true).optional() });
export const ExitForSuppressionInput = z.object({ suppressionId: z.uuid() });

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
];
