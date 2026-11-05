/**
 * ops job `ops.build_weekly_retention_list` (rule 20, ops-P7): run twice for the same week it
 * yields the same list and posts the Slack notice once; it returns early while
 * `ff_ops_retention` is off.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { featureFlags, personStats, retentionListItems, retentionLists } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";

vi.mock("@/lib/alerts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), notifySlack: vi.fn() }));

const { notifySlack } = await import("@/lib/alerts");
const { asc, eq } = await import("@/lib/ctx");
const { makeJobCtx, resetRuntime, runJobTwice } = await import("@/lib/testing");
const { ago, makeCustomer } = await import("../dashboard/ops-p3.fixtures");
const { runBuildWeeklyRetentionList } = await import("./jobs");

let h: DbHandle;
const WEEK = "2026-11-09";

beforeAll(async () => {
  h = await createTestDb();
  for (let i = 0; i < 4; i++) {
    const p = await makeCustomer(h.db);
    await h.db.insert(personStats).values({ personId: p.id, revenueCents: 100_000 + i * 20_000, purchases: 2, lastActivityAt: ago(70) });
  }
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  vi.mocked(notifySlack).mockReset().mockResolvedValue({ jobId: randomUUID(), inserted: true });
  await h.db.delete(retentionLists);
  await h.db.delete(featureFlags).where(eq(featureFlags.key, "ff_ops_retention"));
});

const snapshot = async () =>
  (
    await h.db
      .select({ listId: retentionListItems.listId, rank: retentionListItems.rank, personId: retentionListItems.personId, score: retentionListItems.score, reasons: retentionListItems.reasons })
      .from(retentionListItems)
      .orderBy(asc(retentionListItems.rank))
  ).map((r) => ({ ...r, reasons: [...r.reasons] }));

describe("ops.build_weekly_retention_list", () => {
  it("run twice for the same week yields the same list and one Slack notice", async () => {
    await h.db.insert(featureFlags).values({ key: "ff_ops_retention", state: "on" });
    const states: unknown[] = [];
    const { first, second } = await runJobTwice(h.db, "ops.build_weekly_retention_list", { weekStartOn: WEEK }, { between: async () => void states.push(await snapshot()) });
    states.push(await snapshot());
    expect(first).toMatchObject({ weekStartOn: WEEK, size: 4, created: true, notified: true });
    expect(second).toMatchObject({ weekStartOn: WEEK, size: 4, created: false, notified: false });
    expect((first as { listId: string }).listId).toBe((second as { listId: string }).listId);
    expect(states[1]).toEqual(states[0]);
    expect((states[0] as unknown[]).length).toBe(4);
    expect(await h.db.select().from(retentionLists)).toHaveLength(1);
    expect(vi.mocked(notifySlack)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifySlack).mock.calls[0]![1]).toMatchObject({ fingerprint: `retention-list:${WEEK}` });
  });

  it("the scheduled run (no input) builds the list of the Brussels Monday of now, also while the flag is for testers", async () => {
    await h.db.insert(featureFlags).values({ key: "ff_ops_retention", state: "testers" });
    const ctx = makeJobCtx(h.db, "ops.build_weekly_retention_list", { now: new Date("2026-11-09T05:10:00Z") });
    expect(await runBuildWeeklyRetentionList(ctx, {})).toMatchObject({ weekStartOn: "2026-11-09", size: 4 });
  });

  it("returns early while ff_ops_retention is off or has no row", async () => {
    const ctx = makeJobCtx(h.db, "ops.build_weekly_retention_list");
    expect(await runBuildWeeklyRetentionList(ctx, { weekStartOn: WEEK })).toEqual({ skipped: "flag_off" });
    await h.db.insert(featureFlags).values({ key: "ff_ops_retention", state: "off" });
    expect(await runBuildWeeklyRetentionList(ctx, { weekStartOn: WEEK })).toEqual({ skipped: "flag_off" });
    expect(await h.db.select().from(retentionLists)).toHaveLength(0);
    expect(vi.mocked(notifySlack)).not.toHaveBeenCalled();
  });
});
