/**
 * The Claude fake (runbook section 1.5): scripted answers per `AI_FEATURES` key with
 * real-looking token counts, every call reported through `onCall` like the real client.
 * Tests can script answers and inject a refusal or a 529 overload; it never touches the network.
 */
import { digestRequest } from "../_shared/digest";
import { IntegrationError } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type FakeCall, type OnCall } from "../_shared/types";
import type { ClaudeBatch, ClaudeBatchItem, ClaudeBatchResult, ClaudeClient, ClaudeRequest, ClaudeResponse } from "./client";

/** A scripted answer: text (JSON is serialised), or a function of the request. */
export type ClaudeScript = string | Record<string, unknown> | ((request: ClaudeRequest) => string | Record<string, unknown>);

export type ClaudeFailure = "refusal" | "overloaded" | "rate_limited" | "bad_request" | "network";

/** Default answers, one per feature, shaped like each feature's output. */
export const DEFAULT_CLAUDE_SCRIPTS: Readonly<Record<string, ClaudeScript>> = {
  "site.propose_page": {
    title: { "nl-BE": "Over BEAM", "fr-BE": "À propos de BEAM", en: "About BEAM" },
    summary: "Shorter introduction, clearer call to action.",
    blocks: [
      {
        type: "text",
        body: {
          "nl-BE": "BEAM Vitality Center helpt je sterker en fitter te worden.",
          "fr-BE": "BEAM Vitality Center vous aide à devenir plus fort et en meilleure forme.",
          en: "BEAM Vitality Center helps you become stronger and fitter.",
        },
      },
    ],
  },
  "ai.classify": { topic: "booking", urgency: "normal", confidence: 0.82 },
  "ai.draft_email": {
    subject: { "nl-BE": "Nieuw dit najaar", "fr-BE": "Nouveau cet automne", en: "New this autumn" },
    blocks: [{ type: "text", body: { "nl-BE": "Ontdek ons nieuwe aanbod.", "fr-BE": "Découvrez notre nouvelle offre.", en: "Discover our new classes." } }],
  },
  "ai.draft_reply": "Thank you for your message. You can book your next session in the portal; we are happy to help if anything is unclear.",
  "ai.weekly_summary": {
    headline: "Bookings up 4 % on last week",
    points: ["Occupancy 78 %", "12 new members", "Two classes waitlisted on Thursday"],
  },
  "ai.answer_question": {
    sql: "select day_on, sum(revenue_cents) as revenue_cents from ai.revenue group by day_on order by day_on desc limit 7",
    explanation: "Revenue per day for the last seven days.",
  },
  "site.audit_content": { issues: [] },
};

export type ClaudeFake = ClaudeClient & {
  /** Every `complete` call, in order. */
  readonly calls: FakeCall<ClaudeRequest>[];
  /** Replace the answer for a feature (until `reset`). */
  script(feature: string, answer: ClaudeScript): void;
  /** The next call fails this way (tests only). */
  failNext(kind: ClaudeFailure): void;
  reset(): void;
};

/** About four characters per token, as for English and Dutch text. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function createClaudeFake(options: { onCall?: OnCall; now?: () => Date } = {}): ClaudeFake {
  const onCall = options.onCall ?? noopOnCall;
  const now = options.now ?? (() => new Date());
  const scripts = new Map<string, ClaudeScript>();
  const failures: ClaudeFailure[] = [];
  const calls: FakeCall<ClaudeRequest>[] = [];
  const batches = new Map<string, { items: readonly ClaudeBatchItem[]; polled: number }>();
  let batchSeq = 0;

  const answer = (request: ClaudeRequest): string => {
    const script = scripts.get(request.feature) ?? DEFAULT_CLAUDE_SCRIPTS[request.feature] ?? "OK";
    const value = typeof script === "function" ? script(request) : script;
    return typeof value === "string" ? value : JSON.stringify(value);
  };

  const respond = (request: ClaudeRequest, failure: ClaudeFailure | undefined): ClaudeResponse => {
    const prompt = request.system + request.messages.map((m) => m.content).join("\n");
    const systemTokens = estimateTokens(request.system);
    const cacheReadTokens = calls.filter((c) => c.input.system === request.system).length > 1 ? systemTokens : 0;
    const inputTokens = estimateTokens(prompt) - cacheReadTokens + 3 * request.messages.length;
    if (failure === "refusal") {
      return {
        text: "",
        json: null,
        stopReason: "refusal",
        refusalCategory: "general_harms",
        usage: { inputTokens, outputTokens: 0, cacheReadTokens },
        model: request.model,
      };
    }
    const text = answer(request);
    let json: unknown = null;
    if (request.outputSchema) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    return {
      text,
      json,
      stopReason: "end_turn",
      refusalCategory: null,
      usage: { inputTokens, outputTokens: estimateTokens(text) + 40, cacheReadTokens },
      model: request.model,
    };
  };

  const fail = (kind: ClaudeFailure): IntegrationError => {
    const table = {
      overloaded: { statusCode: 529, retryable: true, message: "anthropic messages.create failed with 529: overloaded" },
      rate_limited: { statusCode: 429, retryable: true, message: "anthropic messages.create failed with 429: rate limited" },
      bad_request: { statusCode: 400, retryable: false, message: "anthropic messages.create failed with 400: invalid request" },
      network: { statusCode: undefined, retryable: true, message: "anthropic messages.create: connection reset" },
    } as const;
    const row = table[kind as keyof typeof table];
    return new IntegrationError({
      provider: "anthropic",
      operation: "messages.create",
      retryable: row.retryable,
      message: row.message,
      ...(row.statusCode === undefined ? { code: "network" } : { statusCode: row.statusCode }),
    });
  };

  const complete = (request: ClaudeRequest): Promise<ClaudeResponse> => {
    calls.push({ operation: "messages.create", input: request, at: now() });
    const failure = failures.shift();
    return trackCall(
      onCall,
      {
        provider: "anthropic",
        operation: "messages.create",
        requestDigest: digestRequest({ method: "POST", path: "/v1/messages", params: { model: request.model, feature: request.feature } }),
      },
      () => {
        if (failure && failure !== "refusal") throw fail(failure);
        return { value: respond(request, failure), statusCode: 200 };
      },
    );
  };

  return {
    calls,
    complete,
    script(feature, value) {
      scripts.set(feature, value);
    },
    failNext(kind) {
      failures.push(kind);
    },
    reset() {
      scripts.clear();
      failures.length = 0;
      calls.length = 0;
      batches.clear();
    },
    createBatch(items): Promise<ClaudeBatch> {
      const id = `fake_batch_${++batchSeq}`;
      batches.set(id, { items, polled: 0 });
      return Promise.resolve({ id, status: "in_progress" });
    },
    getBatch(id): Promise<ClaudeBatch> {
      const batch = batches.get(id);
      if (!batch) return Promise.reject(new IntegrationError({ provider: "anthropic", operation: "batches.get", retryable: false, statusCode: 404, message: "batch not found" }));
      batch.polled += 1;
      return Promise.resolve({ id, status: batch.polled >= 1 ? "ended" : "in_progress" });
    },
    getBatchResults(id): Promise<ClaudeBatchResult[]> {
      const batch = batches.get(id);
      if (!batch) return Promise.reject(new IntegrationError({ provider: "anthropic", operation: "batches.results", retryable: false, statusCode: 404, message: "batch not found" }));
      return Promise.resolve(batch.items.map((item) => ({ customId: item.customId, response: respond(item.request, undefined), error: null })));
    },
  };
}
