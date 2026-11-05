/**
 * ops-P9 `v_opportunity_candidates` (ops spec 2.4, R4): each reason with a matching person and a
 * near miss, the `behavioural_scoring` DPIA gate (rule 70), testers left out, the counts per
 * reason, the segment filter and the paged list.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { companies, companyContacts, dpiaRecords, opportunities, personStats, segmentMembers, segments } from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { makeCreditGrant, makeEntry, makeMembership } from "@beam/db/testing/credits-factories";
import { resetRuntime } from "@/lib/testing";
import { countOpportunitiesByReason, listOpportunityCandidates, OPPORTUNITY_REASONS, type OpportunityReason } from "./opportunities";

let h: DbHandle;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

type Stats = Partial<typeof personStats.$inferInsert>;
async function person(stats: Stats = {}, over: Parameters<typeof makePerson>[1] = {}) {
  const p = await makePerson(h.db, { isTester: false, ...over });
  await h.db.insert(personStats).values({ personId: p.id, ...stats });
  return p;
}

const reasonsOf = async (personId: string): Promise<OpportunityReason[]> =>
  (await listOpportunityCandidates(h.db)).rows.filter((r) => r.personId === personId).map((r) => r.reason).sort();

let ids: Record<string, string> = {};

beforeAll(async () => {
  h = await createTestDb();
  // Two months of the cheapest membership: 2 x 50 EUR. A yearly one at 1 200 EUR is 100 EUR a month.
  await makeProduct(h.db, { kind: "membership", priceCents: 5_000 });
  await makeProduct(h.db, { kind: "membership", recurringInterval: "year", priceCents: 120_000 });
  await makeProduct(h.db, { kind: "membership", priceCents: 1_000, isActive: false });
  const small = await makeProduct(h.db, { kind: "package", creditUnits: 5 });
  await makeProduct(h.db, { kind: "package", creditUnits: 10 });
  const night = await makeProduct(h.db, { kind: "package", creditKind: "night", creditUnits: 3 });

  // membership_fit
  const fit = await person({ visitsLast60d: 6 });
  await makePaidOrder(h.db, { personId: fit.id, lines: [{ unitAmountCents: 10_000 }], order: { paidAt: ago(20) } });
  const lowSpend = await person({ visitsLast60d: 8 });
  await makePaidOrder(h.db, { personId: lowSpend.id, lines: [{ unitAmountCents: 9_999 }], order: { paidAt: ago(20) } });
  const fewVisits = await person({ visitsLast60d: 5 });
  await makePaidOrder(h.db, { personId: fewVisits.id, lines: [{ unitAmountCents: 20_000 }], order: { paidAt: ago(20) } });
  const member = await person({ visitsLast60d: 9 });
  await makeMembership(h.db, { personId: member.id });
  await makePaidOrder(h.db, { personId: member.id, lines: [{ unitAmountCents: 20_000 }], order: { paidAt: ago(20) } });
  const tester = await person({ visitsLast60d: 9 }, { isTester: true });
  await makePaidOrder(h.db, { personId: tester.id, lines: [{ unitAmountCents: 20_000 }], order: { paidAt: ago(20) } });

  // package_upgrade
  const upgrade = await person();
  await makeCreditGrant(h.db, { personId: upgrade.id, productId: small.id, units: 5, createdAt: ago(100) });
  await makeCreditGrant(h.db, { personId: upgrade.id, productId: small.id, units: 5, createdAt: ago(10) });
  const once = await person();
  await makeCreditGrant(h.db, { personId: once.id, productId: small.id, units: 5, createdAt: ago(10) });
  await makeCreditGrant(h.db, { personId: once.id, productId: small.id, units: 5, createdAt: ago(200) });
  const largest = await person();
  await makeCreditGrant(h.db, { personId: largest.id, productId: night.id, creditKind: "night", units: 3, createdAt: ago(30) });
  await makeCreditGrant(h.db, { personId: largest.id, productId: night.id, creditKind: "night", units: 3, createdAt: ago(5) });

  // repurchase_likely
  const likely = await person({ repurchaseProbability: "0.700", churnProbability: "0.100" });
  const g = await makeCreditGrant(h.db, { personId: likely.id, units: 5 });
  await makeEntry(h.db, { grantId: g.id, kind: "consume", quantity: -3 });
  const unlikely = await person({ repurchaseProbability: "0.590" });
  await makeCreditGrant(h.db, { personId: unlikely.id, units: 2 });
  const plenty = await person({ repurchaseProbability: "0.900" });
  await makeCreditGrant(h.db, { personId: plenty.id, units: 5 });

  // reactivation_likely
  const back = await person({ b2cStage: "retention", churnProbability: "0.300" });
  const gone = await person({ b2cStage: "retention", churnProbability: "0.500" });
  const loyal = await person({ b2cStage: "repeat", churnProbability: "0.100" });

  // b2b_link
  const owner = await makeUser(h.db, { roleKey: "sales" });
  const [quiet] = await h.db.insert(companies).values({ name: "Quiet BV" }).returning();
  const [busy] = await h.db.insert(companies).values({ name: "Busy BV" }).returning();
  const [closed] = await h.db.insert(companies).values({ name: "Closed BV" }).returning();
  await h.db.insert(opportunities).values([
    { companyId: busy!.id, title: "Open", ownerUserId: owner.id, stage: "proposal" },
    { companyId: closed!.id, title: "Won", ownerUserId: owner.id, stage: "won", wonAt: ago(3) },
  ]);
  const link = await person();
  const linkClosed = await person();
  const linkBusy = await person();
  const linkEnded = await person();
  await h.db.insert(companyContacts).values([
    { companyId: quiet!.id, personId: link.id },
    { companyId: closed!.id, personId: linkClosed.id },
    { companyId: busy!.id, personId: linkBusy.id },
    { companyId: quiet!.id, personId: linkEnded.id, endedOn: "2026-01-31" },
  ]);

  ids = {
    fit: fit.id, lowSpend: lowSpend.id, fewVisits: fewVisits.id, member: member.id, tester: tester.id,
    upgrade: upgrade.id, once: once.id, largest: largest.id,
    likely: likely.id, unlikely: unlikely.id, plenty: plenty.id,
    back: back.id, gone: gone.id, loyal: loyal.id,
    link: link.id, linkClosed: linkClosed.id, linkBusy: linkBusy.id, linkEnded: linkEnded.id,
  };
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

async function setDpia(status: "in_progress" | "approved" | "not_required") {
  await h.db.insert(dpiaRecords).values({ key: "behavioural_scoring", status, decisionNote: "test" }).onConflictDoUpdate({ target: dpiaRecords.key, set: { status } });
}

describe("v_opportunity_candidates", () => {
  it("is empty while the behavioural_scoring DPIA is not approved", async () => {
    expect((await listOpportunityCandidates(h.db)).total).toBe(0);
    await setDpia("in_progress");
    expect(await countOpportunitiesByReason(h.db)).toEqual(Object.fromEntries(OPPORTUNITY_REASONS.map((r) => [r, 0])));
  });

  it("membership_fit: not a member, 6+ visits in 60 days, 60-day spend of two member months", async () => {
    await setDpia("approved");
    expect(await reasonsOf(ids.fit!)).toEqual(["membership_fit"]);
    const row = (await listOpportunityCandidates(h.db, { reason: "membership_fit" })).rows.find((r) => r.personId === ids.fit);
    expect(row!.detail).toMatchObject({ visits_last_60d: 6, spend_60d_cents: 10_000, member_month_cents: 5_000 });
    expect(row!.score).toBe(66);
    for (const k of ["lowSpend", "fewVisits", "member", "tester"]) expect(await reasonsOf(ids[k]!), k).not.toContain("membership_fit");
  });

  it("package_upgrade: two grants of a product in 180 days and a larger package of that credit kind", async () => {
    await setDpia("approved");
    expect(await reasonsOf(ids.upgrade!)).toEqual(["package_upgrade"]);
    const row = (await listOpportunityCandidates(h.db, { reason: "package_upgrade" })).rows.find((r) => r.personId === ids.upgrade);
    expect(row!.detail).toMatchObject({ grants_180d: 2, units: 5, larger_units: 10 });
    expect(await reasonsOf(ids.once!)).toEqual([]);
    expect(await reasonsOf(ids.largest!)).toEqual([]);
  });

  it("repurchase_likely: probability of 0.6 or more and an active grant with 2 or fewer units left", async () => {
    await setDpia("approved");
    expect(await reasonsOf(ids.likely!)).toEqual(["repurchase_likely"]);
    const row = (await listOpportunityCandidates(h.db, { reason: "repurchase_likely" })).rows.find((r) => r.personId === ids.likely);
    expect(row).toMatchObject({ score: 70, detail: { remaining: 2 } });
    expect(await reasonsOf(ids.unlikely!)).toEqual([]);
    expect(await reasonsOf(ids.plenty!)).toEqual([]);
  });

  it("reactivation_likely: stage retention and churn below 0.5", async () => {
    await setDpia("approved");
    expect(await reasonsOf(ids.back!)).toEqual(["reactivation_likely"]);
    expect((await listOpportunityCandidates(h.db, { reason: "reactivation_likely" })).rows.find((r) => r.personId === ids.back)!.score).toBe(70);
    expect(await reasonsOf(ids.gone!)).toEqual([]);
    expect(await reasonsOf(ids.loyal!)).toEqual([]);
  });

  it("b2b_link: a current company contact whose company has no open opportunity", async () => {
    await setDpia("approved");
    expect(await reasonsOf(ids.link!)).toEqual(["b2b_link"]);
    expect(await reasonsOf(ids.linkClosed!)).toEqual(["b2b_link"]);
    expect(await reasonsOf(ids.linkBusy!)).toEqual([]);
    expect(await reasonsOf(ids.linkEnded!)).toEqual([]);
  });

  it("counts people per reason, within a segment when given; not_required opens the gate too", async () => {
    await setDpia("not_required");
    expect(await countOpportunitiesByReason(h.db)).toEqual({ membership_fit: 1, package_upgrade: 1, repurchase_likely: 1, reactivation_likely: 1, b2b_link: 2 });
    const [seg] = await h.db.insert(segments).values({ name: "Opportunity test", kind: "static" }).returning();
    await h.db.insert(segmentMembers).values([
      { segmentId: seg!.id, personId: ids.fit!, source: "manual" },
      { segmentId: seg!.id, personId: ids.link!, source: "manual" },
    ]);
    expect(await countOpportunitiesByReason(h.db, { segmentId: seg!.id })).toEqual({ membership_fit: 1, package_upgrade: 0, repurchase_likely: 0, reactivation_likely: 0, b2b_link: 1 });
    const list = await listOpportunityCandidates(h.db, { segmentId: seg!.id });
    expect(list.rows.map((r) => r.personId).sort()).toEqual([ids.fit, ids.link].sort());
    expect(list.rows[0]!.score).toBeGreaterThanOrEqual(list.rows[1]!.score);
    expect(await countOpportunitiesByReason(h.db, { segmentId: "not-a-uuid" })).toEqual(Object.fromEntries(OPPORTUNITY_REASONS.map((r) => [r, 0])));
  });
});
