/**
 * The Claude fake (runbook section 1.5): scripted answers per `AI_FEATURES` key with
 * real-looking token counts, every call reported through `onCall` like the real client.
 * Tests can script answers and inject a refusal or a 529 overload; it never touches the network.
 */
import { randomUUID } from "node:crypto";
import { digestRequest } from "../_shared/digest";
import { IntegrationError } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type FakeCall, type OnCall } from "../_shared/types";
import { assertBatchItems, type ClaudeBatch, type ClaudeBatchItem, type ClaudeBatchResult, type ClaudeClient, type ClaudeRequest, type ClaudeResponse } from "./client";

/** A scripted answer: text (JSON is serialised), or a function of the request. */
export type ClaudeScript = string | Record<string, unknown> | ((request: ClaudeRequest) => string | Record<string, unknown>);

export type ClaudeFailure = "refusal" | "overloaded" | "rate_limited" | "bad_request" | "network";

/** The fake's answer to a question about revenue per customer: one row per person (ops' person links). */
export const FAKE_CUSTOMER_REVENUE_ANSWER = Object.freeze({
  sql:
    "select o.person_id, sum(o.total_cents) as revenue_cents from ai.orders o " +
    "where o.person_id is not null and o.paid_at >= date_trunc('year', now()) " +
    "group by o.person_id order by revenue_cents desc limit 20",
  explanation: "Paid revenue per customer this year, highest first.",
});

/** The fake's answer to any other question: revenue per day. */
export const FAKE_DAILY_REVENUE_ANSWER = Object.freeze({
  sql: "select day_on, sum(gross_cents) as revenue_cents from ai.revenue group by day_on order by day_on desc limit 7",
  explanation: "Revenue per day for the last seven days.",
});

/** Customers or people (en, nl, fr), and revenue or spending, in one question. */
const CUSTOMER_WORDS = /\b(customers?|clients?|persons?|people|members?|klanten?|personen|leden|lid|membres?)\b/i;
const REVENUE_WORDS = /\b(revenue|spen[dt]|sales|omzet|uitgegeven|opbrengst|chiffre d'affaires|revenus?|dépens)/i;

/**
 * `ai.answer_question` (ops rule 77): a question about revenue per customer gets a person-level
 * query over `ai.orders` (a `person_id` column, so the staff screen links each row), any other
 * question the daily revenue. Both of ops' calls (the SQL, then the explanation, whose payload
 * repeats the question) read the question from the last user message.
 */
function answerQuestionScript(request: ClaudeRequest): Record<string, unknown> {
  const text = request.messages.at(-1)?.content ?? "";
  const perCustomer = CUSTOMER_WORDS.test(text) && REVENUE_WORDS.test(text);
  return { ...(perCustomer ? FAKE_CUSTOMER_REVENUE_ANSWER : FAKE_DAILY_REVENUE_ANSWER) };
}

type FakeLocale = "nl-BE" | "fr-BE" | "en";
type FakeBase = {
  title: Partial<Record<FakeLocale, string>>;
  paths: Partial<Record<FakeLocale, string>>;
  blocks: Partial<Record<FakeLocale, Record<string, unknown>[]>>;
  seo: Partial<Record<FakeLocale, Record<string, unknown>>>;
  excerpt?: Partial<Record<FakeLocale, string>> | null;
  locales: FakeLocale[];
};
type FakeProposalPayload = { task?: string; sourceLocale?: FakeLocale; targetLocales?: FakeLocale[]; base?: FakeBase | null };

const FAKE_LOCALES: readonly FakeLocale[] = ["nl-BE", "fr-BE", "en"];
const fakeDoc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const FAQ_TEXT: Record<FakeLocale, { heading: string; question: string; answer: string }> = {
  "nl-BE": { heading: "Veelgestelde vragen", question: "Wanneer is BEAM open?", answer: "BEAM is elke dag open van 9 tot 22 uur." },
  "fr-BE": { heading: "Questions fréquentes", question: "Quand BEAM est-il ouvert ?", answer: "BEAM est ouvert tous les jours de 9 h à 22 h." },
  en: { heading: "Frequently asked questions", question: "When is BEAM open?", answer: "BEAM is open every day from 9 am to 10 pm." },
};
const NEW_PAGE: { title: Record<FakeLocale, string>; path: Record<FakeLocale, string>; body: Record<FakeLocale, string> } = {
  title: { "nl-BE": "Over BEAM", "fr-BE": "À propos de BEAM", en: "About BEAM" },
  path: { "nl-BE": "over-beam", "fr-BE": "a-propos-de-beam", en: "about-beam" },
  body: {
    "nl-BE": "BEAM Vitality Center helpt je sterker en fitter te worden.",
    "fr-BE": "BEAM Vitality Center vous aide à devenir plus fort et en meilleure forme.",
    en: "BEAM Vitality Center helps you become stronger and fitter.",
  },
};

/** The JSON payload of a `site.propose_page` user message (`Page and references (JSON):\n{...}\n\n...`), or null. */
function proposalPayload(request: ClaudeRequest): FakeProposalPayload | null {
  const text = request.messages.find((m) => m.role === "user")?.content ?? "";
  const match = /^Page and references \(JSON\):\n(.*?)\n\n/s.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as FakeProposalPayload;
  } catch {
    return null;
  }
}

/**
 * `site.propose_page`: a valid proposal for the request it answers. An edit keeps the base content
 * and appends an FAQ block to every target locale; a translation copies the source locale's blocks
 * (same ids, order and references) into the target locales; a new page (or a request without a
 * readable payload) gets a short "About BEAM" page in the three locales.
 */
function proposePageScript(request: ClaudeRequest): Record<string, unknown> {
  const payload = proposalPayload(request);
  const base = payload?.base ?? null;
  const targets = (payload?.targetLocales?.length ? payload.targetLocales : FAKE_LOCALES).filter((l) => FAKE_LOCALES.includes(l));
  if (!base) {
    const pick = <T>(f: (l: FakeLocale) => T) => Object.fromEntries(targets.map((l) => [l, f(l)]));
    return {
      title: pick((l) => NEW_PAGE.title[l]),
      paths: pick((l) => NEW_PAGE.path[l]),
      blocks: pick((l) => [{ id: randomUUID(), type: "rich_text", doc: fakeDoc(NEW_PAGE.body[l]) }]),
      seo: pick((l) => ({ title: `${NEW_PAGE.title[l]} | BEAM`, description: `${NEW_PAGE.body[l]} Sauna, pools and quiet rooms in Belgium.` })),
      changeSummary: "Wrote a short introduction page.",
    };
  }
  if (payload?.task === "translate_page") {
    const source = payload.sourceLocale ?? base.locales[0] ?? "nl-BE";
    const pick = <T>(f: (l: FakeLocale) => T) => Object.fromEntries(targets.map((l) => [l, f(l)]));
    return {
      title: pick((l) => `${base.title[source] ?? NEW_PAGE.title[l]} (${l})`),
      paths: pick((l) => `${base.paths[source] || NEW_PAGE.path[l]}-${l.slice(0, 2)}`),
      blocks: pick(() => base.blocks[source] ?? []),
      seo: pick(() => base.seo[source] ?? {}),
      changeSummary: `Added ${targets.join(", ")}.`,
    };
  }
  const locales = FAKE_LOCALES.filter((l) => base.locales.includes(l) || targets.includes(l));
  const blocks = Object.fromEntries(
    locales.map((l) => {
      const kept = base.blocks[l] ?? [];
      if (!targets.includes(l)) return [l, kept];
      const faq = FAQ_TEXT[l];
      return [l, [...kept, { id: randomUUID(), type: "faq", heading: faq.heading, items: [{ question: faq.question, answer: fakeDoc(faq.answer) }] }]];
    }),
  );
  return {
    title: Object.fromEntries(locales.map((l) => [l, base.title[l] ?? NEW_PAGE.title[l]])),
    paths: Object.fromEntries(locales.map((l) => [l, base.paths[l] ?? NEW_PAGE.path[l]])),
    blocks,
    seo: Object.fromEntries(locales.flatMap((l) => (base.seo[l] ? [[l, base.seo[l]]] : []))),
    ...(base.excerpt ? { excerpt: base.excerpt } : {}),
    changeSummary: "Added an FAQ about the opening hours at the end of the page.",
  };
}

/** Default answers, one per feature, shaped like each feature's output. */
export const DEFAULT_CLAUDE_SCRIPTS: Readonly<Record<string, ClaudeScript>> = {
  "site.propose_page": (request) => proposePageScript(request),
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
  "ai.answer_question": (request) => answerQuestionScript(request),
  "site.audit_content": { issues: [] },
};

export type ClaudeFake = ClaudeClient & {
  /** Every `complete` call, in order. */
  readonly calls: FakeCall<ClaudeRequest>[];
  /** Replace the answer for a feature (until `reset`). */
  script(feature: string, answer: ClaudeScript): void;
  /** The next call fails this way (tests only). Also applies to the next `createBatch`. */
  failNext(kind: ClaudeFailure): void;
  /** Every batch created, in order, with its requests (R4). */
  readonly batches: FakeBatch[];
  /**
   * Batches created from now on stay `in_progress` for this many `getBatch` polls before they
   * end (default 0: the first poll reports `ended`), so a collect job's re-enqueue can be tested.
   */
  holdBatches(polls: number): void;
  /** The batch request with this `customId` does not succeed (`refusal` succeeds with a refusal stop). */
  failBatchItem(customId: string, kind: ClaudeBatchItemFailure): void;
  reset(): void;
};

/** How one batch request ends when it does not succeed normally. */
export type ClaudeBatchItemFailure = "refusal" | "errored" | "expired" | "canceled";

export type FakeBatch = { id: string; items: readonly ClaudeBatchItem[]; polled: number; holdPolls: number; at: Date };

/** About four characters per token, as for English and Dutch text. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Fisher-Yates on a copy: the Batches API returns results in any order. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function createClaudeFake(options: { onCall?: OnCall; now?: () => Date; random?: () => number } = {}): ClaudeFake {
  const onCall = options.onCall ?? noopOnCall;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const scripts = new Map<string, ClaudeScript>();
  const failures: ClaudeFailure[] = [];
  const calls: FakeCall<ClaudeRequest>[] = [];
  const batches: FakeBatch[] = [];
  const itemFailures = new Map<string, ClaudeBatchItemFailure>();
  let holdPolls = 0;
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

  const fail = (kind: ClaudeFailure, operation = "messages.create"): IntegrationError => {
    const table = {
      overloaded: { statusCode: 529, retryable: true, message: `anthropic ${operation} failed with 529: overloaded` },
      rate_limited: { statusCode: 429, retryable: true, message: `anthropic ${operation} failed with 429: rate limited` },
      bad_request: { statusCode: 400, retryable: false, message: `anthropic ${operation} failed with 400: invalid request` },
      network: { statusCode: undefined, retryable: true, message: `anthropic ${operation}: connection reset` },
    } as const;
    const row = table[kind as keyof typeof table];
    return new IntegrationError({
      provider: "anthropic",
      operation,
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
    batches,
    holdBatches(polls) {
      holdPolls = Math.max(0, Math.floor(polls));
    },
    failBatchItem(customId, kind) {
      itemFailures.set(customId, kind);
    },
    reset() {
      scripts.clear();
      failures.length = 0;
      calls.length = 0;
      batches.length = 0;
      itemFailures.clear();
      holdPolls = 0;
    },
    createBatch(items): Promise<ClaudeBatch> {
      const operation = "batches.create";
      const failure = failures.shift();
      const features = [...new Set(items.map((i) => i.request.feature))].sort();
      return trackCall(
        onCall,
        { provider: "anthropic", operation, requestDigest: digestRequest({ method: "POST", path: "/v1/messages/batches", params: { count: items.length, features } }) },
        () => {
          if (failure && failure !== "refusal") throw fail(failure, operation);
          assertBatchItems(items, operation);
          const id = `fake_batch_${++batchSeq}`;
          batches.push({ id, items: [...items], polled: 0, holdPolls, at: now() });
          return { value: { id, status: "in_progress" as const }, statusCode: 200 };
        },
      );
    },
    getBatch(id): Promise<ClaudeBatch> {
      const operation = "batches.retrieve";
      return trackCall(
        onCall,
        { provider: "anthropic", operation, requestDigest: digestRequest({ method: "GET", path: "/v1/messages/batches/:id", params: { id } }) },
        () => {
          const batch = batches.find((b) => b.id === id);
          if (!batch) throw notFound(operation);
          batch.polled += 1;
          return { value: { id, status: batch.polled > batch.holdPolls ? ("ended" as const) : ("in_progress" as const) }, statusCode: 200 };
        },
      );
    },
    getBatchResults(id): Promise<ClaudeBatchResult[]> {
      const operation = "batches.results";
      return trackCall(
        onCall,
        { provider: "anthropic", operation, requestDigest: digestRequest({ method: "GET", path: "/v1/messages/batches/:id/results", params: { id } }) },
        () => {
          const batch = batches.find((b) => b.id === id);
          if (!batch) throw notFound(operation);
          if (batch.polled <= batch.holdPolls) {
            throw new IntegrationError({ provider: "anthropic", operation, retryable: true, statusCode: 409, message: `anthropic ${operation} failed with 409: batch still in progress` });
          }
          const results = batch.items.map((item): ClaudeBatchResult => {
            const failure = itemFailures.get(item.customId);
            if (failure === "refusal") return { customId: item.customId, response: respond(item.request, "refusal"), error: null };
            if (failure === "errored") return { customId: item.customId, response: null, error: "errored:overloaded_error: Overloaded" };
            if (failure) return { customId: item.customId, response: null, error: failure };
            return { customId: item.customId, response: respond(item.request, undefined), error: null };
          });
          return { value: shuffled(results, random), statusCode: 200 };
        },
      );
    },
  };
}

const notFound = (operation: string) =>
  new IntegrationError({ provider: "anthropic", operation, retryable: false, statusCode: 404, message: `anthropic ${operation} failed with 404: batch not found` });
