/**
 * Rule 74 and ops spec section 6: the ads spend import with the fake clients (no network), the
 * real Google client's micros mapping through an injected `fetch`, re-pull idempotency, the
 * permanent 401, the non-EUR refusal and the per-run job keys.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import { adSpendDaily, featureFlags, jobs, settings } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import { createAdsFake, createGoogleAdsClient, createMetaAdsClient, fakeAdRows, microsToCents, type AdsFake } from "@beam/integrations/ads";
import { IntegrationError } from "@beam/integrations/_shared";
import { and, eq, sql } from "@/lib/ctx";
import { makeJobCtx, resetRuntime } from "@/lib/testing";
import { brusselsDay, daysToPull, getStaleAdsAccounts, pullAdsDay, pullJobKey, setAdsClients } from "./ads";
import { runAdsBackfill, runAdsPullYesterday } from "./jobs";

type DbHandle = Awaited<ReturnType<typeof createTestDb>>;

const NOW = new Date("2026-10-15T03:30:00.000Z"); // 05:30 Brussels (CEST)
const NEXT_DAY = new Date("2026-10-16T03:30:00.000Z");

let h: DbHandle;
let fake: AdsFake;

beforeAll(async () => {
  h = await createTestDb();
  await h.db.insert(featureFlags).values({ key: "ff_ops_marketing", state: "on" });
  await h.db.insert(settings).values({ key: "ads", value: { meta_account_ids: ["act_1"], google_customer_ids: ["123-456-7890"] } });
});
afterAll(() => h.close());
beforeEach(() => {
  fake = createAdsFake({ now: () => NOW });
  setAdsClients(fake);
});
afterEach(() => {
  setAdsClients(undefined);
  resetRuntime();
});

const spendRows = (platform: "meta" | "google", day: string) =>
  h.db.select().from(adSpendDaily).where(and(eq(adSpendDaily.platform, platform), eq(adSpendDaily.dayOn, day)));

describe("ads pull (rule 74)", () => {
  it("R74: writes the fake's campaigns for the day, with the fake's figures", async () => {
    const res = await pullAdsDay(h.db, { platform: "meta", accountId: "act_1", day: "2026-10-14", now: NOW });
    const expected = fakeAdRows("meta", "act_1", "2026-10-14");
    expect(res.rows).toBe(expected.length);
    const rows = await spendRows("meta", "2026-10-14");
    expect(rows.map((r) => [r.campaignExternalId, r.spendCents, r.clicks, r.currency]).sort()).toEqual(expected.map((e) => [e.campaignId, e.spendCents, e.clicks, "EUR"]).sort());
  });

  it("R74: a re-pull of the same day upserts (no duplicate rows, latest figures and pull time)", async () => {
    await pullAdsDay(h.db, { platform: "google", accountId: "123-456-7890", day: "2026-10-13", now: NOW });
    await h.db.update(adSpendDaily).set({ spendCents: 1 }).where(eq(adSpendDaily.dayOn, "2026-10-13"));
    await pullAdsDay(h.db, { platform: "google", accountId: "123-456-7890", day: "2026-10-13", now: NEXT_DAY });
    const rows = await spendRows("google", "2026-10-13");
    expect(rows).toHaveLength(fakeAdRows("google", "123-456-7890", "2026-10-13").length);
    expect(rows.every((r) => r.spendCents > 1 && r.pulledAt.getTime() === NEXT_DAY.getTime())).toBe(true);
  });

  it("R74: a 401 is permanent; a 503 stays retryable", async () => {
    fake.failNext("meta", { retryable: false, status: 401 });
    await expect(pullAdsDay(h.db, { platform: "meta", accountId: "act_1", day: "2026-10-10", now: NOW })).rejects.toBeInstanceOf(PermanentError);
    fake.failNext("meta", { retryable: true, status: 503 });
    const err = await pullAdsDay(h.db, { platform: "meta", accountId: "act_1", day: "2026-10-10", now: NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect((err as IntegrationError).retryable).toBe(true);
    expect(await spendRows("meta", "2026-10-10")).toHaveLength(0);
  });

  it("edge case 18: a non-EUR account is refused and writes nothing", async () => {
    fake.setCurrency("google", "999", "USD");
    await expect(pullAdsDay(h.db, { platform: "google", accountId: "999", day: "2026-10-09", now: NOW })).rejects.toThrow(/account currency must be EUR/);
    expect(await h.db.select().from(adSpendDaily).where(eq(adSpendDaily.accountId, "999"))).toHaveLength(0);
  });

  it("the real Google client turns cost_micros into cents and the Meta client spend into cents", async () => {
    expect(microsToCents("12345678")).toBe(1235);
    expect(microsToCents(0)).toBe(0);
    const google = createGoogleAdsClient({
      accessToken: "test-token",
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ results: [{ campaign: { id: "42", name: "Brand" }, metrics: { costMicros: "2500000", impressions: "100", clicks: "7", conversions: 2.4 }, customer: { currencyCode: "EUR" } }] }), { status: 200 })),
    });
    expect(await google.getCampaignStats({ customerId: "123-456-7890", day: "2026-10-14" })).toEqual([
      { campaignId: "42", campaignName: "Brand", spendCents: 250, impressions: 100, clicks: 7, leads: 2, currency: "EUR" },
    ]);
    const meta = createMetaAdsClient({
      accessToken: "test-token",
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ data: [{ campaign_id: "9", campaign_name: "Intro", spend: "12.34", impressions: "50", clicks: "3", account_currency: "eur", actions: [{ action_type: "lead", value: "2" }] }] }), { status: 200 })),
    });
    expect(await meta.getCampaignInsights({ accountId: "1", day: "2026-10-14" })).toEqual([
      { campaignId: "9", campaignName: "Intro", spendCents: 1234, impressions: 50, clicks: 3, leads: 2, currency: "EUR" },
    ]);
    const denied = createMetaAdsClient({ accessToken: "test-token", fetch: () => Promise.resolve(new Response("expired", { status: 401 })) });
    const err = await denied.getCampaignInsights({ accountId: "1", day: "2026-10-14" }).catch((e: unknown) => e);
    expect((err as IntegrationError).retryable).toBe(false);
  });
});

describe("ads job keys (rule 74)", () => {
  const pullKeys = async () => (await h.db.select({ key: jobs.idempotencyKey }).from(jobs).where(sql`${jobs.idempotencyKey} like 'ads:%:run:%'`)).map((r) => r.key);

  it("R74: the scheduled run enqueues yesterday and the 3 days before for every account", async () => {
    const res = await runAdsPullYesterday(makeJobCtx(h.db, "ads.pull_yesterday", { now: NOW }), {});
    expect(res).toEqual({ enqueued: 8, runOn: "2026-10-15" });
    expect(daysToPull("2026-10-15")).toEqual(["2026-10-14", "2026-10-13", "2026-10-12", "2026-10-11"]);
    const keys = await pullKeys();
    for (const day of daysToPull("2026-10-15")) {
      expect(keys).toContain(pullJobKey("meta", "act_1", day, "2026-10-15"));
      expect(keys).toContain(pullJobKey("google", "123-456-7890", day, "2026-10-15"));
    }
  });

  it("R74: the next day's re-pull of the same days is not dropped as a duplicate", async () => {
    const before = (await pullKeys()).length;
    const res = await runAdsPullYesterday(makeJobCtx(h.db, "ads.pull_yesterday", { now: NEXT_DAY }), {});
    expect(res).toEqual({ enqueued: 8, runOn: "2026-10-16" });
    const keys = await pullKeys();
    expect(keys.length).toBe(before + 8);
    for (const day of ["2026-10-14", "2026-10-13", "2026-10-12"]) {
      expect(keys).toContain(pullJobKey("meta", "act_1", day, "2026-10-15"));
      expect(keys).toContain(pullJobKey("meta", "act_1", day, "2026-10-16"));
    }
  });

  it("a per-day job pulls its one day; a backfill enqueues one pull per day", async () => {
    const one = await runAdsPullYesterday(makeJobCtx(h.db, "ads.pull_yesterday", { now: NOW }), { platform: "meta", accountId: "act_1", day: "2026-10-01", runOn: "2026-10-15" });
    expect(one).toMatchObject({ day: "2026-10-01", rows: 3 });
    const back = await runAdsBackfill(makeJobCtx(h.db, "ads.backfill", { now: NOW }), { platform: "google", accountId: "123-456-7890", from: "2026-09-01", to: "2026-09-05" });
    expect(back).toEqual({ enqueued: 5 });
    expect(brusselsDay(NOW)).toBe("2026-10-15");
  });

  it("R74: accounts without a pull in 3 days are stale for the digest", async () => {
    const stale = await getStaleAdsAccounts(h.db, new Date("2026-10-20T08:00:00.000Z"));
    expect(stale.map((s) => s.platform).sort()).toEqual(["google", "meta"]);
    expect(await getStaleAdsAccounts(h.db, NEXT_DAY)).toEqual([]);
  });

  it("returns early while ff_ops_marketing is off", async () => {
    await h.db.update(featureFlags).set({ state: "off" }).where(eq(featureFlags.key, "ff_ops_marketing"));
    try {
      expect(await runAdsPullYesterday(makeJobCtx(h.db, "ads.pull_yesterday", { now: NOW }), {})).toEqual({ skipped: "flag_off" });
    } finally {
      await h.db.update(featureFlags).set({ state: "on" }).where(eq(featureFlags.key, "ff_ops_marketing"));
    }
  });
});
