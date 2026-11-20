/**
 * One turn of the agent: stream the model's answer to the widget, run the tools it asks for, feed
 * the results back, and stop after at most `MAX_ROUNDS` model calls. Every round's cost is computed
 * with the model that actually answered (the fallback when the first one failed).
 */
import "server-only";
import type { ChatMessage, ChatUsage } from "@beam/integrations/anthropic";
import type { Locale } from "@beam/core/i18n";
import type { AssistantCard, AssistantToolCall } from "@beam/db/schema";
import type { AssistantSettingValue } from "../config";
import { chatClient } from "./client";
import { addUsage, costCentsOf, ZERO_USAGE } from "./cost";
import { runTool, toolsFor, type ToolCtx } from "./tools";

export const MAX_ROUNDS = 4;

export type AgentEvent = { t: "delta"; text: string } | { t: "card"; card: AssistantCard };

export type TurnInput = {
  settings: AssistantSettingValue;
  role: "guide" | "coach";
  locale: Locale;
  system: string;
  context: string;
  /** Text history, oldest first, ending with the person's new message. */
  history: ChatMessage[];
  toolCtx: ToolCtx;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
};

export type TurnResult = {
  text: string;
  cards: AssistantCard[];
  tools: AssistantToolCall[];
  usage: ChatUsage;
  model: string;
  costCents: number;
  durationMs: number;
  rounds: number;
};

const AFTER_TOOLS: Record<Locale, string> = {
  "nl-BE": "Kijk hieronder.",
  "fr-BE": "Regardez ci-dessous.",
  en: "Have a look below.",
};

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const cfg = input.settings.roles[input.role];
  const client = chatClient();
  const started = Date.now();
  let messages: ChatMessage[] = [...input.history];
  let usage: ChatUsage = ZERO_USAGE;
  let cost = 0;
  let model = cfg.model;
  let text = "";
  let gap = false;
  const cards: AssistantCard[] = [];
  const tools: AssistantToolCall[] = [];
  let rounds = 0;

  const onText = (delta: string) => {
    if (gap && text && delta.trim()) {
      text += "\n\n";
      input.emit({ t: "delta", text: "\n\n" });
    }
    gap = false;
    text += delta;
    input.emit({ t: "delta", text: delta });
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    rounds++;
    const r = await client.stream(
      {
        model: cfg.model,
        fallbackModel: cfg.fallback,
        system: input.system,
        context: input.context,
        messages,
        tools: toolsFor(input.role),
        maxTokens: cfg.max_tokens,
        effort: cfg.effort,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      onText,
    );
    usage = addUsage(usage, r.usage);
    cost += costCentsOf(input.settings.models, r.model, r.usage);
    model = r.model;
    if (!r.toolCalls.length) break;

    const results: unknown[] = [];
    for (const call of r.toolCalls) {
      const t0 = Date.now();
      const out = await runTool(input.toolCtx, call.name, call.input);
      tools.push({ name: call.name, input: call.input, output: out.result, ms: Date.now() - t0 });
      if (out.card) {
        cards.push(out.card);
        input.emit({ t: "card", card: out.card });
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(out.result).slice(0, 8000) });
    }
    messages = [...messages, { role: "assistant", content: r.content }, { role: "user", content: results }];
    gap = true;
  }

  if (!text.trim() && cards.length) onText(AFTER_TOOLS[input.locale]);
  return { text, cards, tools, usage, model, costCents: Math.round(cost * 10_000) / 10_000, durationMs: Date.now() - started, rounds };
}
