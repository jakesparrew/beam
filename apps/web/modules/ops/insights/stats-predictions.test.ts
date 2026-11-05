/**
 * ops-P9, rule 76 in the stats run: `person_stats.{churn_probability, repurchase_probability,
 * predicted_value_cents, predicted_at}` stay null while the `behavioural_scoring` DPIA is not
 * approved, are filled after approval (the nightly job included), and are cleared again when the
 * approval is withdrawn. People with no purchase and no visit keep null columns.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { dpiaRecords, personStats } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { eq } from "@/lib/ctx";
import { resetRuntime, runJobTwice } from "@/lib/testing";
import { computeStatsSql, populationMedianIntervalDays } from "../stats/compute";
import { daysAgo, makeBooking, makeCustomer } from "../stats/ops-p2.fixtures";

let h: DbHandle;
let tx: Tx;
// Fractional day offsets from a pinned instant: the test means the same at 23:30 and across DST.
const NOW = new Date("2026-11-04T10:00:00.000Z");
const ago = (days: number) => daysAgo(days, NOW);

beforeAll(async () => {
  h = await createTestDb();
  tx = h.db as unknown as Tx;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

async function setDpia(status: "in_progress" | "approved" | "not_required" | "rejected") {
  await h.db
    .insert(dpiaRecords)
    .values({ key: "behavioural_scoring", status, decisionNote: "test" })
    .onConflictDoUpdate({ target: dpiaRecords.key, set: { status, decisionNote: "test" } });
}

const statsOf = async (personId: string) => (await h.db.select().from(personStats).where(eq(personStats.personId, personId)))[0]!;

/** Two visits 80.2 and 60.2 days ago (interval 20 days), one 100 EUR order 80.2 days ago. */
async function regular() {
  const p = await makeCustomer(h.db);
  await makePaidOrder(h.db, { personId: p.id, lines: [{ unitAmountCents: 10_000 }], order: { paidAt: ago(80.2) } });
  await makeBooking(h.db, { personId: p.id, startsAt: ago(80.2), status: "attended", createdAt: ago(81) });
  await makeBooking(h.db, { personId: p.id, startsAt: ago(60.2), status: "attended", createdAt: ago(61) });
  return p;
}

describe("prediction columns (rule 76, gated by behavioural_scoring)", () => {
  it("are null while the DPIA is not approved", async () => {
    const p = await regular();
    await computeStatsSql(tx, { personIds: [p.id], limit: 1, now: NOW });
    expect(await statsOf(p.id)).toMatchObject({ purchases: 1, visits: 2, churnProbability: null, repurchaseProbability: null, predictedValueCents: null, predictedAt: null });
    await setDpia("rejected");
    await computeStatsSql(tx, { personIds: [p.id], limit: 1, now: NOW });
    expect((await statsOf(p.id)).churnProbability).toBeNull();
  });

  it("are filled after approval with the rule 76 values", async () => {
    const p = await regular();
    await setDpia("approved");
    await computeStatsSql(tx, { personIds: [p.id], limit: 1, now: NOW });
    // 60 days since the last visit / 20-day interval: r = 3, churn = 1 - e^-0.7 = 0.503;
    // repurchase = 0.497 * 1/3 = 0.166; value = 10 000 * 1 / 0.25 (tenure floor) * 0.497 = 19 880.
    expect(await statsOf(p.id)).toMatchObject({ churnProbability: "0.503", repurchaseProbability: "0.166", predictedValueCents: 19_880 });
    expect((await statsOf(p.id)).predictedAt!.getTime()).toBe(NOW.getTime());
  });

  it("a future booking sets churn to 0.05; not_required counts as approved", async () => {
    await setDpia("not_required");
    const p = await regular();
    await makeBooking(h.db, { personId: p.id, startsAt: new Date(NOW.getTime() + 3.2 * 86_400_000), status: "confirmed", createdAt: ago(70) });
    await computeStatsSql(tx, { personIds: [p.id], limit: 1, now: NOW });
    expect(await statsOf(p.id)).toMatchObject({ churnProbability: "0.050", repurchaseProbability: "0.317" });
  });

  it("people with no purchase and no visit keep null columns after approval", async () => {
    await setDpia("approved");
    const lead = await makeCustomer(h.db);
    await computeStatsSql(tx, { personIds: [lead.id], limit: 1, now: NOW });
    expect(await statsOf(lead.id)).toMatchObject({ purchases: 0, visits: 0, churnProbability: null, predictedValueCents: null });
  });

  it("the population median replaces the interval of people with one visit", async () => {
    await setDpia("approved");
    const median = await populationMedianIntervalDays(h.db);
    expect(median).not.toBeNull();
    expect(median!).toBeGreaterThan(0);
  });

  it("are cleared on the next run when the approval is withdrawn", async () => {
    const p = await regular();
    await setDpia("approved");
    await computeStatsSql(tx, { personIds: [p.id], limit: 1, now: NOW });
    expect((await statsOf(p.id)).churnProbability).not.toBeNull();
    await setDpia("in_progress");
    await computeStatsSql(tx, { personIds: [p.id], limit: 1, now: NOW });
    expect(await statsOf(p.id)).toMatchObject({ churnProbability: null, repurchaseProbability: null, predictedValueCents: null, predictedAt: null });
  });

  it("the nightly ops.refresh_person_stats fills them, twice with the same values", async () => {
    const p = await regular();
    await setDpia("approved");
    let first: Awaited<ReturnType<typeof statsOf>> | undefined;
    await runJobTwice(h.db, "ops.refresh_person_stats", { runOn: "2026-11-04" }, { between: async () => void (first = await statsOf(p.id)) });
    const second = await statsOf(p.id);
    expect(first!.churnProbability).not.toBeNull();
    expect(first!.predictedValueCents).not.toBeNull();
    expect({ c: second.churnProbability, r: second.repurchaseProbability }).toEqual({ c: first!.churnProbability, r: first!.repurchaseProbability });
  });
});
