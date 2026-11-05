/**
 * fix-w23-ops-wiring, rule 74 in the daily digest: while `ff_ops_marketing` is on and an ads
 * account is configured, the "Ads" section gives the data age and the accounts without a
 * successful pull for `ADS_STALE_DAYS` days (from `getStaleAdsAccounts`), and those accounts also
 * raise one Normal alert of their own. Without configured accounts or with the flag off the
 * section and the alert are left out. Every other source is mocked as in `digest.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { adSpendDaily, featureFlags, settings } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";

vi.mock("@/lib/alerts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), notifySlack: vi.fn() }));
vi.mock("@/modules/automation/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), countAutomationIssues: vi.fn() }));
vi.mock("@/modules/crm/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), countSegmentRefreshErrors: vi.fn() }));
vi.mock("@/modules/forms/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getFormsHealth: vi.fn() }));
vi.mock("@/modules/booking/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getBookingHealth: vi.fn() }));
vi.mock("@/modules/finance/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getFinanceDigest: vi.fn() }));
vi.mock("@/modules/platform/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getPlatformDigest: vi.fn() }));
vi.mock("@/modules/webinar/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), listUpcomingWebinarHealth: vi.fn() }));

const { notifySlack } = await import("@/lib/alerts");
const { countAutomationIssues } = await import("@/modules/automation/api");
const { countSegmentRefreshErrors } = await import("@/modules/crm/api");
const { getFormsHealth } = await import("@/modules/forms/api");
const { getBookingHealth } = await import("@/modules/booking/api");
const { getFinanceDigest } = await import("@/modules/finance/api");
const { getPlatformDigest } = await import("@/modules/platform/api");
const { listUpcomingWebinarHealth } = await import("@/modules/webinar/api");
const { eq, sql } = await import("@/lib/ctx");
const { fakeSentry, makeJobCtx } = await import("@/lib/testing");
const { runDigest } = await import("./digest");
const { ADS_STALE_DAYS, getStaleAdsAccounts } = await import("../marketing/ads");

let h: DbHandle;
let sentry: ReturnType<typeof fakeSentry>;
// 08:00 Brussels (CET) on a fixed day; the pulls are whole days before it.
const NOW = new Date("2026-11-20T07:00:00.000Z");
const DAY = 86_400_000;

beforeAll(async () => {
  h = await createTestDb();
  sentry = fakeSentry();
  // `act_fresh` pulled this morning, `act_old` five days ago, Google never.
  const row = (accountId: string, campaign: string, dayOn: string, pulledAt: Date) => ({
    platform: "meta" as const,
    accountId,
    campaignExternalId: campaign,
    campaignName: "Campaign",
    dayOn,
    spendCents: 100,
    raw: {},
    pulledAt,
  });
  await h.db.insert(adSpendDaily).values([
    row("act_fresh", "c-fresh", "2026-11-19", new Date(NOW.getTime() - 2 * 3_600_000)),
    row("act_old", "c-old", "2026-11-14", new Date(NOW.getTime() - 5 * DAY)),
  ]);
});
afterAll(async () => {
  sentry.restore();
  await h.close();
});
beforeEach(async () => {
  vi.mocked(notifySlack).mockReset().mockResolvedValue({ jobId: randomUUID(), inserted: true });
  vi.mocked(countAutomationIssues).mockReset().mockResolvedValue({ failed: 0, skippedTranslation: 0, stuck: 0, evaluatorLagSeconds: 0 });
  vi.mocked(countSegmentRefreshErrors).mockReset().mockResolvedValue(0);
  vi.mocked(getFormsHealth).mockReset().mockResolvedValue({ completions: 0, started: 0, importFailed: 0, importSkipped: 0, deadJobs: 0, formsWithBrokenCtas: 0 });
  vi.mocked(getBookingHealth).mockReset().mockResolvedValue({ level: "ok", materialisedThroughOn: "2027-01-31", overdueOffers: 0, overdueReservations: 0, unsentConfirmations24h: 0 });
  vi.mocked(getPlatformDigest).mockReset().mockResolvedValue({ title: "Platform", lines: [] });
  vi.mocked(getFinanceDigest).mockReset().mockResolvedValue({ title: "Finance", lines: [] });
  vi.mocked(listUpcomingWebinarHealth).mockReset().mockResolvedValue([]);
  await h.db.execute(sql`delete from ops_state where key = 'digest_last_sent_on'`);
  await h.db.delete(settings).where(eq(settings.key, "ads"));
  await h.db.insert(featureFlags).values({ key: "ff_ops_marketing", state: "on" }).onConflictDoUpdate({ target: featureFlags.key, set: { state: "on" } });
});

const configure = () =>
  h.db.insert(settings).values({ key: "ads", value: { meta_account_ids: ["act_fresh", "act_old"], google_customer_ids: ["123-456-7890"] } });
const run = () => runDigest(makeJobCtx(h.db, "ops.daily_digest", { now: NOW }));
const calls = () => vi.mocked(notifySlack).mock.calls.map((c) => c[1]);

describe("ops.daily_digest ads data age (rule 74, R3)", () => {
  it("lists the data age and the stale accounts of getStaleAdsAccounts, and raises one Normal alert", async () => {
    await configure();
    const stale = await getStaleAdsAccounts(h.db, NOW);
    expect(stale.map((s) => s.accountId).sort()).toEqual(["123-456-7890", "act_old"]);
    await run();
    const [digest, alert, ...rest] = calls();
    expect(rest).toEqual([]);
    expect(digest!.fingerprint).toBe("digest");
    expect(digest!.text).toContain("*Ads*\n- data as of 2026-11-19");
    expect(digest!.text).toContain("- (!) meta act_old: last successful pull 5 days ago");
    expect(digest!.text).toContain("- (!) google 123-456-7890: never pulled");
    expect(digest!.text).not.toContain("act_fresh");
    expect(alert).toMatchObject({ fingerprint: "ads-stale", severity: "normal" });
    expect(alert!.text).toContain(`${ADS_STALE_DAYS} days`);
    expect(alert!.text).toContain("data as of 2026-11-19");
    expect(alert!.text).toContain("meta act_old");
    expect(alert!.text).toContain("google 123-456-7890");
  });

  it("shows only the data age and raises no alert when every account pulled recently", async () => {
    await h.db.insert(settings).values({ key: "ads", value: { meta_account_ids: ["act_fresh"], google_customer_ids: [] } });
    await run();
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.text).toContain("*Ads*: data as of 2026-11-19");
  });

  it("leaves the section and the alert out without configured accounts or while ff_ops_marketing is off", async () => {
    await run();
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.text).not.toContain("*Ads*");

    await h.db.execute(sql`delete from ops_state where key = 'digest_last_sent_on'`);
    vi.mocked(notifySlack).mockClear();
    await configure();
    await h.db.update(featureFlags).set({ state: "off" }).where(eq(featureFlags.key, "ff_ops_marketing"));
    await run();
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.text).not.toContain("*Ads*");
  });

  it("a second run on the same day posts neither the digest nor the alert again", async () => {
    await configure();
    await run();
    expect(calls()).toHaveLength(2);
    await run();
    expect(calls()).toHaveLength(2);
  });
});
