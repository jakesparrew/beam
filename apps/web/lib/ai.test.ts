import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDb } from "@beam/db/testing";
import { enqueue, type DbHandle } from "@beam/db";
import { aiRequests, jobs } from "@beam/db/schema";
import { PermanentError, RetryableError } from "@beam/core/errors";

vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const original = (await importOriginal()) as { JOB_BY_KIND: Record<string, unknown> };
  const { z: zod } = await import("zod");
  const { callClaude: call } = await import("@/lib/ai");
  return {
    ...original,
    JOB_BY_KIND: {
      ...original.JOB_BY_KIND,
      "test.ai": {
        kind: "test.ai",
        lane: "fast",
        priority: 5,
        maxAttempts: 6,
        timeoutMs: 5000,
        inline: false,
        input: zod.object({}),
        run: (ctx: never) => call(ctx, { feature: "site.propose_page", model: "opus", system: "You edit pages.", messages: [{ role: "user", content: "Shorter" }], fieldsSent: [] }),
      },
    },
  };
});

import { callClaude } from "./ai";
import { eq, sql } from "./ctx";
import { runJobs } from "./job-runner";
import { setSetting, getSetting } from "./settings";
import { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime } from "./testing";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  await handle.db.execute(sql`set beam.allow_rewrite = 'on'`);
  await handle.db.execute(sql`delete from ai_requests`);
  await handle.db.execute(sql`reset beam.allow_rewrite`);
  await handle.db.execute(sql`delete from jobs`);
  await handle.db.execute(sql`delete from settings`);
  await handle.db.execute(sql`delete from rate_limits`);
});

const req = (over: Partial<Parameters<typeof callClaude>[1]> = {}) => ({
  feature: "ai.classify" as const,
  model: "haiku" as const,
  system: "Classify the message.",
  messages: [{ role: "user" as const, content: "When can I book a sauna?" }],
  fieldsSent: ["locale", "status"],
  ...over,
});
const rows = () => handle.db.select().from(aiRequests);

async function setAi(patch: Record<string, unknown>) {
  const ctx = makeCtx(handle.db);
  const current = await getSetting(handle.db, "ai");
  const version = Number(((await handle.db.execute(sql`select coalesce(max(version), 0) as v from settings where key = 'ai'`)) as unknown as { rows: { v: number }[] }).rows[0]!.v);
  await setSetting(ctx, "ai", { ...current, ...patch } as typeof current, version);
}

describe("callClaude", () => {
  it("calls the fake, logs one ok row with tokens and cost (PL-57)", async () => {
    const integrations = createFakeIntegrations();
    const ctx = makeJobCtx(handle.db, "platform.check_alerts", { integrations });
    const out = await callClaude(ctx, { ...req(), outputSchema: z.object({ topic: z.string(), urgency: z.string(), confidence: z.number() }) });
    expect(out.parsed).toEqual({ topic: "booking", urgency: "normal", confidence: 0.82 });
    expect(integrations.anthropic.calls).toHaveLength(1);
    expect(integrations.anthropic.calls[0]!.input).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
    const [row] = await rows();
    expect(row).toMatchObject({ id: out.aiRequestId, status: "ok", model: "claude-haiku-5-5", feature: "ai.classify", fieldsSent: ["locale", "status"], jobId: ctx.job.id });
    const expected = (row!.inputTokens * 10 + row!.outputTokens * 50 + row!.cacheReadTokens * 1) / 1_000_000;
    expect(Number(row!.costCents)).toBeCloseTo(expected, 4);
    expect(row!.actor).toEqual({ kind: "job", id: ctx.job.id });
  });

  it("a field outside the allow-list is not sent: error row and PermanentError (PL-53)", async () => {
    const integrations = createFakeIntegrations();
    const ctx = makeJobCtx(handle.db, "platform.check_alerts", { integrations });
    await expect(callClaude(ctx, req({ fieldsSent: ["email"] }))).rejects.toThrow(/field_not_allowed/);
    expect(integrations.anthropic.calls).toHaveLength(0);
    expect(await rows()).toMatchObject([{ status: "error", error: "field_not_allowed" }]);
  });

  it("a sensitive key is blocked while sensitive processing is off (PL-54, scenario 6)", async () => {
    const integrations = createFakeIntegrations();
    const ctx = makeJobCtx(handle.db, "platform.check_alerts", { integrations });
    await expect(callClaude(ctx, req({ fieldsSent: ["locale", "health_note"] }))).rejects.toBeInstanceOf(PermanentError);
    expect(integrations.anthropic.calls).toHaveLength(0);
    const [row] = await rows();
    expect(row).toMatchObject({ status: "error", error: "sensitive_not_allowed", prompt: "[not sent]" });
    // Even switched on, no V1-R4 feature allows sensitive fields.
    await setAi({ sensitive_enabled: true });
    await expect(callClaude(ctx, req({ fieldsSent: ["sleep"] }))).rejects.toThrow(/sensitive_not_allowed/);
  });

  it("an unknown feature is a PermanentError (PL-52)", async () => {
    const ctx = makeJobCtx(handle.db, "platform.check_alerts");
    await expect(callClaude(ctx, req({ feature: "ai.horoscope" as never }))).rejects.toThrow(/unknown_ai_feature/);
  });

  it("a refusal is permanent and logged as refusal:<category> (PL-59)", async () => {
    const integrations = createFakeIntegrations();
    integrations.anthropic.failNext("refusal");
    const ctx = makeJobCtx(handle.db, "platform.check_alerts", { integrations });
    await expect(callClaude(ctx, req())).rejects.toThrow(/refusal:general_harms/);
    expect(await rows()).toMatchObject([{ status: "error", error: "refusal:general_harms" }]);
  });

  it("invalid structured output retries once, then is permanent (edge case 21)", async () => {
    const integrations = createFakeIntegrations();
    integrations.anthropic.script("ai.classify", "not json");
    const schema = z.object({ topic: z.string() });
    await expect(callClaude(makeJobCtx(handle.db, "platform.check_alerts", { integrations, attempt: 1 }), { ...req(), outputSchema: schema })).rejects.toBeInstanceOf(RetryableError);
    await expect(callClaude(makeJobCtx(handle.db, "platform.check_alerts", { integrations, attempt: 2 }), { ...req(), outputSchema: schema })).rejects.toBeInstanceOf(PermanentError);
  });

  it("over budget: a budget_exceeded row, and the job goes dead with reason budget (PL-56)", async () => {
    await setAi({ monthly_budget_cents: 1 });
    await handle.db.insert(aiRequests).values({ feature: "ai.classify", model: "claude-haiku-5-5", actor: { kind: "system", id: null }, prompt: "x", status: "ok", costCents: "1" });
    const { id } = await enqueue(handle.db, { kind: "test.ai", payload: {}, key: "ai:1" });
    await runJobs({ budgetMs: 5000, db: handle.db, integrations: createFakeIntegrations() });
    const [job] = await handle.db.select().from(jobs).where(eq(jobs.id, id));
    expect(job).toMatchObject({ status: "dead" });
    expect(job!.lastError).toContain("budget");
    const logged = await handle.db.select().from(aiRequests).where(eq(aiRequests.status, "budget_exceeded"));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.jobId).toBe(id);
  });

  it("the daily cap is 100 calls outside production", async () => {
    const values = Array.from({ length: 100 }, () => ({ feature: "ai.classify", model: "claude-haiku-5-5", actor: { kind: "system" as const, id: null }, prompt: "x", status: "ok" as const }));
    await handle.db.insert(aiRequests).values(values);
    await expect(callClaude(makeJobCtx(handle.db, "platform.check_alerts"), req())).rejects.toThrow(/budget/);
  });

  it("crossing 80 % of the budget enqueues exactly one Slack job per month", async () => {
    await setAi({ monthly_budget_cents: 1 });
    await handle.db.insert(aiRequests).values({ feature: "ai.classify", model: "claude-opus-5-5", actor: { kind: "system", id: null }, prompt: "x", status: "ok", costCents: "0.79" });
    const integrations = createFakeIntegrations();
    integrations.anthropic.script("ai.classify", "x".repeat(4000));
    await callClaude(makeJobCtx(handle.db, "platform.check_alerts", { integrations }), req({ model: "opus" }));
    await callClaude(makeJobCtx(handle.db, "platform.check_alerts", { integrations }), req({ model: "opus" })).catch(() => undefined);
    const slack = await handle.db.select().from(jobs).where(eq(jobs.kind, "notify.slack"));
    expect(slack).toHaveLength(1);
    expect(slack[0]!.idempotencyKey).toMatch(/^slack:ai-budget-80-\d{4}-\d{2}:/);
  });
});
