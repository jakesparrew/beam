/**
 * assistant jobs (`defineJob`). Facade read by `pnpm gen:indexes`: every `kind` is a literal.
 * - `assistant.analyse_conversation`: the analyst (server/analyse.ts); idempotent: a second run
 *   on an unchanged conversation is skipped, tags and events are deduped.
 * - `assistant.advise_person`: the lead agent's profile advice for one person (server/advise.ts);
 *   `assistant.advise_recent` is its daily sweep over people who visited or chatted.
 * - `assistant.run_eval`: one model over the evaluation set (server/eval.ts).
 */
import { z } from "zod";
import { defineJob } from "@/lib/job-runner";
import { runAdvise, runAdviseRecent } from "./server/advise";
import { runAnalyse } from "./server/analyse";
import { runEval } from "./server/eval";

export const AnalyseInput = z.object({ conversation_id: z.uuid(), force: z.boolean().optional() });
export const AdviseInput = z.object({ person_id: z.uuid() });
export const EvalInput = z.object({ run_key: z.string().min(1).max(80), model: z.string().min(3).max(120) });

export const jobs = [
  defineJob({ kind: "assistant.analyse_conversation", lane: "bulk", priority: 5, maxAttempts: 3, timeoutMs: 120_000, input: AnalyseInput, run: (ctx, input) => runAnalyse(ctx, input) }),
  defineJob({ kind: "assistant.advise_person", lane: "bulk", priority: 6, maxAttempts: 3, timeoutMs: 120_000, input: AdviseInput, run: (ctx, input) => runAdvise(ctx, input) }),
  defineJob({ kind: "assistant.advise_recent", lane: "bulk", priority: 7, maxAttempts: 2, input: z.object({}), run: (ctx) => runAdviseRecent(ctx) }),
  defineJob({ kind: "assistant.run_eval", lane: "bulk", priority: 8, maxAttempts: 1, timeoutMs: 600_000, input: EvalInput, run: (ctx, input) => runEval(ctx, input) }),
] as const;
