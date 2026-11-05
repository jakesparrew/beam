/**
 * ops-P10, rule 78: the weekly management summary with the fake Claude batches on PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Db, DbHandle } from "@beam/db";
import { featureFlags, managementSummaries, settings } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { eq } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { createFakeIntegrations, makeJobCtx, type FakeIntegrations } from "@/lib/testing";
import { rowsOf } from "@/lib/sensitive";
import { collectWeeklySummary, COLLECT_MAX_POLLS, customIdFor, generationOf, lastWeekStart, localeOfCustomId, startWeeklySummary, SUMMARY_KPIS } from "./summary";
import { runWeeklySummary, runWeeklySummaryCollect } from "./jobs";

let handle: DbHandle;
let db: Db;
let fakes: FakeIntegrations;
let defaultAi: Record<string, unknown>;
const person = { id: "", firstName: "Annelies", lastName: "SummaryLastname", email: "annelies.summary@example.com" };
/** Tuesday 3 November 2026, 07:00 Brussels: last week started on Monday 26 October. */
const NOW = new Date("2026-11-03T06:00:00Z");
const WEEK = "2026-10-26";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const q = async <T>(text: string) => rowsOf<T>(await db.execute(sql.raw(text)));
const jobCtx = (key: string) => makeJobCtx(db, "ai.weekly_summary", { integrations: fakes, now: NOW, key });
const collectCtx = (n: number) => makeJobCtx(db, "ai.weekly_summary_collect", { integrations: fakes, now: NOW, key: `collect-test-${n}` });
const row = async (week = WEEK) => (await db.select().from(managementSummaries).where(eq(managementSummaries.weekStartOn, week)))[0];

beforeAll(async () => {
  handle = await createTestDb();
  db = handle.db;
  await db.insert(featureFlags).values({ key: "ff_ops_ai", state: "on" }).onConflictDoUpdate({ target: featureFlags.key, set: { state: "on" } });
  await makeUser(db, { roleKey: "owner", locale: "nl-BE" });
  await makeUser(db, { roleKey: "management", locale: "fr-BE" });
  await makeUser(db, { roleKey: "management", locale: "fr-BE" });
  await makeUser(db, { roleKey: "reception", locale: "en" });
  const p = await makePerson(db, { firstName: person.firstName, lastName: person.lastName, email: person.email, isTester: false });
  person.id = p.id;
  await makePaidOrder(db, { personId: p.id, order: { paidAt: new Date("2026-10-28T10:00:00Z") } });
  await makePaidOrder(db, { personId: p.id, order: { paidAt: new Date("2026-10-21T10:00:00Z") } });
  defaultAi = (await getSetting(db, "ai")) as Record<string, unknown>;
}, 120_000);
afterAll(() => handle.close());
beforeEach(async () => {
  fakes = createFakeIntegrations();
  await db.delete(managementSummaries);
  await db.insert(settings).values({ key: "ai", value: defaultAi }).onConflictDoUpdate({ target: settings.key, set: { value: defaultAi } });
});

describe("helpers", () => {
  it("last week, generations and custom ids", () => {
    expect(lastWeekStart(NOW)).toBe(WEEK);
    expect(generationOf("schedule:ai.weekly_summary:123")).toBe(0);
    expect(generationOf(`summary:${WEEK}:regen:3`)).toBe(3);
    const id = customIdFor(WEEK, "nl-BE", 2);
    expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(localeOfCustomId(id)).toBe("nl-BE");
    expect(localeOfCustomId(customIdFor(WEEK, "en", 0))).toBe("en");
  });
});

describe("ai.weekly_summary (rule 78)", () => {
  it("sends aggregates only, as one batch with one request per owner and management locale", async () => {
    const out = await startWeeklySummary(jobCtx("schedule:ai.weekly_summary:1"), {});
    expect(out).toMatchObject({ status: "pending", weekStartOn: WEEK, locales: ["nl-BE", "fr-BE"] });
    expect(fakes.anthropic.batches).toHaveLength(1);
    const batch = fakes.anthropic.batches[0]!;
    expect(batch.items.map((i) => i.customId)).toEqual([customIdFor(WEEK, "nl-BE", 0), customIdFor(WEEK, "fr-BE", 0)]);
    for (const item of batch.items) {
      expect(item.request.feature).toBe("ai.weekly_summary");
      const prompt = item.request.system + item.request.messages.map((m) => m.content).join("\n");
      expect(prompt).not.toMatch(UUID);
      for (const s of [person.firstName, person.lastName, person.email]) expect(prompt).not.toContain(s);
      const payload = JSON.parse(item.request.messages[0]!.content) as { weekStartOn: string; kpis: { key: string; current: unknown; previous: unknown }[]; retentionListByReason: unknown };
      expect(payload.weekStartOn).toBe(WEEK);
      expect(payload.kpis.map((k) => k.key)).toContain("revenue_net");
      for (const k of payload.kpis) expect(SUMMARY_KPIS as readonly string[]).toContain(k.key);
      expect(payload.retentionListByReason).toBeTypeOf("object");
    }
    expect(batch.items[0]!.request.system).toContain("Dutch");
    expect(batch.items[1]!.request.system).toContain("French");

    expect(await row()).toMatchObject({ status: "pending", batchId: batch.id });
    const collect = await q<{ key: string; run_at: Date | string }>(`select idempotency_key as key, run_at from jobs where kind = 'ai.weekly_summary_collect' and idempotency_key like 'summary:${WEEK}:collect:${batch.id}:%'`);
    expect(collect.map((c) => c.key)).toEqual([`summary:${WEEK}:collect:${batch.id}:0`]);
    expect(new Date(collect[0]!.run_at).getTime()).toBe(NOW.getTime() + 10 * 60_000);
  });

  it("the collect job re-enqueues while the batch runs and stores each locale when it ends", async () => {
    fakes.anthropic.holdBatches(2);
    const started = await startWeeklySummary(jobCtx("schedule:ai.weekly_summary:2"), {});
    if (started.status !== "pending") throw new Error("not pending");
    const input = (n: number) => ({ weekStartOn: WEEK, batchId: started.batchId, n });

    expect(await collectWeeklySummary(collectCtx(0), input(0))).toEqual({ status: "running", next: 1 });
    expect(await collectWeeklySummary(collectCtx(1), input(1))).toEqual({ status: "running", next: 2 });
    const keys = await q<{ key: string }>(`select idempotency_key as key from jobs where idempotency_key like 'summary:${WEEK}:collect:${started.batchId}:%' order by 1`);
    expect(keys.map((k) => k.key)).toEqual([0, 1, 2].map((n) => `summary:${WEEK}:collect:${started.batchId}:${n}`));
    expect((await row())!.status).toBe("pending");

    const before = await q<{ n: number }>("select count(*)::int as n from ai_requests where feature = 'ai.weekly_summary'");
    const done = await collectWeeklySummary(collectCtx(2), input(2));
    expect(done).toMatchObject({ status: "ready", weekStartOn: WEEK });
    const stored = (await row())!;
    expect(stored.status).toBe("ready");
    expect(Object.keys(stored.summary).sort()).toEqual(["fr-BE", "nl-BE"]);
    expect(stored.summary["nl-BE"]).toMatch(/^\*\*Bookings up 4 % on last week\*\*\n\n- Occupancy 78 %/);
    expect(stored.aiRequestIds).toHaveLength(2);
    const logged = await q<{ id: string; status: string; cost: number; prompt: string }>(
      "select id::text as id, status::text as status, cost_cents::float8 as cost, prompt from ai_requests where feature = 'ai.weekly_summary' order by created_at, id",
    );
    expect(logged.length).toBe(before[0]!.n + 2);
    for (const id of stored.aiRequestIds) {
      const r = logged.find((l) => l.id === id)!;
      expect(r.status).toBe("ok");
      expect(r.cost).toBeGreaterThan(0);
      expect(r.prompt).not.toMatch(UUID);
    }
    const slack = await q<{ text: string }>(`select payload->>'text' as text from jobs where kind = 'notify.slack' and payload->>'fingerprint' = 'weekly-summary-${WEEK}'`);
    expect(slack[0]!.text).toContain(`/admin/dashboard/summary?week=${WEEK}`);

    // A late duplicate of a collect job does nothing.
    expect(await collectWeeklySummary(collectCtx(9), input(2))).toEqual({ status: "skipped", reason: "stale" });
  });

  it("fails after 36 polls without an end", async () => {
    fakes.anthropic.holdBatches(100);
    const started = await startWeeklySummary(jobCtx("schedule:ai.weekly_summary:3"), {});
    if (started.status !== "pending") throw new Error("not pending");
    const out = await collectWeeklySummary(collectCtx(35), { weekStartOn: WEEK, batchId: started.batchId, n: COLLECT_MAX_POLLS - 1 });
    expect(out).toMatchObject({ status: "failed" });
    expect((await row())!.status).toBe("failed");
  });

  it("a regeneration gets a new key and a new batch; the scheduled run does not repeat", async () => {
    const first = await startWeeklySummary(jobCtx("schedule:ai.weekly_summary:4"), {});
    if (first.status !== "pending") throw new Error("not pending");
    await collectWeeklySummary(collectCtx(0), { weekStartOn: WEEK, batchId: first.batchId, n: 0 });
    expect((await row())!.status).toBe("ready");

    // The scheduled run again: already done.
    expect(await startWeeklySummary(jobCtx("schedule:ai.weekly_summary:4"), {})).toMatchObject({ status: "skipped", reason: "already_done" });

    const regen = await startWeeklySummary(jobCtx(`summary:${WEEK}:regen:1`), { weekStartOn: WEEK });
    if (regen.status !== "pending") throw new Error("not pending");
    expect(regen.batchId).not.toBe(first.batchId);
    expect(fakes.anthropic.batches.at(-1)!.items.map((i) => i.customId)).toEqual([customIdFor(WEEK, "nl-BE", 1), customIdFor(WEEK, "fr-BE", 1)]);
    const pending = (await row())!;
    expect(pending.status).toBe("pending");
    expect((pending.kpis as { generation: number }).generation).toBe(1);
    // The earlier texts stay until the new ones arrive.
    expect(Object.keys(pending.summary)).toContain("nl-BE");
    // The same regeneration again (a retry of the job) creates no second batch.
    expect(await startWeeklySummary(jobCtx(`summary:${WEEK}:regen:1`), { weekStartOn: WEEK })).toMatchObject({ status: "skipped", reason: "batch_running" });
    await collectWeeklySummary(collectCtx(0), { weekStartOn: WEEK, batchId: regen.batchId, n: 0 });
    expect(await startWeeklySummary(jobCtx(`summary:${WEEK}:regen:1`), { weekStartOn: WEEK })).toMatchObject({ status: "skipped", reason: "already_done" });
    expect(fakes.anthropic.batches).toHaveLength(2);
  });

  it("skipped_budget: no batch, one budget_exceeded row per locale and a Slack line", async () => {
    await db.update(settings).set({ value: { ...defaultAi, monthly_budget_cents: 0 } }).where(eq(settings.key, "ai"));
    const before = await q<{ n: number }>("select count(*)::int as n from ai_requests where feature = 'ai.weekly_summary' and status = 'budget_exceeded'");
    const out = await runWeeklySummary(jobCtx("schedule:ai.weekly_summary:5"), {});
    expect(out).toEqual({ status: "skipped_budget", weekStartOn: WEEK });
    expect(fakes.anthropic.batches).toHaveLength(0);
    expect((await row())!.status).toBe("skipped_budget");
    const after = await q<{ n: number }>("select count(*)::int as n from ai_requests where feature = 'ai.weekly_summary' and status = 'budget_exceeded'");
    expect(after[0]!.n).toBe(before[0]!.n + 2);
    const slack = await q<{ n: number }>(`select count(*)::int as n from jobs where kind = 'notify.slack' and payload->>'fingerprint' = 'weekly-summary-budget-${WEEK}'`);
    expect(slack[0]!.n).toBe(1);
  });

  it("both jobs return early while ff_ops_ai is off", async () => {
    await db.update(featureFlags).set({ state: "off" }).where(eq(featureFlags.key, "ff_ops_ai"));
    try {
      expect(await runWeeklySummary(jobCtx("schedule:ai.weekly_summary:6"), {})).toEqual({ status: "skipped", reason: "flag_off" });
      expect(await runWeeklySummaryCollect(collectCtx(0), { weekStartOn: WEEK, batchId: "fake_batch_x", n: 0 })).toEqual({ status: "skipped", reason: "flag_off" });
      expect(fakes.anthropic.batches).toHaveLength(0);
    } finally {
      await db.update(featureFlags).set({ state: "on" }).where(eq(featureFlags.key, "ff_ops_ai"));
    }
  });
});
