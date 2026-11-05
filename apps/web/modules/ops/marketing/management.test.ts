/**
 * Rules 36-38 on a fixture with known answers: October 2026 (Brussels) against September.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type DbHandle } from "@beam/db/testing";
import { makeUser } from "@beam/db/testing/factories";
import { makeOrder, makePaidOrder } from "@beam/db/testing/commerce-factories";
import { makeCreditGrant, makeMembership } from "@beam/db/testing/credits-factories";
import { companies, creditGrants, membershipPeriods, opportunities } from "@beam/db/schema";
import { eq } from "@/lib/ctx";
import { makeBooking, makeCustomer } from "../stats/ops-p2.fixtures";
import { b2bFigures, computeManagementDashboard, customerCounts, retentionRates } from "./management";

const FROM = new Date("2026-09-30T22:00:00.000Z"); // 1 October 2026, Brussels midnight
const TO = new Date("2026-10-31T23:00:00.000Z"); // 1 November 2026, Brussels midnight
const at = (iso: string) => new Date(`${iso}T10:00:00.000Z`);

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
  const db = h.db;
  const buy = (personId: string, day: string) => makePaidOrder(db, { personId, order: { paidAt: at(day) } });

  const a = await makeCustomer(db); // new in October
  await buy(a.id, "2026-10-10");
  const b = await makeCustomer(db); // dormant: last purchase 1 March
  await buy(b.id, "2026-03-01");
  const c = await makeCustomer(db); // reactivated: June purchase, October visit
  await buy(c.id, "2026-06-01");
  await makeBooking(db, { personId: c.id, startsAt: at("2026-10-12"), status: "attended" });
  const d = await makeCustomer(db); // returning repeat buyer
  await buy(d.id, "2026-09-20");
  await buy(d.id, "2026-10-05");
  const e = await makeCustomer(db, { isTester: true }); // tester: never counted
  await buy(e.id, "2026-10-10");
  const f = await makeCustomer(db); // last purchase more than 365 days ago
  await buy(f.id, "2025-08-01");
  const g = await makeCustomer(db); // a visit only, no purchase
  await makeBooking(db, { personId: g.id, startsAt: at("2026-10-20"), status: "attended" });
  await makeBooking(db, { personId: g.id, startsAt: at("2026-10-21"), status: "no_show" });

  // Rule 37: grants that finished in October, one exhausted and one expired; one exhausted in September.
  for (const [status, day] of [["exhausted", "2026-10-05"], ["expired", "2026-10-06"], ["exhausted", "2026-09-01"]] as const) {
    const grant = await makeCreditGrant(db, { personId: a.id });
    await db.update(creditGrants).set({ status, statusChangedAt: at(day) }).where(eq(creditGrants.id, grant.id));
  }
  // Rule 37: two membership periods end in October; one is followed by a renewal.
  const m1 = await makeMembership(db, { personId: d.id, startedAt: at("2026-09-05") });
  await db.insert(membershipPeriods).values([
    { membershipId: m1.id, personId: d.id, periodStartAt: at("2026-09-05"), periodEndAt: at("2026-10-05"), source: "purchase" },
    { membershipId: m1.id, personId: d.id, periodStartAt: at("2026-10-05"), periodEndAt: at("2026-11-05"), source: "renewal" },
  ]);
  const m2 = await makeMembership(db, { personId: a.id, startedAt: at("2026-09-10") });
  await db.insert(membershipPeriods).values({ membershipId: m2.id, personId: a.id, periodStartAt: at("2026-09-10"), periodEndAt: at("2026-10-10"), source: "purchase" });

  // Rule 38: opportunities and a company order.
  const owner = await makeUser(db, { roleKey: "sales" });
  const [co] = await db.insert(companies).values({ name: "Example BV" }).returning();
  const opp = (o: Partial<typeof opportunities.$inferInsert>) => ({ companyId: co!.id, title: "Deal", ownerUserId: owner.id, ...o });
  await db.insert(opportunities).values([
    opp({ stage: "proposal", valueCents: 10_000, probabilityPct: 50 }),
    opp({ stage: "negotiation", valueCents: 20_000, probabilityPct: 25 }),
    opp({ stage: "target", valueCents: 1_000, probabilityPct: 10 }),
    opp({ stage: "won", valueCents: 5_000, probabilityPct: 100, wonAt: at("2026-10-03") }),
    opp({ stage: "lost", valueCents: 7_000, probabilityPct: 0, lostAt: at("2026-10-04"), lostReason: "price" }),
    opp({ stage: "lost", valueCents: 3_000, probabilityPct: 0, lostAt: at("2026-09-01"), lostReason: "timing" }),
  ]);
  await makeOrder(db, { companyId: co!.id, personId: null, status: "paid", subtotalCents: 12_100, totalCents: 12_100, paidAt: at("2026-10-08") });
});
afterAll(() => h.close());

describe("management dashboard (rules 36-38)", () => {
  it("R36: new, active, returning, dormant and reactivated customers", async () => {
    expect(await customerCounts(h.db, FROM, TO)).toEqual({ new: 1, active: 4, returning: 2, dormant: 1, reactivated: 1 });
  });

  it("R37: repeat purchase, package completion, reactivation and membership renewal rates", async () => {
    const r = await retentionRates(h.db, FROM, TO);
    expect(r.repeat_purchase_rate).toEqual({ numerator: 1, denominator: 5, rate: 0.2 });
    expect(r.package_completion).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(r.reactivation_rate).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(r.membership_renewal_rate).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
  });

  it("R38: pipeline, weighted value, qualified, proposals, conversion and B2B revenue", async () => {
    expect(await b2bFigures(h.db, FROM, TO)).toEqual({
      pipelineValueCents: 31_000,
      weightedValueCents: 10_100,
      openCount: 3,
      qualifiedCount: 2,
      proposalCount: 1,
      won: 1,
      lost: 1,
      revenueCents: 12_100,
    });
  });

  it("R34: the month view compares with the previous month and carries every tile group", async () => {
    const d = await computeManagementDashboard(h.db, { period: "month", at: new Date("2026-10-31T12:00:00.000Z") });
    expect(d.range).toEqual({ from: "2026-10-01", to: "2026-11-01", prevFrom: "2026-09-01", prevTo: "2026-10-01" });
    expect(d.customers.new).toMatchObject({ current: 1 });
    expect(d.customers.active.current).toBe(4);
    expect(d.b2b.conversion.current.rate).toBe(0.5);
    expect(d.b2b.conversion.previous).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    expect(d.b2b.revenueCents).toMatchObject({ current: 12_100, previous: 0, changePct: null });
    expect(d.revenue.byKind.length).toBeGreaterThan(0);
  });
});
