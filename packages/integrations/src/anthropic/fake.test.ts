import { describe, expect, it } from "vitest";
import { AI_FEATURE_KEYS } from "@beam/core/ai";
import { IntegrationError, isPermanentFailure, type IntegrationCallEntry } from "../_shared";
import type { ClaudeRequest } from "./client";
import { createClaudeFake, DEFAULT_CLAUDE_SCRIPTS } from "./fake";

const request = (feature: string, extra: Partial<ClaudeRequest> = {}): ClaudeRequest => ({
  feature,
  model: "claude-opus-5-5",
  system: "You are BEAM's assistant. Answer in the requested locale.",
  messages: [{ role: "user", content: "Draft something useful for the team." }],
  maxTokens: 2000,
  effort: "medium",
  ...extra,
});

describe("createClaudeFake", () => {
  it("has a scripted answer for every AI_FEATURES key", () => {
    for (const key of AI_FEATURE_KEYS) expect(DEFAULT_CLAUDE_SCRIPTS[key], key).toBeDefined();
  });

  it("answers per feature, parses JSON for structured output and reports real-looking token counts", async () => {
    const fake = createClaudeFake();
    const res = await fake.complete(request("site.propose_page", { outputSchema: { type: "object" } }));
    expect(res.stopReason).toBe("end_turn");
    expect(res.json).toMatchObject({ title: { en: "About BEAM" } });
    expect(res.usage.inputTokens).toBeGreaterThan(10);
    expect(res.usage.outputTokens).toBeGreaterThan(40);
    expect(res.model).toBe("claude-opus-5-5");

    const reply = await fake.complete(request("ai.draft_reply"));
    expect(reply.text).toMatch(/^Thank you/);
    expect(reply.json).toBeNull();
  });

  it("reads the stable system prompt from the cache on repeated calls", async () => {
    const fake = createClaudeFake();
    const first = await fake.complete(request("ai.classify"));
    const second = await fake.complete(request("ai.classify"));
    expect(first.usage.cacheReadTokens).toBe(0);
    expect(second.usage.cacheReadTokens).toBeGreaterThan(0);
    expect(second.usage.inputTokens).toBeLessThan(first.usage.inputTokens);
  });

  it("lets tests script answers, also as a function of the request", async () => {
    const fake = createClaudeFake();
    fake.script("ai.classify", (r) => ({ topic: r.messages[0]?.content.includes("invoice") ? "billing" : "other" }));
    const res = await fake.complete(request("ai.classify", { outputSchema: {}, messages: [{ role: "user", content: "about my invoice" }] }));
    expect(res.json).toEqual({ topic: "billing" });
    fake.reset();
    expect(fake.calls).toHaveLength(0);
  });

  it("simulates a refusal as a response with its category and usage", async () => {
    const fake = createClaudeFake();
    fake.failNext("refusal");
    const res = await fake.complete(request("ai.draft_email"));
    expect(res).toMatchObject({ stopReason: "refusal", refusalCategory: "general_harms", text: "" });
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    // The failure is used once.
    expect((await fake.complete(request("ai.draft_email"))).stopReason).toBe("end_turn");
  });

  it("simulates 529 overloaded as a retryable IntegrationError, and 400 as permanent", async () => {
    const fake = createClaudeFake();
    fake.failNext("overloaded");
    const overloaded = await fake.complete(request("ai.classify")).catch((e: unknown) => e);
    expect(overloaded).toBeInstanceOf(IntegrationError);
    expect(overloaded).toMatchObject({ provider: "anthropic", statusCode: 529, retryable: true });
    expect(isPermanentFailure(overloaded)).toBe(false);

    fake.failNext("bad_request");
    const bad = await fake.complete(request("ai.classify")).catch((e: unknown) => e);
    expect(bad).toMatchObject({ statusCode: 400, retryable: false });
    expect(isPermanentFailure(bad)).toBe(true);
  });

  it("reports every call through onCall without bodies", async () => {
    const entries: IntegrationCallEntry[] = [];
    const fake = createClaudeFake({ onCall: (e) => void entries.push(e) });
    await fake.complete(request("ai.classify"));
    fake.failNext("overloaded");
    await fake.complete(request("ai.classify")).catch(() => undefined);
    expect(entries.map((e) => [e.operation, e.ok, e.statusCode])).toEqual([
      ["messages.create", true, 200],
      ["messages.create", false, 529],
    ]);
    expect(entries[0]!.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(entries)).not.toContain("Draft something useful");
  });

  it("supports the R4 batch flow", async () => {
    const fake = createClaudeFake();
    const batch = await fake.createBatch([{ customId: "week-45", request: request("ai.weekly_summary", { outputSchema: {} }) }]);
    expect((await fake.getBatch(batch.id)).status).toBe("ended");
    const [result] = await fake.getBatchResults(batch.id);
    expect(result).toMatchObject({ customId: "week-45", error: null });
    expect(result!.response?.json).toMatchObject({ headline: expect.any(String) });
  });
});
