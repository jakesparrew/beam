/**
 * ops rules 14-18 and 14a: `ops.stage_changed` once per day, `person.inactive_days` dedupe and
 * re-arm, no burst after the cut-over import, stage thresholds from `settings.retention_defaults`,
 * and `is_high_value` without a stage change.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, orders, settings } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { RETENTION_DEFAULTS } from "@beam/core/ops";
import { and, eq, sql } from "@/lib/ctx";
import { makeJobCtx, resetRuntime } from "@/lib/testing";
import { computeStatsSql, emitStatsEvents } from "./compute";
import { runRefreshPersonStats } from "./jobs";
import { daysAgo, daysAhead, makeBooking, makeCustomer, makeHistory } from "./ops-p2.fixtures";

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

const eventsOf = (personId: string, kind: string) =>
  h.db
    .select({ data: activityEvents.data, dedupeKey: activityEvents.dedupeKey })
    .from(activityEvents)
    .where(and(eq(activityEvents.personId, personId), eq(activityEvents.kind, kind)));

/** One person through the stats engine and the event writer, like the nightly job. */
async function nightly(personId: string) {
  const r = await computeStatsSql(tx, { personIds: [personId], limit: 1 });
  await emitStatsEvents(tx, r, { inactivity: true });
  return r;
}

describe("stage-change events (rule 14)", () => {
  it("R14 writes ops.stage_changed { from, to } on a change, once per person, stage and day", async () => {
    const p = await makeCustomer(h.db);
    await nightly(p.id); // first computation: lead, silent
    expect(await eventsOf(p.id, "ops.stage_changed")).toEqual([]);
    const { order } = await makePaidOrder(h.db, { personId: p.id, order: { paidAt: daysAgo(1) } });
    const r = await nightly(p.id);
    expect(r.stageChanges).toMatchObject([{ personId: p.id, from: "lead", to: "first_purchase" }]);
    await nightly(p.id); // unchanged: no new event
    await h.db.update(orders).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(orders.id, order.id));
    await nightly(p.id); // back to lead
    await h.db.update(orders).set({ status: "paid", cancelledAt: null }).where(eq(orders.id, order.id));
    await nightly(p.id); // first_purchase again on the same day: deduped
    const events = await eventsOf(p.id, "ops.stage_changed");
    expect(events.map((e) => (e.data as { to: string }).to).sort()).toEqual(["first_purchase", "lead"]);
    expect(events.find((e) => (e.data as { to: string }).to === "first_purchase")!.dedupeKey).toMatch(
      new RegExp(`^stage:${p.id}:first_purchase:\\d{4}-\\d{2}-\\d{2}$`),
    );
  });

  it("R14 stage thresholds come from settings.retention_defaults: a longer stage_retention_days moves the boundary", async () => {
    const p = await makeCustomer(h.db);
    await makePaidOrder(h.db, { personId: p.id, order: { paidAt: daysAgo(100) } });
    expect((await nightly(p.id)).stageChanges).toEqual([]);
    const stage = async () => (await h.db.execute(sql`select b2c_stage from person_stats where person_id = ${p.id}`)) as unknown as { rows: { b2c_stage: string }[] };
    expect((await stage()).rows[0]!.b2c_stage).toBe("retention");
    await h.db.insert(settings).values({ key: "retention_defaults", value: { ...RETENTION_DEFAULTS, stage_retention_days: 120 } });
    const r = await nightly(p.id);
    expect(r.stageChanges).toMatchObject([{ from: "retention", to: "first_purchase" }]);
    await h.db.delete(settings).where(eq(settings.key, "retention_defaults"));
  });

  it("R14a a high-value non-member keeps their commercial stage and has is_high_value in v_person_profile", async () => {
    const p = await makeCustomer(h.db);
    await makePaidOrder(h.db, { personId: p.id, lines: [{ productKind: "package", unitAmountCents: RETENTION_DEFAULTS.high_value_revenue_cents }], order: { paidAt: daysAgo(3) } });
    await nightly(p.id);
    const res = (await h.db.execute(sql`select b2c_stage, is_high_value from v_person_profile where person_id = ${p.id}`)) as unknown as {
      rows: { b2c_stage: string; is_high_value: boolean }[];
    };
    expect(res.rows[0]).toEqual({ b2c_stage: "first_purchase", is_high_value: true });
  });
});

describe("inactivity events (rules 15-18)", () => {
  it("R15 R16 emits the threshold once (deduped by anchor date) and re-arms after a new visit", async () => {
    const p = await makeCustomer(h.db);
    await makeBooking(h.db, { personId: p.id, startsAt: daysAgo(31), status: "attended" });
    await nightly(p.id);
    await nightly(p.id);
    let events = await eventsOf(p.id, "person.inactive_days");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ days: 30, has_future_booking: false });
    expect(events[0]!.dedupeKey).toMatch(new RegExp(`^person:${p.id}:inactive:30:\\d{4}-\\d{2}-\\d{2}$`));
    // A newer visit moves the anchor; the same threshold fires again for the new anchor.
    await makeBooking(h.db, { personId: p.id, startsAt: daysAgo(30), status: "attended" });
    await nightly(p.id);
    events = await eventsOf(p.id, "person.inactive_days");
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.dedupeKey)).size).toBe(2);
  });

  it("R18 the event carries has_future_booking", async () => {
    const p = await makeCustomer(h.db);
    await makePaidOrder(h.db, { personId: p.id, order: { paidAt: daysAgo(61) } });
    await makeBooking(h.db, { personId: p.id, startsAt: daysAhead(5), status: "confirmed" });
    await nightly(p.id);
    expect((await eventsOf(p.id, "person.inactive_days")).map((e) => e.data)).toMatchObject([{ days: 60, has_future_booking: true }]);
  });

  it("R15 R16 the cut-over backfill emits nothing for old crossings, and leads never get an event", async () => {
    const imported = await makeCustomer(h.db);
    await makeHistory(h.db, { personId: imported.id, kind: "visit", occurredAt: daysAgo(200) });
    await makeHistory(h.db, { personId: imported.id, kind: "purchase", occurredAt: daysAgo(95), amountCents: 5_000 });
    const lead = await makeCustomer(h.db);
    const job = makeJobCtx(h.db, "ops.refresh_person_stats");
    await runRefreshPersonStats(job, {});
    expect(await eventsOf(imported.id, "person.inactive_days")).toEqual([]);
    expect(await eventsOf(lead.id, "person.inactive_days")).toEqual([]);
  });

  it("R16 a missed night is caught up within the 3-day window, not after it", async () => {
    const caught = await makeCustomer(h.db);
    const missed = await makeCustomer(h.db);
    await makeBooking(h.db, { personId: caught.id, startsAt: daysAgo(92), status: "attended" });
    await makeBooking(h.db, { personId: missed.id, startsAt: daysAgo(94), status: "attended" });
    await nightly(caught.id);
    await nightly(missed.id);
    expect((await eventsOf(caught.id, "person.inactive_days")).map((e) => e.data)).toMatchObject([{ days: 90 }]);
    expect(await eventsOf(missed.id, "person.inactive_days")).toEqual([]);
  });
});
