/**
 * The Claude client (PL-51, PL-58). The only file besides the fake that imports
 * `@anthropic-ai/sdk` (ESLint enforces it). Called only through platform's `callClaude()` in
 * jobs, which writes `ai_requests`, checks the allow-list and the budget, and turns a refusal
 * into a `PermanentError` (PL-59). This client returns refusals as responses (with usage, so
 * the cost is still recorded) and throws `IntegrationError` for transport failures:
 * 429, 5xx (including 529 overloaded) and connection errors are retryable, other 4xx are not.
 *
 * R4 (platform-P10): Message Batches (`createBatch`, `getBatch`, `getBatchResults`) for
 * `ai.weekly_summary`, billed at half price (`costCents(usage, pricing, { batch: true })`).
 * Each batch request uses the same parameters as `complete`; results come back in any order,
 * keyed by `customId`.
 */
import Anthropic, { APIConnectionError, APIError } from "@anthropic-ai/sdk";
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
/** One result: `response` when the request succeeded, else `error` (`errored:<type>`, `canceled`, `expired`). */
export type ClaudeBatchResult = { customId: string; response: ClaudeResponse | null; error: string | null };

export interface ClaudeClient {
  complete(request: ClaudeRequest): Promise<ClaudeResponse>;
  /** Message Batches (R4, platform-P10, half price). */
  createBatch(items: readonly ClaudeBatchItem[]): Promise<ClaudeBatch>;
  getBatch(id: string): Promise<ClaudeBatch>;
  /** Only once `getBatch(id).status` is `ended`. Results are in any order; match them by `customId`. */
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

/** Custom ids of the Batches API: 1 to 64 letters, digits, `_` or `-`, unique within a batch. */
export const BATCH_CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/** At most this many requests per batch (the API's limit is higher; the platform never needs more). */
export const MAX_BATCH_REQUESTS = 1000;

type SdkMessage = {
  content: readonly { type: string; text?: string }[];
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null };
  model: string;
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

/** The Messages API parameters of one request, shared by `complete` and `createBatch`. */
export function messageParams(request: ClaudeRequest) {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: [{ type: "text" as const, text: request.system, cache_control: { type: "ephemeral" as const } }],
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    thinking: { type: "adaptive" as const },
    output_config: {
      effort: request.effort,
      ...(request.outputSchema ? { format: { type: "json_schema" as const, schema: request.outputSchema } } : {}),
    },
  };
}

/** Maps an API message to the platform's response; `structured` parses the text as JSON. */
export function responseOf(message: SdkMessage, structured: boolean): ClaudeResponse {
  const text = textOf(message.content);
  return {
    text,
    json: structured ? parseJson(text) : null,
    stopReason: message.stop_reason ?? "end_turn",
    refusalCategory: message.stop_reason === "refusal" ? (message.stop_details?.category ?? "unknown") : null,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    },
    model: message.model,
  };
}

type SdkBatchResult = {
  type: string;
  message?: SdkMessage;
  error?: { error?: { type?: string; message?: string } | null } | null;
};

/** The `error` text of a result that did not succeed. */
export function batchErrorOf(result: SdkBatchResult): string {
  if (result.type === "errored") {
    const inner = result.error?.error;
    return `errored:${inner?.type ?? "api_error"}${inner?.message ? `: ${inner.message.slice(0, 200)}` : ""}`;
  }
  return result.type;
}

/** Throws a permanent `IntegrationError` unless the items form a valid batch. */
export function assertBatchItems(items: readonly ClaudeBatchItem[], operation = "batches.create"): void {
  const invalid = (message: string) =>
    new IntegrationError({ provider: "anthropic", operation, retryable: false, statusCode: 400, message: `anthropic ${operation}: ${message}` });
  if (items.length === 0) throw invalid("no requests");
  if (items.length > MAX_BATCH_REQUESTS) throw invalid(`more than ${MAX_BATCH_REQUESTS} requests`);
  const seen = new Set<string>();
  for (const item of items) {
    if (!BATCH_CUSTOM_ID.test(item.customId)) throw invalid(`invalid custom_id ${JSON.stringify(item.customId.slice(0, 80))}`);
    if (seen.has(item.customId)) throw invalid(`duplicate custom_id ${item.customId}`);
    seen.add(item.customId);
  }
}

const batchState = (status: string): ClaudeBatch["status"] => (status === "ended" ? "ended" : status === "canceling" ? "canceling" : "in_progress");

/** A JSON object or array as the whole text: what structured output returns. */
const looksStructured = (text: string) => /^\s*[[{]/.test(text) && parseJson(text) !== null;

export function createClaudeClient(options: ClaudeClientOptions): ClaudeClient {
  const onCall = options.onCall ?? noopOnCall;
  const sdk = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 0,
    timeout: options.timeoutMs ?? 120_000,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  /** Which requests of the batches this process created asked for structured output. */
  const structuredByBatch = new Map<string, Map<string, boolean>>();

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
            const message = (await sdk.messages.create(messageParams(request))) as unknown as SdkMessage;
            return { statusCode: 200, value: responseOf(message, !!request.outputSchema) };
          } catch (error) {
            throw toIntegrationError(error, operation);
          }
        },
      );
    },

    async createBatch(items) {
      const operation = "batches.create";
      assertBatchItems(items, operation);
      const features = [...new Set(items.map((i) => i.request.feature))].sort();
      return trackCall(
        onCall,
        { provider: "anthropic", operation, requestDigest: digestRequest({ method: "POST", path: "/v1/messages/batches", params: { count: items.length, features } }) },
        async () => {
          try {
            const batch = await sdk.messages.batches.create({
              requests: items.map((item) => ({ custom_id: item.customId, params: messageParams(item.request) })),
            });
            structuredByBatch.set(batch.id, new Map(items.map((i) => [i.customId, !!i.request.outputSchema])));
            return { statusCode: 200, value: { id: batch.id, status: batchState(batch.processing_status) } };
          } catch (error) {
            throw toIntegrationError(error, operation);
          }
        },
      );
    },

    async getBatch(id) {
      const operation = "batches.retrieve";
      return trackCall(
        onCall,
        { provider: "anthropic", operation, requestDigest: digestRequest({ method: "GET", path: "/v1/messages/batches/:id", params: { id } }) },
        async () => {
          try {
            const batch = await sdk.messages.batches.retrieve(id);
            return { statusCode: 200, value: { id: batch.id, status: batchState(batch.processing_status) } };
          } catch (error) {
            throw toIntegrationError(error, operation);
          }
        },
      );
    },

    async getBatchResults(id) {
      const operation = "batches.results";
      return trackCall(
        onCall,
        { provider: "anthropic", operation, requestDigest: digestRequest({ method: "GET", path: "/v1/messages/batches/:id/results", params: { id } }) },
        async () => {
          try {
            // The collect job usually runs in a later invocation than the one that created the
            // batch: without the remembered flag, JSON-shaped text counts as structured output.
            const structured = structuredByBatch.get(id);
            const out: ClaudeBatchResult[] = [];
            for await (const entry of await sdk.messages.batches.results(id)) {
              const result = entry.result as unknown as SdkBatchResult;
              if (result.type === "succeeded" && result.message) {
                const asJson = structured?.get(entry.custom_id) ?? looksStructured(textOf(result.message.content));
                out.push({ customId: entry.custom_id, response: responseOf(result.message, asJson), error: null });
              } else {
                out.push({ customId: entry.custom_id, response: null, error: batchErrorOf(result) });
              }
            }
            return { statusCode: 200, value: out };
          } catch (error) {
            throw toIntegrationError(error, operation);
          }
        },
      );
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
