/**
 * fix-w23-ops-wiring, rule 78 on platform's batch helpers: the weekly summary pre-checks the
 * budget and the daily cap for all its requests with `checkAiBatchBudget` (`@/lib/ai`) and logs
 * every batch request with `logAiBatchRequests` (feature `ai.weekly_summary`), on a refusal as
 * `budget_exceeded` rows without a batch and on collect as the read results.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, DbHandle } from "@beam/db";
import { featureFlags, managementSummaries } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";
import type * as AiLib from "@/lib/ai";

vi.mock("@/lib/ai", async (orig) => {
  const real = await orig<typeof AiLib>();
  return { ...real, checkAiBatchBudget: vi.fn(real.checkAiBatchBudget), logAiBatchRequests: vi.fn(real.logAiBatchRequests) };
});

const ai = await import("@/lib/ai");
const { createFakeIntegrations, makeJobCtx } = await import("@/lib/testing");
const { collectWeeklySummary, startWeeklySummary } = await import("./summary");

let handle: DbHandle;
let db: Db;
/** Tuesday 3 November 2026, 07:00 Brussels: last week started on Monday 26 October. */
const NOW = new Date("2026-11-03T06:00:00Z");
const WEEK = "2026-10-26";
const check = vi.mocked(ai.checkAiBatchBudget);
const log = vi.mocked(ai.logAiBatchRequests);

beforeAll(async () => {
  handle = await createTestDb();
  db = handle.db;
  await db.insert(featureFlags).values({ key: "ff_ops_ai", state: "on" }).onConflictDoUpdate({ target: featureFlags.key, set: { state: "on" } });
  await makeUser(db, { roleKey: "owner", locale: "nl-BE" });
  await makeUser(db, { roleKey: "management", locale: "fr-BE" });
}, 120_000);
afterAll(() => handle.close());
beforeEach(async () => {
  check.mockClear();
  log.mockClear();
  await db.delete(managementSummaries);
});

describe("weekly summary on checkAiBatchBudget and logAiBatchRequests", () => {
  it("checks room for every locale's request, then logs each read result once", async () => {
    const fakes = createFakeIntegrations();
    const started = await startWeeklySummary(makeJobCtx(db, "ai.weekly_summary", { integrations: fakes, now: NOW, key: "schedule:ai.weekly_summary:w23" }), {});
    if (started.status !== "pending") throw new Error(`not pending: ${started.status}`);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]![1]).toBe(2);
    expect(log).not.toHaveBeenCalled();

    const out = await collectWeeklySummary(makeJobCtx(db, "ai.weekly_summary_collect", { integrations: fakes, now: NOW, key: "collect-w23-0" }), { weekStartOn: WEEK, batchId: started.batchId, n: 0 });
    expect(out).toMatchObject({ status: "ready" });
    expect(log).toHaveBeenCalledTimes(1);
    const [, req, rows] = log.mock.calls[0]!;
    expect(req).toMatchObject({ feature: "ai.weekly_summary" });
    expect(rows.map((r) => r.status)).toEqual(["ok", "ok"]);
  });

  it("a refused budget logs one budget_exceeded row per locale and creates no batch", async () => {
    check.mockResolvedValueOnce({ ok: false, reason: "daily_cap", monthCents: 0, todayCalls: 49, cap: 50 });
    const fakes = createFakeIntegrations();
    const out = await startWeeklySummary(makeJobCtx(db, "ai.weekly_summary", { integrations: fakes, now: NOW, key: "schedule:ai.weekly_summary:w23b" }), {});
    expect(out).toEqual({ status: "skipped_budget", weekStartOn: WEEK });
    expect(fakes.anthropic.batches).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(1);
    const [, req, rows] = log.mock.calls[0]!;
    expect(req).toMatchObject({ feature: "ai.weekly_summary" });
    expect(rows.map((r) => r.status)).toEqual(["budget_exceeded", "budget_exceeded"]);
  });
});
