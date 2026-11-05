import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type DbHandle } from "@beam/db/testing";
import { makePerson } from "@beam/db/testing/factories";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { attributionCredits } from "@beam/db/schema";
import { eq, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { computeAttribution, linearWeights, splitCents, type Touch } from "./attribution";

const NOW = new Date("2026-10-15T10:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const touch = (campaignKey: string, ago: number): Touch => ({ campaignKey, touchedAt: daysAgo(ago) });

describe("linearWeights (rule 72)", () => {
  it("R72: weights sum to exactly 1 for one to seven distinct keys", () => {
    for (let n = 1; n <= 7; n++) {
      const touches = Array.from({ length: n }, (_, i) => touch(`meta|c${i}`, i + 1));
      const w = linearWeights(touches, NOW);
      expect(w).toHaveLength(n);
      expect(w.reduce((a, b) => a + Math.round(b.weight * 10_000), 0)).toBe(10_000);
      for (const x of w) expect(x.weight).toBeGreaterThan(0);
    }
  });

  it("R72: one weight per distinct campaign key, oldest first", () => {
    const w = linearWeights([touch("meta|a", 10), touch("google|b", 5), touch("meta|a", 2)], NOW);
    expect(w.map((x) => x.campaignKey)).toEqual(["meta|a", "google|b"]);
    expect(w.map((x) => x.weight)).toEqual([0.5, 0.5]);
  });

  it("R72: only touches in the 90 days before paid_at count", () => {
    const w = linearWeights([touch("meta|old", 91), touch("meta|edge", 90), touch("meta|future", -1)], NOW);
    expect(w.map((x) => x.campaignKey)).toEqual(["meta|edge"]);
  });

  it("R72: no touch in the window gives no weights (the first-touch fallback is the caller's)", () => {
    expect(linearWeights([touch("meta|old", 120)], NOW)).toEqual([]);
    expect(linearWeights([], NOW)).toEqual([]);
  });

  it("splits cents so the shares add up to the revenue", () => {
    expect(splitCents(100, [3334, 3333, 3333])).toEqual([34, 33, 33]);
    expect(splitCents(0, [5000, 5000])).toEqual([0, 0]);
  });
});

describe("computeAttribution (rule 72)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
  });
  afterAll(() => h.close());

  const creditsOf = async (orderId: string) =>
    (await h.db.select().from(attributionCredits).where(eq(attributionCredits.orderId, orderId))).sort((a, b) => a.model.localeCompare(b.model) || a.campaignKey.localeCompare(b.campaignKey));

  it("R72: first touch credits 100 % to the acquisition campaign; linear splits over the window's touches", async () => {
    const p = await makePerson(h.db, { isTester: false, createdAt: daysAgo(30), acquisition: { source: "paid_meta", campaign: "Spring-Sleep", medium: "cpc" } });
    await h.db.execute(sql`insert into checkouts (person_id, channel, items, utm, created_at, last_activity_at)
      values (${p.id}::uuid, 'site', '[]'::jsonb, '{"source":"google","campaign":"brand"}'::jsonb, ${daysAgo(3).toISOString()}::timestamptz, ${daysAgo(3).toISOString()}::timestamptz)`);
    const { order } = await makePaidOrder(h.db, { personId: p.id, lines: [{ unitAmountCents: 9_999 }], order: { paidAt: daysAgo(1) } });

    await computeAttribution(h.db, { fromPaidAt: daysAgo(10), now: NOW });
    const rows = await creditsOf(order.id);
    const first = rows.filter((r) => r.model === "first_touch");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ campaignKey: "meta|spring-sleep", weight: "1.0000", revenueCents: 9_999, source: "meta", medium: "cpc" });
    const linear = rows.filter((r) => r.model === "linear");
    expect(linear.map((r) => r.campaignKey)).toEqual(["google|brand", "meta|spring-sleep"]);
    expect(linear.reduce((a, r) => a + Number(r.weight), 0)).toBeCloseTo(1, 10);
    expect(linear.reduce((a, r) => a + r.revenueCents, 0)).toBe(9_999);
  });

  it("R72: direct|none without an acquisition campaign; linear falls back to the first touch", async () => {
    const p = await makePerson(h.db, { isTester: false, createdAt: daysAgo(200), acquisition: { source: "walk_in" } });
    const { order } = await makePaidOrder(h.db, { personId: p.id, order: { paidAt: daysAgo(2) } });
    await computeAttribution(h.db, { fromPaidAt: daysAgo(10), now: NOW });
    const rows = await creditsOf(order.id);
    expect(rows.map((r) => [r.model, r.campaignKey, r.weight])).toEqual([
      ["first_touch", "direct|none", "1.0000"],
      ["linear", "direct|none", "1.0000"],
    ]);
  });

  it("R72: an acquisition touch older than 90 days falls back to the first touch for linear", async () => {
    const p = await makePerson(h.db, { isTester: false, createdAt: daysAgo(150), acquisition: { source: "paid_google", campaign: "123" } });
    const { order } = await makePaidOrder(h.db, { personId: p.id, order: { paidAt: daysAgo(1) } });
    await computeAttribution(h.db, { fromPaidAt: daysAgo(10), now: NOW });
    const linear = (await creditsOf(order.id)).filter((r) => r.model === "linear");
    expect(linear.map((r) => [r.campaignKey, r.weight])).toEqual([["google|123", "1.0000"]]);
  });

  it("is idempotent and only rebuilds the requested range", async () => {
    const before = rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from attribution_credits`))[0]!.n;
    await computeAttribution(h.db, { fromPaidAt: daysAgo(10), now: NOW });
    const after = rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from attribution_credits`))[0]!.n;
    expect(after).toBe(before);
    const sums = rowsOf<{ order_id: string; model: string; w: string }>(
      await h.db.execute(sql`select order_id, model, sum(weight)::text as w from attribution_credits group by order_id, model`),
    );
    for (const s of sums) expect(Number(s.w)).toBe(1);
    const res = await computeAttribution(h.db, { fromPaidAt: daysAgo(10), toPaidAt: daysAgo(5), now: NOW });
    expect(res.rows).toBe(0);
    const kept = rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from attribution_credits`))[0]!.n;
    expect(kept).toBe(before);
  });
});
