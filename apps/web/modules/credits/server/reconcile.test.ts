/**
 * credits-P5: `ledger.reconcile` (edge cases 20 to 22). Every check finds its case, imported
 * bookings are skipped, only status drift is corrected, a run writes one row and a double run
 * alerts once.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, creditEntries, creditGrants, creditReconciliationRuns, jobs as jobsTable } from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct, makeSession } from "@beam/db/testing";
import { makeOrder } from "@beam/db/testing/commerce-factories";
import { makeCreditGrant, makeEntry, makeMembership } from "@beam/db/testing/credits-factories";
import { count } from "drizzle-orm";
import { eq, inArray, sql } from "@/lib/ctx";
import type * as Alerts from "@/lib/alerts";
import { makeCtx, resetRuntime, runJobTwice } from "@/lib/testing";
import { reconcileLedger, type ReconcileFinding } from "./reconcile";

const fx = vi.hoisted(() => ({ notifySlack: vi.fn() }));
vi.mock("@/lib/alerts", async (orig) => ({ ...(await orig<typeof Alerts>()), notifySlack: fx.notifySlack }));

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  fx.notifySlack.mockImplementation(() => Promise.resolve({ jobId: randomUUID(), inserted: true }));
});

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

type BookingStatus = (typeof bookings.$inferInsert)["status"];
type BookingSource = (typeof bookings.$inferInsert)["source"];

/** A booking row (booking has no shared factory): a day session costing one unit, paid with credit. */
async function booking(personId: string, over: { status?: BookingStatus; source?: BookingSource; paidWith?: "credit" | "guest" | "order" | "free" } = {}) {
  const session = await makeSession(h.db);
  const status = over.status ?? "confirmed";
  const [b] = await h.db
    .insert(bookings)
    .values({
      sessionId: session.id,
      personId,
      status,
      paidWith: over.paidWith ?? "credit",
      source: over.source ?? "portal",
      ...(status === "cancelled" || status === "late_cancelled" ? { cancelledAt: new Date(), cancelReasonCode: "customer" as const } : {}),
      ...(status === "attended" ? { attendedAt: new Date() } : {}),
    })
    .returning();
  return b!;
}

const grantOf = (personId?: string, over: Parameters<typeof makeCreditGrant>[1] = {}) =>
  makeCreditGrant(h.db, { ...(personId ? { personId } : {}), units: 5, startsAt: ago(30 * DAY), expiresAt: new Date(Date.now() + 300 * DAY), ...over });

const consume = (grantId: string, ref: { type: "booking" | "order"; id: string }, quantity = -1) =>
  makeEntry(h.db, { grantId, kind: "consume", quantity, refType: ref.type, refId: ref.id });

async function run(manual = true) {
  const ctx = makeCtx(h.db);
  const result = await reconcileLedger(h.db, ctx, { jobId: randomUUID(), manual });
  const [row] = await h.db.select().from(creditReconciliationRuns).where(eq(creditReconciliationRuns.id, result.runId));
  return { result, row: row! };
}

const about = (findings: ReconcileFinding[], ids: string[]) =>
  findings.filter((f) => ids.includes(f.grant_id ?? "") || ids.includes(f.booking_id ?? "") || ids.includes(f.membership_id ?? ""));

describe("ledger.reconcile", () => {
  it("a consistent ledger gives an ok run without findings or alert", async () => {
    const p = await makePerson(h.db);
    const g = await grantOf(p.id);
    const b = await booking(p.id);
    await consume(g.id, { type: "booking", id: b.id });
    const { result, row } = await run();
    expect(row.status).toBe("ok");
    expect(row.findings).toEqual([]);
    expect(row.finishedAt).not.toBeNull();
    expect(row.checkedGrants).toBeGreaterThanOrEqual(1);
    expect(row.checkedBookings).toBeGreaterThanOrEqual(1);
    expect(result).toMatchObject({ status: "ok", findings: 0, skipped: false, alerted: false });
    expect(fx.notifySlack).not.toHaveBeenCalled();
  });

  it("finds booking_without_consume, orphan_consume and missing_release, and skips imported bookings", async () => {
    const p = await makePerson(h.db);
    const g = await grantOf(p.id);
    const noConsume = await booking(p.id);
    const attended = await booking(p.id, { status: "attended" });
    const released = await booking(p.id);
    const c = await consume(g.id, { type: "booking", id: released.id });
    await makeEntry(h.db, { grantId: g.id, kind: "release", quantity: 1, reversesEntryId: c.id, refType: "booking", refId: released.id });
    const imported = await booking(p.id, { source: "import" });
    const healthy = await booking(p.id);
    await consume(g.id, { type: "booking", id: healthy.id });
    const missing = randomUUID();
    await consume(g.id, { type: "booking", id: missing });
    const freeBooking = await booking(p.id, { paidWith: "free" });
    await consume(g.id, { type: "booking", id: freeBooking.id });
    const cancelled = await booking(p.id, { status: "cancelled" });
    await consume(g.id, { type: "booking", id: cancelled.id });
    const lateCancelled = await booking(p.id, { status: "late_cancelled" });
    await consume(g.id, { type: "booking", id: lateCancelled.id });

    const { row } = await run();
    const ids = [noConsume.id, attended.id, released.id, imported.id, healthy.id, missing, freeBooking.id, cancelled.id, lateCancelled.id];
    const mine = about(row.findings, ids).sort((a, b) => `${a.check}${a.booking_id}`.localeCompare(`${b.check}${b.booking_id}`));
    const expected: ReconcileFinding[] = [
      { check: "booking_without_consume", booking_id: attended.id, expected: 1, actual: 0 },
      { check: "booking_without_consume", booking_id: noConsume.id, expected: 1, actual: 0 },
      { check: "booking_without_consume", booking_id: released.id, expected: 1, actual: 0 },
      { check: "missing_release", grant_id: g.id, booking_id: cancelled.id, expected: 0, actual: 1 },
      { check: "orphan_consume", grant_id: g.id, booking_id: missing, expected: "booking", actual: 1 },
      { check: "orphan_consume", grant_id: g.id, booking_id: freeBooking.id, expected: "free", actual: 1 },
    ];
    expect(mine).toEqual(expected.sort((a, b) => `${a.check}${a.booking_id}`.localeCompare(`${b.check}${b.booking_id}`)));
    expect(row.status).toBe("mismatch");
  });

  it("skips a confirmed paid_with = credit booking with source = 'import' and no consume entry", async () => {
    const p = await makePerson(h.db);
    const imported = await booking(p.id, { source: "import" });
    const cancelledImport = await booking(p.id, { source: "import", status: "cancelled" });
    const { row } = await run();
    expect(about(row.findings, [imported.id, cancelledImport.id])).toEqual([]);
  });

  it("finds negative_balance and never corrects it", async () => {
    const g = await grantOf(undefined, { units: 1 });
    await makeEntry(h.db, { grantId: g.id, kind: "adjust", quantity: -2, reason: "manual sql bug" });
    const before = await h.db.select({ n: count() }).from(creditEntries).where(eq(creditEntries.grantId, g.id));
    const { row } = await run();
    expect(about(row.findings, [g.id])).toEqual([{ check: "negative_balance", grant_id: g.id, expected: 0, actual: -1 }]);
    const after = await h.db.select({ n: count() }).from(creditEntries).where(eq(creditEntries.grantId, g.id));
    expect(after).toEqual(before);
    expect((await h.db.select().from(creditGrants).where(eq(creditGrants.id, g.id)))[0]!.status).toBe("active");
  });

  it("finds stale_membership_period and missing_inclusion_grant", async () => {
    const plan = await makeProduct(h.db, { kind: "membership", includedCreditKind: "day", includedCreditUnits: 4 });
    const stale = await makeMembership(h.db, { productId: plan.id, startedAt: ago(42 * DAY), currentPeriodEndAt: ago(12 * DAY) });
    const recent = await makeMembership(h.db, { productId: plan.id, startedAt: ago(40 * DAY), currentPeriodEndAt: ago(10 * DAY) });
    const missing = await makeMembership(h.db, { productId: plan.id, startedAt: ago(5 * DAY) });
    const covered = await makeMembership(h.db, { productId: plan.id, startedAt: ago(5 * DAY) });
    await makeCreditGrant(h.db, {
      personId: covered.personId,
      source: "membership",
      membershipId: covered.id,
      productId: plan.id,
      creditKind: "day",
      units: 4,
      startsAt: covered.currentPeriodStartAt,
      expiresAt: covered.currentPeriodEndAt,
    });
    const pastDue = await makeMembership(h.db, { productId: plan.id, status: "past_due", startedAt: ago(5 * DAY) });

    const { row } = await run();
    const mine = about(row.findings, [stale.id, recent.id, missing.id, covered.id, pastDue.id]);
    expect(mine).toEqual([
      { check: "stale_membership_period", membership_id: stale.id, expected: "renewed_or_ended", actual: stale.currentPeriodEndAt.toISOString() },
      { check: "missing_inclusion_grant", membership_id: missing.id, expected: { credit_kind: "day", units: 4 }, actual: null },
    ]);
  });

  it("finds expiry_overdue only past 26 hours", async () => {
    const overdue = await grantOf(undefined, { expiresAt: ago(27 * HOUR) });
    const fresh = await grantOf(undefined, { expiresAt: ago(2 * HOUR) });
    const { row } = await run();
    expect(about(row.findings, [overdue.id, fresh.id])).toEqual([
      { check: "expiry_overdue", grant_id: overdue.id, expected: "expired", actual: overdue.expiresAt!.toISOString() },
    ]);
  });

  it("finds euro_order_mismatch for an unreleased euro consume of an expired order", async () => {
    const p = await makePerson(h.db);
    const euro = await grantOf(p.id, { creditKind: "euro", units: 5_000, unitValueCents: 1 });
    const expired = await makeOrder(h.db, { personId: p.id, status: "expired" });
    const paid = await makeOrder(h.db, { personId: p.id, status: "paid" });
    const releasedOrder = await makeOrder(h.db, { personId: p.id, status: "cancelled" });
    await consume(euro.id, { type: "order", id: expired.id }, -1_000);
    await consume(euro.id, { type: "order", id: paid.id }, -500);
    const c = await consume(euro.id, { type: "order", id: releasedOrder.id }, -200);
    await makeEntry(h.db, { grantId: euro.id, kind: "release", quantity: 200, reversesEntryId: c.id, refType: "order", refId: releasedOrder.id });
    const { row } = await run();
    expect(about(row.findings, [euro.id])).toEqual([
      { check: "euro_order_mismatch", grant_id: euro.id, expected: { order_id: expired.id, status: "expired", units: 0 }, actual: 1_000 },
    ]);
  });

  it("fixes status drift only: grant status follows the balance, no entry is written", async () => {
    const empty = await grantOf(undefined, { units: 2 });
    await makeEntry(h.db, { grantId: empty.id, kind: "consume", quantity: -2 });
    const refilled = await grantOf(undefined, { units: 2, status: "exhausted" });
    const lateExhausted = await grantOf(undefined, { units: 2, status: "exhausted", expiresAt: ago(2 * DAY) });
    const ids = [empty.id, refilled.id, lateExhausted.id];
    const entriesBefore = await h.db.select({ n: count() }).from(creditEntries).where(inArray(creditEntries.grantId, ids));

    const { row } = await run();
    expect(about(row.fixed, ids).sort((a, b) => a.grant_id!.localeCompare(b.grant_id!))).toEqual(
      [
        { check: "status_drift", grant_id: empty.id, expected: "exhausted", actual: "active" },
        { check: "status_drift", grant_id: refilled.id, expected: "active", actual: "exhausted" },
      ].sort((a, b) => a.grant_id.localeCompare(b.grant_id)),
    );
    expect(about(row.findings, ids)).toEqual([{ check: "status_drift", grant_id: lateExhausted.id, expected: "expired", actual: "exhausted" }]);
    const statuses = await h.db.select({ id: creditGrants.id, status: creditGrants.status }).from(creditGrants).where(inArray(creditGrants.id, ids));
    expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual({ [empty.id]: "exhausted", [refilled.id]: "active", [lateExhausted.id]: "exhausted" });
    expect(await h.db.select({ n: count() }).from(creditEntries).where(inArray(creditEntries.grantId, ids))).toEqual(entriesBefore);

    const again = await run();
    expect(about(again.row.fixed, ids)).toEqual([]);
  });

  it("alerts with fingerprint ledger:<run_id> on findings", async () => {
    await grantOf(undefined, { expiresAt: ago(3 * DAY) });
    const { result, row } = await run();
    expect(row.status).toBe("mismatch");
    expect(result.alerted).toBe(true);
    expect(fx.notifySlack).toHaveBeenCalledTimes(1);
    const [, input] = fx.notifySlack.mock.calls[0]! as [unknown, { fingerprint: string; severity: string; text: string }];
    expect(input.fingerprint).toBe(`ledger:${row.id}`);
    expect(input.severity).toBe("high");
    expect(input.text).toContain("expiry_overdue");
  });

  it("job double run writes one run and alerts once", async () => {
    await h.db.delete(creditReconciliationRuns);
    await h.db.execute(sql`delete from jobs`);
    await grantOf(undefined, { expiresAt: ago(3 * DAY) });
    const runs = () => h.db.select().from(creditReconciliationRuns);
    let afterFirst: unknown;
    const { first, second } = await runJobTwice(h.db, "ledger.reconcile", {}, { between: async () => void (afterFirst = await runs()) });
    expect(await runs()).toEqual(afterFirst);
    const all = await runs();
    expect(all).toHaveLength(1);
    expect(first).toMatchObject({ runId: all[0]!.id, status: "mismatch", skipped: false, alerted: true });
    expect(second).toMatchObject({ runId: all[0]!.id, skipped: true, alerted: false });
    expect(fx.notifySlack).toHaveBeenCalledTimes(1);
    expect(all[0]!.jobId).not.toBeNull();
    expect(await h.db.select().from(jobsTable).where(eq(jobsTable.kind, "ledger.reconcile"))).toEqual([]);
  });

  it("a manual run on the same day still runs", async () => {
    const before = (await h.db.select({ n: count() }).from(creditReconciliationRuns))[0]!.n;
    const { result } = await run(true);
    expect(result.skipped).toBe(false);
    expect((await h.db.select({ n: count() }).from(creditReconciliationRuns))[0]!.n).toBe(before + 1);
    const scheduled = await reconcileLedger(h.db, makeCtx(h.db), { jobId: randomUUID() });
    expect(scheduled.skipped).toBe(true);
  });
});
