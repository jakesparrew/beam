/**
 * The chat client of the assistant: Vercel AI Gateway through its Anthropic-compatible Messages
 * API, with the official SDK (the only folder allowed to import it). One model is one gateway id
 * (`anthropic/claude-haiku-5.5`, `google/gemini-3-flash`, `openai/gpt-5.5`), so switching model or
 * provider is a setting. Streams text deltas, returns tool calls for the caller's tool loop, caches
 * the stable system block, and retries once on the fallback model when the first one fails.
 */
import Anthropic, { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { errorFromStatus, IntegrationError, networkError } from "../_shared/errors";

export const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";

export type ChatEffort = "none" | "low" | "medium" | "high";

export type ChatTool = { name: string; description: string; inputSchema: Record<string, unknown> };

/** Message content: plain text, or the raw blocks of an earlier round (tool use and results). */
export type ChatMessage = { role: "user" | "assistant"; content: string | unknown[] };

export type ChatRequest = {
  model: string;
  fallbackModel?: string | null;
  /** Stable for every caller (instructions, knowledge, tool rules): cached. */
  system: string;
  /** Per-conversation context after the cached block (the customer's profile, the page). */
  context?: string;
  messages: readonly ChatMessage[];
  tools?: readonly ChatTool[];
  maxTokens: number;
  effort: ChatEffort;
  signal?: AbortSignal;
};

export type ChatUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export type ChatToolCall = { id: string; name: string; input: Record<string, unknown> };

export type ChatResult = {
  text: string;
  toolCalls: ChatToolCall[];
  stopReason: string;
  usage: ChatUsage;
  /** The model that answered (the fallback when the first one failed). */
  model: string;
  /** The assistant blocks to send back in the next round of a tool loop. */
  content: unknown[];
};

export interface ChatClient {
  readonly live: boolean;
  stream(request: ChatRequest, onText: (delta: string) => void): Promise<ChatResult>;
}

type SdkBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown };
type SdkUsage = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

export function gatewayParams(request: ChatRequest, model: string) {
  const system: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[] = [
    { type: "text", text: request.system, cache_control: { type: "ephemeral" } },
  ];
  if (request.context) system.push({ type: "text", text: request.context });
  return {
    model,
    max_tokens: request.maxTokens,
    system,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(request.tools?.length
      ? { tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }
      : {}),
    ...(request.effort === "none" ? {} : { thinking: { type: "adaptive" }, output_config: { effort: request.effort } }),
  };
}

export function usageOf(usage: SdkUsage | undefined): ChatUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

export function resultOf(message: { content: readonly SdkBlock[]; stop_reason?: string | null; usage?: SdkUsage; model?: string }, model: string): ChatResult {
  return {
    text: message.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
    toolCalls: message.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id ?? "", name: b.name ?? "", input: (b.input ?? {}) as Record<string, unknown> })),
    stopReason: message.stop_reason ?? "end_turn",
    usage: usageOf(message.usage),
    model,
    content: [...message.content],
  };
}

function toIntegrationError(error: unknown): IntegrationError {
  if (error instanceof IntegrationError) return error;
  if (error instanceof APIConnectionError) return networkError("anthropic", "gateway.stream", error);
  if (error instanceof APIError && typeof error.status === "number") return errorFromStatus("anthropic", "gateway.stream", error.status, error.message);
  return networkError("anthropic", "gateway.stream", error);
}

export function createGatewayClient(options: { apiKey: string; baseURL?: string; timeoutMs?: number; fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }): ChatClient {
  const sdk = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseURL ?? GATEWAY_BASE_URL,
    maxRetries: 0,
    timeout: options.timeoutMs ?? 90_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  async function once(request: ChatRequest, model: string, onText: (delta: string) => void, sent: { any: boolean }): Promise<ChatResult> {
    const stream = sdk.messages.stream(gatewayParams(request, model) as unknown as Parameters<typeof sdk.messages.stream>[0], request.signal ? { signal: request.signal } : undefined);
    stream.on("text", (delta: string) => {
      sent.any = true;
      onText(delta);
    });
    const message = (await stream.finalMessage()) as unknown as { content: SdkBlock[]; stop_reason?: string | null; usage?: SdkUsage };
    return resultOf(message, model);
  }

  return {
    live: true,
    async stream(request, onText) {
      const sent = { any: false };
      try {
        return await once(request, request.model, onText, sent);
      } catch (error) {
        const failure = toIntegrationError(error);
        // The fallback only when nothing reached the visitor yet (no half answer twice).
        if (!request.fallbackModel || request.fallbackModel === request.model || sent.any || request.signal?.aborted) throw failure;
        try {
          return await once(request, request.fallbackModel, onText, sent);
        } catch (second) {
          throw toIntegrationError(second);
        }
      }
    },
  };
}

/** A scripted round: text to stream, and tool calls to make (the loop runs them and asks again). */
export type GatewayScriptRound = { text?: string; toolCalls?: { name: string; input: Record<string, unknown> }[] };
export type GatewayScript = (request: ChatRequest) => GatewayScriptRound;

/** The fake's default: one availability lookup for an availability question, then a short answer. */
const AVAILABILITY = /\b(plaats|vrij|beschikbaar|wanneer|morgen|available|availability|when|tomorrow|place|disponib|demain|quand)\b/i;

function lastUserText(request: ChatRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i]!;
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

function hasToolResults(request: ChatRequest): boolean {
  const last = request.messages.at(-1);
  return !!last && Array.isArray(last.content) && last.content.some((b) => (b as { type?: string }).type === "tool_result");
}

export const defaultGatewayScript: GatewayScript = (request) => {
  const text = lastUserText(request);
  const tools = new Set((request.tools ?? []).map((t) => t.name));
  if (!hasToolResults(request) && tools.has("get_availability") && AVAILABILITY.test(text)) {
    const from = new Date().toISOString().slice(0, 10);
    return { toolCalls: [{ name: "get_availability", input: { from, days: 7 } }] };
  }
  if (hasToolResults(request)) return { text: "Ik vond deze sessies voor je. Kies er een om meteen te boeken." };
  return { text: "Dit is een testantwoord van de BEAM-gids. In de echte omgeving antwoordt hier het gekozen model." };
};

/** The fake chat client: scripted rounds streamed in small chunks, with real-looking usage. */
export function createGatewayFake(options: { script?: GatewayScript } = {}): ChatClient & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  const script = options.script ?? defaultGatewayScript;
  let n = 0;
  return {
    live: false,
    calls,
    stream(request, onText) {
      calls.push(request);
      const round = script(request);
      const text = round.text ?? "";
      for (const part of text.match(/.{1,12}/gs) ?? []) onText(part);
      const toolCalls = (round.toolCalls ?? []).map((c) => ({ id: `toolu_fake_${++n}`, name: c.name, input: c.input }));
      const content: unknown[] = [
        ...(text ? [{ type: "text", text }] : []),
        ...toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
      ];
      const promptChars = request.system.length + (request.context?.length ?? 0) + JSON.stringify(request.messages).length;
      return Promise.resolve({
        text,
        toolCalls,
        stopReason: toolCalls.length ? "tool_use" : "end_turn",
        usage: { inputTokens: Math.ceil(promptChars / 4), outputTokens: Math.ceil(text.length / 4) + toolCalls.length * 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: request.model,
        content,
      });
    },
  };
}
