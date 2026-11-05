/**
 * Rule 73a: the campaign funnel. Each step counts a person once, imported webinar registrations
 * count, the median days from lead to step, LTV and lead cost.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import { makeUser } from "@beam/db/testing/factories";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { makeMembership } from "@beam/db/testing/credits-factories";
import { adSpendDaily, personStats, webinarRegistrations, webinars } from "@beam/db/schema";
import { makeCustomer, makeHistory } from "../stats/ops-p2.fixtures";
import { computeCampaignFunnel, type CampaignFunnelRow } from "./funnel";

type DbHandle = Awaited<ReturnType<typeof createTestDb>>;

const day = (iso: string) => new Date(`${iso}T10:00:00.000Z`);
const RANGE = { from: "2026-09-01", to: "2026-09-30" };
const KEY = "meta|fake_meta_1";

let h: DbHandle;
let rows: CampaignFunnelRow[];
const step = (r: CampaignFunnelRow, s: string) => r.steps.find((x) => x.step === s)!;

beforeAll(async () => {
  h = await createTestDb();
  const db = h.db;
  const acq = { source: "paid_meta" as const, campaign: "fake_meta_1", medium: "cpc" };
  const host = await makeUser(db, { roleKey: "marketing" });
  const users = { ownerUserId: host.id, createdByUserId: host.id };
  const [w1] = await db.insert(webinars).values({ slug: "sleep-1", title: { en: "Sleep", "nl-BE": "Slaap", "fr-BE": "Sommeil" }, mode: "on_demand", ...users }).returning();
  const [w2] = await db.insert(webinars).values({ slug: "sleep-2", title: { en: "Sleep 2", "nl-BE": "Slaap 2", "fr-BE": "Sommeil 2" }, mode: "on_demand", ...users }).returning();

  // p1: two native registrations, two package orders, a second purchase, member.
  const p1 = await makeCustomer(db, { createdAt: day("2026-09-01"), acquisition: acq });
  await db.insert(webinarRegistrations).values([
    { webinarId: w1!.id, personId: p1.id, registeredMode: "on_demand", accessTokenHash: "h3", source: "site", locale: "nl-BE", personStatus: "lead", createdAt: day("2026-09-03") },
    { webinarId: w2!.id, personId: p1.id, registeredMode: "on_demand", accessTokenHash: "h5", source: "site", locale: "nl-BE", personStatus: "lead", createdAt: day("2026-09-05") },
  ]);
  await makePaidOrder(db, { personId: p1.id, lines: [{ productKind: "package", unitAmountCents: 20_000 }], order: { paidAt: day("2026-09-11") } });
  await makePaidOrder(db, { personId: p1.id, lines: [{ productKind: "package", unitAmountCents: 10_000 }], order: { paidAt: day("2026-09-21") } });
  await makeMembership(db, { personId: p1.id, startedAt: day("2026-09-25") });
  await db.insert(personStats).values({ personId: p1.id, revenueCents: 30_000, purchases: 2, firstVisitAt: day("2026-09-06"), firstPurchaseAt: day("2026-09-11"), lastPurchaseAt: day("2026-09-21") });

  // p2: imported webinar registration only; a lead with no purchase.
  const p2 = await makeCustomer(db, { createdAt: day("2026-09-10"), acquisition: acq });
  await makeHistory(db, { personId: p2.id, kind: "webinar_registration", occurredAt: day("2026-09-14") });
  await db.insert(personStats).values({ personId: p2.id, revenueCents: 0, purchases: 0 });

  // p3: no stats row at all.
  await makeCustomer(db, { createdAt: day("2026-09-20"), acquisition: acq });
  // Outside the range, a tester and another campaign.
  await makeCustomer(db, { createdAt: day("2026-10-02"), acquisition: acq });
  await makeCustomer(db, { createdAt: day("2026-09-05"), acquisition: acq, isTester: true });
  await makeCustomer(db, { createdAt: day("2026-09-05"), acquisition: { source: "website" } });

  await db.insert(adSpendDaily).values([
    { platform: "meta", accountId: "act_1", campaignExternalId: "fake_meta_1", campaignName: "Meta - Intro week", dayOn: "2026-09-02", spendCents: 6_000, raw: {}, pulledAt: day("2026-09-03") },
    { platform: "meta", accountId: "act_1", campaignExternalId: "fake_meta_1", campaignName: "Meta - Intro week", dayOn: "2026-10-02", spendCents: 9_999, raw: {}, pulledAt: day("2026-10-03") },
  ]);
  rows = await computeCampaignFunnel(db, { range: RANGE });
});
afterAll(() => h.close());

describe("campaign funnel (rule 73a)", () => {
  it("R73a: groups the people first-touched in the range by campaign key, testers excluded", () => {
    expect(rows.map((r) => [r.campaignKey, step(r, "lead").count])).toEqual([
      [KEY, 3],
      ["direct|none", 1],
    ]);
    expect(rows[0]).toMatchObject({ source: "meta", medium: "cpc", campaign: "fake_meta_1" });
  });

  it("R73a: each step counts a person once; imported webinar registrations count", () => {
    const r = rows[0]!;
    expect(r.steps.map((s) => [s.step, s.count])).toEqual([
      ["lead", 3],
      ["webinar", 2],
      ["first_visit", 1],
      ["package", 1],
      ["repeat", 1],
      ["member", 1],
    ]);
    expect(step(r, "webinar").share).toBeCloseTo(2 / 3, 10);
  });

  it("R73a: median days from lead to each step", () => {
    const r = rows[0]!;
    expect(step(r, "lead").medianDays).toBe(0);
    expect(step(r, "webinar").medianDays).toBe(3); // p1 after 2 days, p2 after 4 days
    expect(step(r, "first_visit").medianDays).toBe(5);
    expect(step(r, "package").medianDays).toBe(10);
    expect(step(r, "repeat").medianDays).toBe(20);
    expect(step(r, "member").medianDays).toBe(24);
  });

  it("R73a: lifetime value, first purchases and lead cost from the range's spend", () => {
    const r = rows[0]!;
    expect(r).toMatchObject({ firstPurchases: 1, revenueCents: 30_000, ltvCents: 10_000, spendCents: 6_000, leadCostCents: 2_000 });
    expect(rows[1]).toMatchObject({ spendCents: 0, leadCostCents: null });
  });

  it("filters one campaign key", async () => {
    const only = await computeCampaignFunnel(h.db, { range: RANGE, campaignKey: "direct|none" });
    expect(only.map((r) => r.campaignKey)).toEqual(["direct|none"]);
  });
});
