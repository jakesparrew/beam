/**
 * ops rules 1-7: the stats engine on `createTestDb()` with the shared factories. Orders come
 * from `@beam/db/testing/commerce-factories` (makeOrder, makeOrderLine, makePaidOrder).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { jobs as jobsTable, payments, personStats, refunds } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";
import { makeOrder, makeOrderLine, makePaidOrder } from "@beam/db/testing/commerce-factories";
import { eq, sql } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { getPersonStats, refreshPersonStats, requestStatsRefresh, statsRefreshKey } from "./api";
import { computeStatsSql } from "./compute";
import { DAY, daysAgo, daysAhead, makeBooking, makeCustomer, makeHistory } from "./ops-p2.fixtures";

let h: DbHandle;
let tx: Tx;
beforeAll(async () => {
  h = await createTestDb();
  tx = h.db as unknown as Tx;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const refresh = (personId: string) => refreshPersonStats(tx, personId);

describe("ops stats engine (rules 1-7)", () => {
  it("R1 a refund lowers revenue; R2 purchases and avg_order_cents", async () => {
    const p = await makeCustomer(h.db);
    const { order } = await makePaidOrder(h.db, { personId: p.id, lines: [{ productKind: "package", unitAmountCents: 10_000 }], order: { paidAt: daysAgo(5) } });
    await makePaidOrder(h.db, { personId: p.id, lines: [{ productKind: "item", unitAmountCents: 4_001 }], order: { paidAt: daysAgo(2) } });
    const user = await makeUser(h.db);
    const [pay] = await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", status: "paid", amountCents: 10_000, paidAt: daysAgo(5) }).returning();
    await h.db.insert(refunds).values({ paymentId: pay!.id, orderId: order.id, amountCents: 3_000, reason: "test", lines: [], creditAction: "none", status: "refunded", createdByUserId: user.id });
    await h.db.insert(refunds).values({ paymentId: pay!.id, orderId: order.id, amountCents: 500, reason: "test", lines: [], creditAction: "none", status: "failed", createdByUserId: user.id });
    const s = await refresh(p.id);
    expect(s).toMatchObject({ revenueCents: 11_001, purchases: 2, avgOrderCents: 5_501 });
    expect(s.firstPurchaseAt!.getTime()).toBeLessThan(s.lastPurchaseAt!.getTime());
  });

  it("R1 an order of a company never counts for the person; unpaid orders do not count", async () => {
    const p = await makeCustomer(h.db);
    const [company] = await h.db.execute(sql`insert into companies (name) values ('Example BV') returning id`).then((r) => (r as unknown as { rows: { id: string }[] }).rows);
    const companyOrder = await makeOrder(h.db, { companyId: company!.id, personId: p.id, status: "paid", paidAt: daysAgo(3) });
    await makeOrderLine(h.db, { orderId: companyOrder.id });
    await makeOrder(h.db, { personId: p.id, status: "pending_payment" });
    expect(await refresh(p.id)).toMatchObject({ revenueCents: 0, purchases: 0, avgOrderCents: 0, b2cStage: "lead" });
  });

  it("R1 R2 an imported purchase is counted in revenue and purchases", async () => {
    const p = await makeCustomer(h.db);
    await makeHistory(h.db, { personId: p.id, kind: "purchase", occurredAt: daysAgo(400), amountCents: 7_500 });
    await makePaidOrder(h.db, { personId: p.id, lines: [{ unitAmountCents: 2_500 }], order: { paidAt: daysAgo(1) } });
    const s = await refresh(p.id);
    expect(s).toMatchObject({ revenueCents: 10_000, purchases: 2, avgOrderCents: 5_000, b2cStage: "repeat" });
    expect(s.firstPurchaseAt!.getTime()).toBeLessThan(daysAgo(399).getTime());
  });

  it("R3 a guest visit counts for the guest, not the package owner; imported visits count", async () => {
    const owner = await makeCustomer(h.db);
    const guest = await makeCustomer(h.db);
    const at = daysAgo(10);
    const own = await makeBooking(h.db, { personId: owner.id, startsAt: at, status: "attended" });
    await makeBooking(h.db, { personId: guest.id, startsAt: at, status: "attended", sessionId: own.sessionId, guestOfBookingId: own.id });
    await makeHistory(h.db, { personId: guest.id, kind: "visit", occurredAt: daysAgo(100) });
    expect(await refresh(owner.id)).toMatchObject({ visits: 1, visitsLast60d: 1 });
    const g = await refresh(guest.id);
    expect(g).toMatchObject({ visits: 2, visitsLast60d: 1, visitsPrev180d: 1, b2cStage: "first_visit" });
    expect(g.lastVisitAt!.getTime()).toBe(at.getTime());
  });

  it("R3 a no-show is never a visit, never sets last_visit_at and never moves the stage forward", async () => {
    const p = await makeCustomer(h.db);
    await makeBooking(h.db, { personId: p.id, startsAt: daysAgo(4), status: "no_show" });
    await makeBooking(h.db, { personId: p.id, startsAt: daysAgo(6), status: "late_cancelled" });
    const s = await refresh(p.id);
    expect(s).toMatchObject({ visits: 0, noShows: 1, lateCancellations: 1, lastVisitAt: null, firstVisitAt: null });
    expect(["lead", "engaged_lead"]).toContain(s.b2cStage);
    expect(s.b2cStage).not.toBe("first_visit");
  });

  it("R3 attended events count as events_attended, not visits (experienced)", async () => {
    const p = await makeCustomer(h.db);
    await makeBooking(h.db, { personId: p.id, startsAt: daysAgo(200), status: "attended", kind: "event", createdAt: daysAgo(201) });
    expect(await refresh(p.id)).toMatchObject({ visits: 0, eventsAttended: 1, b2cStage: "experienced" });
  });

  it("R4 next_booking_at is the earliest future reserved or confirmed booking, guest bookings included", async () => {
    const p = await makeCustomer(h.db);
    const owner = await makeCustomer(h.db);
    const soonest = daysAhead(3);
    const ownerBooking = await makeBooking(h.db, { personId: owner.id, startsAt: soonest, status: "confirmed" });
    await makeBooking(h.db, { personId: p.id, startsAt: soonest, status: "confirmed", sessionId: ownerBooking.sessionId, guestOfBookingId: ownerBooking.id });
    await makeBooking(h.db, { personId: p.id, startsAt: daysAhead(1), status: "cancelled" });
    await makeBooking(h.db, { personId: p.id, startsAt: daysAhead(8), status: "reserved" });
    await makeBooking(h.db, { personId: p.id, startsAt: daysAgo(1), status: "confirmed" });
    expect((await refresh(p.id)).nextBookingAt!.getTime()).toBe(soonest.getTime());
  });

  it("R5 a chunk skips erased and merged persons and pages by person_id", async () => {
    const a = await makeCustomer(h.db);
    const erased = await makeCustomer(h.db, { erasedAt: new Date(), email: null });
    const merged = await makeCustomer(h.db, { mergedIntoPersonId: a.id });
    const r = await computeStatsSql(tx, { personIds: [a.id, erased.id, merged.id], limit: 10 });
    expect(r.upserted).toBe(1);
    expect(r.lastId).toBe(a.id);
    expect(await getPersonStats(h.db, erased.id)).toBeNull();
    const first = await computeStatsSql(tx, { limit: 2 });
    const next = await computeStatsSql(tx, { afterId: first.lastId!, limit: 2 });
    expect(next.lastId! > first.lastId!).toBe(true);
  });

  it("R5 running twice gives identical rows apart from computed_at", async () => {
    const p = await makeCustomer(h.db);
    await makePaidOrder(h.db, { personId: p.id, order: { paidAt: daysAgo(200) } });
    await makeBooking(h.db, { personId: p.id, startsAt: daysAgo(150), status: "attended" });
    const strip = (r: typeof personStats.$inferSelect) => ({ ...r, computedAt: null, updatedAt: null });
    await computeStatsSql(tx, { personIds: [p.id], limit: 1 });
    const one = strip((await h.db.select().from(personStats).where(eq(personStats.personId, p.id)))[0]!);
    await computeStatsSql(tx, { personIds: [p.id], limit: 1 });
    const two = strip((await h.db.select().from(personStats).where(eq(personStats.personId, p.id)))[0]!);
    expect(two).toEqual(one);
    expect(one.b2cStage).toBe("retention");
  });

  it("R7 refreshPersonStats recomputes one person; getPersonStats is null before; requestStatsRefresh enqueues one job per minute", async () => {
    const p = await makeCustomer(h.db);
    expect(await getPersonStats(h.db, p.id)).toBeNull();
    await makeBooking(h.db, { personId: p.id, startsAt: daysAgo(2), status: "attended" });
    expect(await refresh(p.id)).toMatchObject({ personId: p.id, visits: 1, b2cStage: "first_visit" });
    await requestStatsRefresh(tx, p.id);
    await requestStatsRefresh(tx, p.id);
    const queued = await h.db.select().from(jobsTable).where(eq(jobsTable.kind, "ops.refresh_person"));
    const mine = queued.filter((j) => (j.payload as { personId?: string }).personId === p.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.idempotencyKey.startsWith(`stats:${p.id}:`)).toBe(true);
    expect(statsRefreshKey(p.id, new Date("2026-11-04T08:15:30Z"))).toBe(`stats:${p.id}:2026-11-04T08:15`);
    void DAY;
  });
});
