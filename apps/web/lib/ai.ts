/**
 * The AI gateway (PL-51 to PL-61). Claude is called only through `callClaude()` inside a job.
 * Before a call: the feature must exist, `fieldsSent` must be allowed, sensitive keys are
 * blocked unless switched on for a feature that allows them (none does), and the monthly
 * budget and daily cap must not be reached. Every call, allowed or not, leaves one
 * `ai_requests` row that survives a rollback of the job (written durably). `callClaude()`
 * never writes domain rows; the caller stores the output as a draft.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbOrTx } from "@beam/db";
import { aiRequests } from "@beam/db/schema";
import { PermanentError, RetryableError } from "@beam/core/errors";
import {
  AI_FEATURES,
  costCents,
  disallowedFields,
  isAiFeatureKey,
  modelIdFor,
  pricingFor,
  type AiFeatureKey,
  type AiModelId,
  type AiPricing,
} from "@beam/core/ai";
import { isSensitiveKey } from "@beam/core/privacy";
import { wallClock } from "@beam/core/platform";
import { IntegrationError } from "@beam/integrations/_shared";
import type { ClaudeMessage } from "@beam/integrations/anthropic";
import { actorJson, sql, writeDurably } from "./ctx";
import type { JobCtx } from "./job-runner";
import { appEnv } from "./integrations";
import { claimOnce, notifySlack } from "./alerts";
import { getSetting } from "./settings";
import { rowsOf } from "./sensitive";

export type { ClaudeMessage };

export const NON_PRODUCTION_DAILY_CAP = 100;

type AiSettingValue = { sensitive_enabled: boolean; monthly_budget_cents: number; daily_cap_calls: number; pricing: AiPricing };

export type CallClaudeRequest<S extends z.ZodTypeAny | undefined> = {
  feature: AiFeatureKey;
  model: "opus" | "haiku";
  system: string;
  messages: ClaudeMessage[];
  personId?: string;
  fieldsSent: string[];
  outputSchema?: S;
  maxTokens?: number;
};

type RowInput = {
  id: string;
  feature: string;
  model: AiModelId;
  status: "ok" | "error" | "budget_exceeded";
  prompt: string;
  output?: string | null;
  error?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costCents?: number;
  durationMs?: number;
};

async function logRequest(ctx: JobCtx, req: CallClaudeRequest<z.ZodTypeAny | undefined>, row: RowInput): Promise<void> {
  const values = {
    id: row.id,
    feature: row.feature,
    model: row.model,
    actor: actorJson(ctx.actor),
    personId: req.personId ?? null,
    fieldsSent: req.fieldsSent,
    prompt: row.prompt,
    output: row.output ?? null,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    costCents: String(row.costCents ?? 0),
    status: row.status,
    error: row.error ?? null,
    jobId: ctx.job.id || null,
    durationMs: row.durationMs ?? null,
  };
  await writeDurably(ctx, async (db) => {
    await db.insert(aiRequests).values(values);
  });
}

/** Brussels-month spend (cents) and today's call count, from `ai_requests`. */
export async function aiUsage(tx: DbOrTx): Promise<{ monthCents: number; todayCalls: number }> {
  const rows = rowsOf<{ month_cents: number | string | null; today_calls: number | string | null }>(
    await tx.execute(sql`
      select
        coalesce(sum(cost_cents) filter (where created_at >= (date_trunc('month', now() at time zone 'Europe/Brussels') at time zone 'Europe/Brussels')), 0)::float8 as month_cents,
        count(*) filter (where status <> 'budget_exceeded' and created_at >= (date_trunc('day', now() at time zone 'Europe/Brussels') at time zone 'Europe/Brussels'))::int as today_calls
      from ai_requests
      where created_at >= (date_trunc('month', now() at time zone 'Europe/Brussels') at time zone 'Europe/Brussels') - interval '1 day'`),
  );
  return { monthCents: Number(rows[0]?.month_cents ?? 0), todayCalls: Number(rows[0]?.today_calls ?? 0) };
}

const promptText = (system: string, messages: readonly ClaudeMessage[]) =>
  [`[system]\n${system}`, ...messages.map((m) => `[${m.role}]\n${m.content}`)].join("\n\n");

export async function callClaude<S extends z.ZodTypeAny | undefined = undefined>(
  ctx: JobCtx,
  req: CallClaudeRequest<S>,
): Promise<{ text: string; parsed: S extends z.ZodTypeAny ? z.infer<S> : undefined; aiRequestId: string }> {
  if (!isAiFeatureKey(req.feature)) throw new PermanentError(`unknown_ai_feature: ${String(req.feature)}`);
  const feature = AI_FEATURES[req.feature];
  const model = modelIdFor(req.model);
  const id = randomUUID();
  const prompt = promptText(req.system, req.messages);
  const anyReq = req as CallClaudeRequest<z.ZodTypeAny | undefined>;
  const ai = (await getSetting(ctx.tx, "ai")) as AiSettingValue;

  // PL-54: sensitive keys only when switched on and the feature allows them (no feature does).
  const sensitive = req.fieldsSent.filter((f) => isSensitiveKey(f));
  if (sensitive.length && !(ai.sensitive_enabled && (feature.allowsSensitive as boolean))) {
    await logRequest(ctx, anyReq, { id, feature: req.feature, model, status: "error", prompt: "[not sent]", error: "sensitive_not_allowed" });
    throw new PermanentError("sensitive_not_allowed");
  }
  // PL-53: fields must be a subset of the feature's allow-list.
  if (disallowedFields(feature, req.fieldsSent).length) {
    await logRequest(ctx, anyReq, { id, feature: req.feature, model, status: "error", prompt: "[not sent]", error: "field_not_allowed" });
    throw new PermanentError("field_not_allowed");
  }
  // PL-56: monthly budget and daily cap.
  const usage = await aiUsage(ctx.tx);
  const cap = appEnv() === "production" ? ai.daily_cap_calls : Math.min(ai.daily_cap_calls, NON_PRODUCTION_DAILY_CAP);
  if (usage.monthCents >= ai.monthly_budget_cents || usage.todayCalls >= cap) {
    await logRequest(ctx, anyReq, { id, feature: req.feature, model, status: "budget_exceeded", prompt, error: "budget" });
    throw new PermanentError("budget");
  }

  const started = Date.now();
  let response;
  try {
    response = await ctx.integrations.anthropic.complete({
      feature: req.feature,
      model,
      system: req.system,
      messages: req.messages,
      maxTokens: req.maxTokens ?? 2048,
      effort: feature.effort,
      ...(req.outputSchema ? { outputSchema: z.toJSONSchema(req.outputSchema) as Record<string, unknown> } : {}),
    });
  } catch (error) {
    const message = error instanceof IntegrationError ? error.message : error instanceof Error ? error.message : String(error);
    await logRequest(ctx, anyReq, { id, feature: req.feature, model, status: "error", prompt, error: message.slice(0, 1000), durationMs: Date.now() - started });
    throw error;
  }

  const cost = costCents(response.usage, pricingFor(model, ai.pricing));
  const base: RowInput = {
    id,
    feature: req.feature,
    model,
    status: "ok",
    prompt,
    output: response.text,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    cacheReadTokens: response.usage.cacheReadTokens,
    costCents: cost,
    durationMs: Date.now() - started,
  };

  // PL-59: a refusal is permanent.
  if (response.stopReason === "refusal") {
    await logRequest(ctx, anyReq, { ...base, status: "error", output: null, error: `refusal:${response.refusalCategory ?? "unknown"}` });
    throw new PermanentError(`refusal:${response.refusalCategory ?? "unknown"}`);
  }

  let parsed: unknown;
  if (req.outputSchema) {
    const result = req.outputSchema.safeParse(response.json ?? safeJson(response.text));
    if (!result.success) {
      await logRequest(ctx, anyReq, { ...base, status: "error", error: "invalid_output" });
      // Edge case 21: one retry, then permanent.
      if (ctx.job.attempt <= 1) throw new RetryableError("invalid_output");
      throw new PermanentError("invalid_output");
    }
    parsed = result.data;
  }
  await logRequest(ctx, anyReq, base);

  // PL-56: one Slack line per month when spend crosses 80 % of the budget.
  const before = usage.monthCents;
  const after = before + cost;
  const threshold = ai.monthly_budget_cents * 0.8;
  if (ai.monthly_budget_cents > 0 && before < threshold && after >= threshold) {
    const w = wallClock(ctx.now);
    const month = `${w.year}-${String(w.month).padStart(2, "0")}`;
    const nextMonth = new Date(Date.UTC(w.month === 12 ? w.year + 1 : w.year, w.month % 12, 2));
    if (await claimOnce(ctx.tx, `alert:ai-budget-80:${month}`, nextMonth)) {
      await notifySlack(ctx, { fingerprint: `ai-budget-80-${month}`, severity: "normal", text: `AI spend crossed 80 % of the monthly budget (${Math.round(after)} of ${ai.monthly_budget_cents} cents).` });
    }
  }

  return { text: response.text, parsed: parsed as S extends z.ZodTypeAny ? z.infer<S> : undefined, aiRequestId: id };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
