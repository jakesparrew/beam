/**
 * AI cost (PL-57, platform decisions 32 and 33): cents per million tokens from
 * `settings.ai.pricing`; the result keeps 4 decimals (`ai_requests.cost_cents numeric(12,4)`),
 * because one Haiku call costs a fraction of a cent. Message Batches (R4) cost half.
 */
import { z } from "zod";
import { PermanentError } from "../errors";
import type { AiModelId } from "./features";

export type ModelPricing = {
  in_cents_per_mtok: number;
  out_cents_per_mtok: number;
  cache_read_cents_per_mtok: number;
};

export const ModelPricingSchema = z.object({
  in_cents_per_mtok: z.number().nonnegative(),
  out_cents_per_mtok: z.number().nonnegative(),
  cache_read_cents_per_mtok: z.number().nonnegative(),
});

export const AiPricingSchema = z.record(z.string(), ModelPricingSchema);

export type AiPricing = Record<string, ModelPricing>;

/** The defaults of `settings.ai.pricing`. */
export const DEFAULT_AI_PRICING: Readonly<Record<AiModelId, ModelPricing>> = {
  "claude-opus-5-5": { in_cents_per_mtok: 400, out_cents_per_mtok: 2000, cache_read_cents_per_mtok: 20 },
  "claude-haiku-5-5": { in_cents_per_mtok: 10, out_cents_per_mtok: 50, cache_read_cents_per_mtok: 1 },
};

export type TokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number };

/** Rounds to 4 decimals without binary noise (`0.1 + 0.2` stays `0.3`). */
export function roundCents4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

/**
 * `(input × in + output × out + cache_read × cache_read) / 1,000,000`, rounded to 4 decimals.
 * `batch: true` halves the price (Message Batches API).
 */
export function costCents(usage: TokenUsage, pricing: ModelPricing, options: { batch?: boolean } = {}): number {
  for (const [name, n] of Object.entries(usage)) {
    if (n !== undefined && (!Number.isInteger(n) || n < 0)) throw new RangeError(`${name} must be a non-negative integer`);
  }
  const raw =
    usage.inputTokens * pricing.in_cents_per_mtok +
    usage.outputTokens * pricing.out_cents_per_mtok +
    (usage.cacheReadTokens ?? 0) * pricing.cache_read_cents_per_mtok;
  return roundCents4((raw / 1_000_000) * (options.batch ? 0.5 : 1));
}

/** The pricing row for a model, or `PermanentError('pricing_missing')` when settings lack it. */
export function pricingFor(model: string, pricing: AiPricing = DEFAULT_AI_PRICING): ModelPricing {
  const row = pricing[model];
  if (!row) throw new PermanentError(`pricing_missing: ${model}`);
  return row;
}
