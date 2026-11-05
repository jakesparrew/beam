import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { aiRequests } from "@beam/db/schema";
import { modelIdFor } from "@beam/core/ai";
import { aiPromptText, aiUsage, checkAiBatchBudget, logAiBatchRequests, NON_PRODUCTION_DAILY_CAP } from "./ai";
import { sql } from "./ctx";
import { getSetting, setSetting } from "./settings";
import { makeCtx, makeJobCtx, resetRuntime } from "./testing";

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
  await handle.db.execute(sql`delete from settings`);
});

async function setAi(patch: Record<string, unknown>) {
  const ctx = makeCtx(handle.db);
  const current = await getSetting(handle.db, "ai");
  const version = Number(((await handle.db.execute(sql`select coalesce(max(version), 0) as v from settings where key = 'ai'`)) as unknown as { rows: { v: number }[] }).rows[0]!.v);
  await setSetting(ctx, "ai", { ...current, ...patch } as typeof current, version);
}

describe("fix-w21-platform-wiring: Message Batch helpers of lib/ai (ops-P10 request)", () => {
  it("logs one ai_requests row per batch request with feature, model, actor, job, tokens and cost", async () => {
    const ctx = makeJobCtx(handle.db, "platform.check_alerts");
    const id = randomUUID();
    await logAiBatchRequests(ctx, { feature: "ai.weekly_summary", model: "opus" }, [
      { id, status: "ok", prompt: aiPromptText("Summarise.", [{ role: "user", content: "week 45" }]), output: "{}", usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 0 }, costCents: 1.5 },
      { status: "error", prompt: "[system]\nSummarise.", error: "expired" },
    ]);
    const rows = await handle.db.select().from(aiRequests);
    expect(rows).toHaveLength(2);
    const ok = rows.find((r) => r.id === id)!;
    expect(ok).toMatchObject({ feature: "ai.weekly_summary", model: modelIdFor("opus"), status: "ok", inputTokens: 120, outputTokens: 40, jobId: ctx.job.id, personId: null });
    expect(Number(ok.costCents)).toBeCloseTo(1.5);
    expect(ok.prompt).toBe("[system]\nSummarise.\n\n[user]\nweek 45");
    expect(rows.find((r) => r.id !== id)).toMatchObject({ status: "error", error: "expired", inputTokens: 0 });
    expect((await aiUsage(handle.db)).todayCalls).toBe(2);
  });

  it("writes nothing for an empty batch and refuses an unknown feature", async () => {
    const ctx = makeJobCtx(handle.db, "platform.check_alerts");
    await logAiBatchRequests(ctx, { feature: "ai.weekly_summary", model: "opus" }, []);
    expect(await handle.db.select().from(aiRequests)).toHaveLength(0);
    await expect(logAiBatchRequests(ctx, { feature: "nope" as never, model: "opus" }, [{ status: "ok", prompt: "x" }])).rejects.toThrow(/unknown_ai_feature/);
  });

  it("pre-checks the daily cap for the whole batch and the monthly budget", async () => {
    const ctx = makeJobCtx(handle.db, "platform.check_alerts");
    await setAi({ daily_cap_calls: 5, monthly_budget_cents: 1000 });
    expect(await checkAiBatchBudget(ctx, 5)).toMatchObject({ ok: true, cap: 5, todayCalls: 0 });
    expect(await checkAiBatchBudget(ctx, 6)).toMatchObject({ ok: false, reason: "daily_cap" });

    await logAiBatchRequests(ctx, { feature: "ai.weekly_summary", model: "opus" }, [{ status: "ok", prompt: "x", costCents: 1000 }]);
    expect(await checkAiBatchBudget(ctx, 1)).toMatchObject({ ok: false, reason: "budget", monthCents: 1000 });
  });

  it("budget_exceeded rows do not count as calls; outside production the cap is at most 100", async () => {
    const ctx = makeJobCtx(handle.db, "platform.check_alerts");
    await setAi({ daily_cap_calls: 10_000, monthly_budget_cents: 100_000 });
    await logAiBatchRequests(ctx, { feature: "ai.weekly_summary", model: "opus" }, [{ status: "budget_exceeded", prompt: "x", error: "budget" }]);
    const check = await checkAiBatchBudget(ctx, NON_PRODUCTION_DAILY_CAP);
    expect(check).toMatchObject({ ok: true, todayCalls: 0, cap: NON_PRODUCTION_DAILY_CAP });
    expect(await checkAiBatchBudget(ctx, NON_PRODUCTION_DAILY_CAP + 1)).toMatchObject({ ok: false, reason: "daily_cap" });
  });
});
