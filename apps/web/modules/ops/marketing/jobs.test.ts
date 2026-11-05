/**
 * The ops-P8 jobs run twice (conventions item 11): `ads.pull_yesterday` (the schedule and one
 * per-day pull), `ads.backfill` and `ops.compute_attribution`. The second run leaves the same
 * state as the first; every handler returns early while `ff_ops_marketing` is off.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { createTestDb } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { adSpendDaily, attributionCredits, featureFlags, jobs, settings } from "@beam/db/schema";
import { createAdsFake } from "@beam/integrations/ads";
import { asc, eq, sql } from "@/lib/ctx";
import { makeJobCtx, resetRuntime, runJobTwice } from "@/lib/testing";
import { makeCustomer } from "../stats/ops-p2.fixtures";
import { setAdsClients } from "./ads";
import { runAdsBackfill, runAdsPullYesterday, runComputeAttribution } from "./jobs";

const DAY = 86_400_000;
let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
  await h.db.insert(featureFlags).values({ key: "ff_ops_marketing", state: "on" });
  await h.db.insert(settings).values({ key: "ads", value: { meta_account_ids: ["act_9"], google_customer_ids: ["111"] } });
  setAdsClients(createAdsFake());
  const p = await makeCustomer(h.db, { createdAt: new Date(Date.now() - 20 * DAY), acquisition: { source: "paid_google", campaign: "fake_google_1" } });
  await makePaidOrder(h.db, { personId: p.id, order: { paidAt: new Date(Date.now() - 2.5 * DAY) } });
});
afterAll(async () => {
  setAdsClients(undefined);
  resetRuntime();
  await h.close();
});
afterEach(() => setAdsClients(createAdsFake()));

const adsJobs = async () => (await h.db.select({ key: jobs.idempotencyKey, kind: jobs.kind }).from(jobs).where(sql`${jobs.kind} like 'ads.%'`).orderBy(asc(jobs.idempotencyKey))).map((r) => r.key);
const spend = async () =>
  (await h.db.select({ c: adSpendDaily.campaignExternalId, d: adSpendDaily.dayOn, s: adSpendDaily.spendCents }).from(adSpendDaily).orderBy(asc(adSpendDaily.campaignExternalId), asc(adSpendDaily.dayOn))).map((r) => `${r.c}:${r.d}:${r.s}`);
const credits = async () =>
  (
    await h.db
      .select({ o: attributionCredits.orderId, m: attributionCredits.model, k: attributionCredits.campaignKey, w: attributionCredits.weight, r: attributionCredits.revenueCents })
      .from(attributionCredits)
      .orderBy(asc(attributionCredits.orderId), asc(attributionCredits.model), asc(attributionCredits.campaignKey))
  ).map((r) => `${r.o}:${r.m}:${r.k}:${r.w}:${r.r}`);

describe("marketing jobs, double run", () => {
  it("ads.pull_yesterday (schedule): the second run enqueues nothing new", async () => {
    const { first, second } = await runJobTwice(h.db, "ads.pull_yesterday", {});
    expect(first).toMatchObject({ enqueued: 8 });
    expect(second).toMatchObject({ enqueued: 8 });
    const keys = await adsJobs();
    expect(keys.filter((k) => k.includes(":run:"))).toHaveLength(8);
  });

  it("ads.pull_yesterday (one day): the second run upserts the same rows", async () => {
    const payload = { platform: "meta", accountId: "act_9", day: "2026-10-01", runOn: "2026-10-02" };
    await runJobTwice(h.db, "ads.pull_yesterday", payload, { between: async () => expect((await spend()).length).toBe(3) });
    expect(await spend()).toHaveLength(3);
  });

  it("ads.backfill: the second run enqueues the same per-day jobs", async () => {
    const before = (await adsJobs()).length;
    await runJobTwice(h.db, "ads.backfill", { platform: "google", accountId: "111", from: "2026-09-01", to: "2026-09-03" });
    expect((await adsJobs()).length).toBe(before + 3);
  });

  it("ops.compute_attribution: the second run rebuilds the same credits", async () => {
    const fromPaidAt = new Date(Date.now() - 10 * DAY).toISOString();
    let afterFirst: string[] = [];
    await runJobTwice(h.db, "ops.compute_attribution", { fromPaidAt }, { between: async () => void (afterFirst = await credits()) });
    expect(afterFirst.length).toBe(2);
    expect(await credits()).toEqual(afterFirst);
    expect(afterFirst.every((c) => c.includes(":google|fake_google_1:"))).toBe(true);
  });

  it("ops.compute_attribution without input rebuilds the oldest slice and enqueues the next one", async () => {
    const ctx = makeJobCtx(h.db, "ops.compute_attribution");
    const res = await runComputeAttribution(ctx, {});
    expect(res).toMatchObject({ next: expect.any(String) });
    const [next] = await h.db.select({ key: jobs.idempotencyKey }).from(jobs).where(eq(jobs.kind, "ops.compute_attribution"));
    expect(next?.key).toMatch(/^attribution:\d{4}-\d{2}-\d{2}:run:\d{4}-\d{2}-\d{2}$/);
  });

  it("every handler returns early while ff_ops_marketing is off", async () => {
    await h.db.update(featureFlags).set({ state: "off" }).where(eq(featureFlags.key, "ff_ops_marketing"));
    try {
      expect(await runAdsPullYesterday(makeJobCtx(h.db, "ads.pull_yesterday"), {})).toEqual({ skipped: "flag_off" });
      expect(await runAdsBackfill(makeJobCtx(h.db, "ads.backfill"), { platform: "meta", accountId: "act_9", from: "2026-09-01", to: "2026-09-02" })).toEqual({ skipped: "flag_off" });
      expect(await runComputeAttribution(makeJobCtx(h.db, "ops.compute_attribution"), {})).toEqual({ skipped: "flag_off" });
    } finally {
      await h.db.update(featureFlags).set({ state: "on" }).where(eq(featureFlags.key, "ff_ops_marketing"));
    }
  });
});
