import { describe, expect, it } from "vitest";
import { IntegrationError, isPermanentFailure, type IntegrationCallEntry } from "../_shared";
import { createClaudeClient, type ClaudeBatchItem, type ClaudeRequest } from "./client";
import { createClaudeFake } from "./fake";

const request = (feature: string, content: string, extra: Partial<ClaudeRequest> = {}): ClaudeRequest => ({
  feature,
  model: "claude-opus-5-5",
  system: "Summarise the week's aggregates for the team.",
  messages: [{ role: "user", content }],
  maxTokens: 1500,
  effort: "medium",
  ...extra,
});

const items: ClaudeBatchItem[] = ["nl-BE", "fr-BE", "en", "summary-x", "summary-y", "summary-z"].map((customId) => ({
  customId: customId.replace(/[^a-zA-Z0-9_-]/g, "_"),
  request: request("ai.weekly_summary", `Locale ${customId}`, { outputSchema: { type: "object" } }),
}));

describe("Claude fake: Message Batches (platform-P10)", () => {
  it("returns results in random order keyed by custom_id, each the scripted answer", async () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const fake = createClaudeFake({ random });
    const batch = await fake.createBatch(items);
    expect(batch.status).toBe("in_progress");
    expect((await fake.getBatch(batch.id)).status).toBe("ended");
    const results = await fake.getBatchResults(batch.id);
    expect(results.map((r) => r.customId).sort()).toEqual(items.map((i) => i.customId).sort());
    expect(results.map((r) => r.customId)).not.toEqual(items.map((i) => i.customId));
    for (const r of results) {
      expect(r.error).toBeNull();
      expect(r.response?.json).toMatchObject({ headline: expect.any(String) });
      expect(r.response?.usage.outputTokens).toBeGreaterThan(40);
    }
    // Batch requests are not `complete` calls.
    expect(fake.calls).toHaveLength(0);
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0]!.items).toHaveLength(items.length);
  });

  it("orders vary between calls with the default random source", async () => {
    const fake = createClaudeFake();
    const batch = await fake.createBatch(items);
    await fake.getBatch(batch.id);
    const orders = new Set<string>();
    for (let i = 0; i < 20; i++) orders.add((await fake.getBatchResults(batch.id)).map((r) => r.customId).join(","));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("holdBatches keeps a batch in progress for the given polls; results before the end are a retryable 409", async () => {
    const fake = createClaudeFake();
    fake.holdBatches(2);
    const batch = await fake.createBatch(items.slice(0, 2));
    expect((await fake.getBatch(batch.id)).status).toBe("in_progress");
    const early = await fake.getBatchResults(batch.id).catch((e: unknown) => e);
    expect(early).toBeInstanceOf(IntegrationError);
    expect(early).toMatchObject({ statusCode: 409, retryable: true });
    expect((await fake.getBatch(batch.id)).status).toBe("in_progress");
    expect((await fake.getBatch(batch.id)).status).toBe("ended");
    expect(await fake.getBatchResults(batch.id)).toHaveLength(2);
    fake.reset();
    const next = await fake.createBatch(items.slice(0, 1));
    expect((await fake.getBatch(next.id)).status).toBe("ended");
  });

  it("scripts per-item failures: refusal, errored and expired", async () => {
    const fake = createClaudeFake();
    fake.failBatchItem("nl-BE", "refusal");
    fake.failBatchItem("fr-BE", "errored");
    fake.failBatchItem("en", "expired");
    const batch = await fake.createBatch(items.slice(0, 4));
    await fake.getBatch(batch.id);
    const byId = new Map((await fake.getBatchResults(batch.id)).map((r) => [r.customId, r]));
    expect(byId.get("nl-BE")?.response).toMatchObject({ stopReason: "refusal", refusalCategory: "general_harms" });
    expect(byId.get("fr-BE")).toMatchObject({ response: null, error: expect.stringMatching(/^errored:/) });
    expect(byId.get("en")).toMatchObject({ response: null, error: "expired" });
    expect(byId.get("summary-x")?.error).toBeNull();
  });

  it("rejects empty batches, invalid and duplicate custom ids as permanent; unknown ids are 404", async () => {
    const fake = createClaudeFake();
    for (const bad of [[], [{ customId: "has space", request: items[0]!.request }], [items[0]!, items[0]!]]) {
      const error = await fake.createBatch(bad).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IntegrationError);
      expect(isPermanentFailure(error)).toBe(true);
    }
    expect(await fake.getBatch("nope").catch((e: unknown) => e)).toMatchObject({ statusCode: 404, retryable: false });
    expect(await fake.getBatchResults("nope").catch((e: unknown) => e)).toMatchObject({ statusCode: 404 });
  });

  it("failNext applies to createBatch, and every batch operation is reported through onCall without bodies", async () => {
    const entries: IntegrationCallEntry[] = [];
    const fake = createClaudeFake({ onCall: (e) => void entries.push(e) });
    fake.failNext("overloaded");
    const overloaded = await fake.createBatch(items).catch((e: unknown) => e);
    expect(overloaded).toMatchObject({ operation: "batches.create", statusCode: 529, retryable: true });
    const batch = await fake.createBatch(items);
    await fake.getBatch(batch.id);
    await fake.getBatchResults(batch.id);
    expect(entries.map((e) => [e.operation, e.ok])).toEqual([
      ["batches.create", false],
      ["batches.create", true],
      ["batches.retrieve", true],
      ["batches.results", true],
    ]);
    expect(JSON.stringify(entries)).not.toContain("Locale nl-BE");
  });
});

/** A `fetch` that answers the Batches endpoints like the API, recording each request. */
function batchApi() {
  const seen: { method: string; path: string; body: unknown }[] = [];
  const message = (text: string) => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 80, cache_read_input_tokens: 30 },
  });
  const batch = (status: string) => ({
    id: "msgbatch_01",
    type: "message_batch",
    processing_status: status,
    request_counts: { processing: 0, succeeded: 2, errored: 1, canceled: 0, expired: 0 },
    created_at: "2026-11-02T06:00:00Z",
    ended_at: status === "ended" ? "2026-11-02T06:10:00Z" : null,
    expires_at: "2026-11-03T06:00:00Z",
    archived_at: null,
    cancel_initiated_at: null,
    results_url: status === "ended" ? "https://api.anthropic.test/v1/messages/batches/msgbatch_01/results" : null,
  });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const answer = (input: string | URL | Request, init?: RequestInit): Response => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    seen.push({ method, path: url.pathname, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null });
    if (method === "POST" && url.pathname === "/v1/messages/batches") return json(batch("in_progress"));
    if (method === "GET" && url.pathname === "/v1/messages/batches/msgbatch_01") return json(batch("ended"));
    if (method === "GET" && url.pathname === "/v1/messages/batches/msgbatch_01/results") {
      const lines = [
        { custom_id: "en", result: { type: "succeeded", message: message('{"headline":"Busy week"}') } },
        { custom_id: "fr-BE", result: { type: "errored", error: { type: "error", request_id: null, error: { type: "overloaded_error", message: "Overloaded" } } } },
        { custom_id: "nl-BE", result: { type: "succeeded", message: message("Plain text") } },
      ];
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { status: 200, headers: { "content-type": "application/binary" } });
    }
    if (url.pathname === "/v1/messages/batches/missing") return json({ type: "error", error: { type: "not_found_error", message: "not found" } }, 404);
    return json({ type: "error", error: { type: "api_error", message: "unexpected" } }, 500);
  };
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => Promise.resolve(answer(input, init));
  return { seen, fetchFn };
}

describe("Claude client: Message Batches (platform-P10)", () => {
  it("creates a batch with the Messages parameters per custom_id, polls it and maps its results", async () => {
    const api = batchApi();
    const entries: IntegrationCallEntry[] = [];
    const client = createClaudeClient({ apiKey: "test-key", fetch: api.fetchFn, baseURL: "https://api.anthropic.test", onCall: (e) => void entries.push(e) });
    const created = await client.createBatch([
      { customId: "nl-BE", request: request("ai.weekly_summary", "nl") },
      { customId: "en", request: request("ai.weekly_summary", "en", { outputSchema: { type: "object" } }) },
    ]);
    expect(created).toEqual({ id: "msgbatch_01", status: "in_progress" });
    const body = api.seen[0]!.body as { requests: { custom_id: string; params: Record<string, unknown> }[] };
    expect(body.requests.map((r) => r.custom_id)).toEqual(["nl-BE", "en"]);
    expect(body.requests[0]!.params).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 1500,
      system: [{ type: "text", cache_control: { type: "ephemeral" } }],
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
    expect(body.requests[1]!.params).toMatchObject({ output_config: { format: { type: "json_schema" } } });

    expect(await client.getBatch("msgbatch_01")).toEqual({ id: "msgbatch_01", status: "ended" });
    const results = await client.getBatchResults("msgbatch_01");
    const byId = new Map(results.map((r) => [r.customId, r]));
    expect(byId.get("en")?.response).toMatchObject({ json: { headline: "Busy week" }, usage: { inputTokens: 120, outputTokens: 80, cacheReadTokens: 30 } });
    expect(byId.get("nl-BE")?.response).toMatchObject({ text: "Plain text", json: null });
    expect(byId.get("fr-BE")).toEqual({ customId: "fr-BE", response: null, error: "errored:overloaded_error: Overloaded" });
    expect(entries.map((e) => [e.operation, e.ok])).toEqual([
      ["batches.create", true],
      ["batches.retrieve", true],
      ["batches.results", true],
    ]);
    expect(JSON.stringify(entries)).not.toContain("test-key");
  });

  it("maps a 404 to a permanent IntegrationError and refuses invalid items before any request", async () => {
    const api = batchApi();
    const client = createClaudeClient({ apiKey: "test-key", fetch: api.fetchFn, baseURL: "https://api.anthropic.test" });
    const missing = await client.getBatch("missing").catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(IntegrationError);
    expect(isPermanentFailure(missing)).toBe(true);
    const before = api.seen.length;
    const invalid = await client.createBatch([{ customId: "a/b", request: request("ai.weekly_summary", "x") }]).catch((e: unknown) => e);
    expect(isPermanentFailure(invalid)).toBe(true);
    expect(api.seen.length).toBe(before);
  });
});
