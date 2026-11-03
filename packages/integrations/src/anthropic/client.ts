/**
 * The Claude client (PL-51, PL-58). The only file besides the fake that imports
 * `@anthropic-ai/sdk` (ESLint enforces it). Called only through platform's `callClaude()` in
 * jobs, which writes `ai_requests`, checks the allow-list and the budget, and turns a refusal
 * into a `PermanentError` (PL-59). This client returns refusals as responses (with usage, so
 * the cost is still recorded) and throws `IntegrationError` for transport failures:
 * 429, 5xx (including 529 overloaded) and connection errors are retryable, other 4xx are not.
 */
import Anthropic, { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { NotImplementedError } from "@beam/core/errors";
import type { AiEffort, AiModelId } from "@beam/core/ai";
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError, networkError } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type OnCall } from "../_shared/types";

export type ClaudeMessage = { role: "user" | "assistant"; content: string };

export type ClaudeRequest = {
  /** The `AI_FEATURES` key; used for logging and by the fake's scripts. */
  feature: string;
  model: AiModelId;
  /** Stable system prompt, sent with `cache_control` so repeated calls read the cache. */
  system: string;
  messages: readonly ClaudeMessage[];
  maxTokens: number;
  effort: AiEffort;
  /** JSON schema for structured output (`output_config.format`), built from the feature's Zod schema. */
  outputSchema?: Record<string, unknown>;
};

export type ClaudeUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };

export type ClaudeResponse = {
  text: string;
  /** The parsed JSON when `outputSchema` was given and the text is valid JSON, else `null`. */
  json: unknown;
  stopReason: string;
  /** Set when `stopReason = 'refusal'` (`refusal:<category>` in `ai_requests.error`). */
  refusalCategory: string | null;
  usage: ClaudeUsage;
  model: string;
};

export type ClaudeBatchItem = { customId: string; request: ClaudeRequest };
export type ClaudeBatch = { id: string; status: "in_progress" | "canceling" | "ended" };
export type ClaudeBatchResult = { customId: string; response: ClaudeResponse | null; error: string | null };

export interface ClaudeClient {
  complete(request: ClaudeRequest): Promise<ClaudeResponse>;
  /** Message Batches (R4, platform-P10, half price). */
  createBatch(items: readonly ClaudeBatchItem[]): Promise<ClaudeBatch>;
  getBatch(id: string): Promise<ClaudeBatch>;
  getBatchResults(id: string): Promise<ClaudeBatchResult[]>;
}

export type ClaudeClientOptions = {
  apiKey: string;
  onCall?: OnCall;
  /** Request timeout in milliseconds (default 120 s; jobs set their own `timeoutMs` above it). */
  timeoutMs?: number;
  /** For tests: a `fetch` the SDK uses instead of the network. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  baseURL?: string;
};

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function createClaudeClient(options: ClaudeClientOptions): ClaudeClient {
  const onCall = options.onCall ?? noopOnCall;
  const sdk = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 0,
    timeout: options.timeoutMs ?? 120_000,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    async complete(request) {
      const operation = "messages.create";
      return trackCall(
        onCall,
        {
          provider: "anthropic",
          operation,
          requestDigest: digestRequest({ method: "POST", path: "/v1/messages", params: { model: request.model, feature: request.feature } }),
        },
        async () => {
          try {
            const message = await sdk.messages.create({
              model: request.model,
              max_tokens: request.maxTokens,
              system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
              messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
              thinking: { type: "adaptive" },
              output_config: {
                effort: request.effort,
                ...(request.outputSchema ? { format: { type: "json_schema" as const, schema: request.outputSchema } } : {}),
              },
            });
            const text = textOf(message.content);
            const stop = (message as { stop_details?: { category?: string | null } | null }).stop_details;
            return {
              statusCode: 200,
              value: {
                text,
                json: request.outputSchema ? parseJson(text) : null,
                stopReason: message.stop_reason ?? "end_turn",
                refusalCategory: message.stop_reason === "refusal" ? (stop?.category ?? "unknown") : null,
                usage: {
                  inputTokens: message.usage.input_tokens,
                  outputTokens: message.usage.output_tokens,
                  cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
                },
                model: message.model,
              },
            };
          } catch (error) {
            throw toIntegrationError(error, operation);
          }
        },
      );
    },
    createBatch() {
      return Promise.reject(new NotImplementedError("anthropic.createBatch (R4, platform-P10)"));
    },
    getBatch() {
      return Promise.reject(new NotImplementedError("anthropic.getBatch (R4, platform-P10)"));
    },
    getBatchResults() {
      return Promise.reject(new NotImplementedError("anthropic.getBatchResults (R4, platform-P10)"));
    },
  };
}

/** Maps SDK errors: status -> standard mapping, connection errors -> retryable. */
export function toIntegrationError(error: unknown, operation: string): IntegrationError {
  if (error instanceof IntegrationError) return error;
  if (error instanceof APIConnectionError) return networkError("anthropic", operation, error);
  if (error instanceof APIError && typeof error.status === "number") {
    return errorFromStatus("anthropic", operation, error.status, error.message);
  }
  return networkError("anthropic", operation, error);
}
