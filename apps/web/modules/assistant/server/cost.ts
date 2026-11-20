/**
 * Cost of one model call in cents (4 decimals), from the price list in `settings.assistant.models`
 * (cents per million tokens). Gateway usage counts input without the cached part, so the four
 * token kinds add up. A model missing from the list costs the most expensive listed price, so an
 * unknown model never looks free.
 */
import type { ChatUsage } from "@beam/integrations/anthropic";
import type { AssistantSettingValue } from "../config";

export function priceOf(models: AssistantSettingValue["models"], model: string): AssistantSettingValue["models"][number] {
  const found = models.find((m) => m.id === model);
  if (found) return found;
  const dearest = [...models].sort((a, b) => b.out - a.out)[0];
  return dearest ?? { id: model, label: model, in: 0, out: 0, cache_read: 0, cache_write: 0 };
}

export function costCentsOf(models: AssistantSettingValue["models"], model: string, usage: ChatUsage): number {
  const p = priceOf(models, model);
  const raw = (usage.inputTokens * p.in + usage.outputTokens * p.out + usage.cacheReadTokens * p.cache_read + usage.cacheWriteTokens * p.cache_write) / 1_000_000;
  return Math.round((raw + Number.EPSILON) * 10_000) / 10_000;
}

export function addUsage(a: ChatUsage, b: ChatUsage): ChatUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export const ZERO_USAGE: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
