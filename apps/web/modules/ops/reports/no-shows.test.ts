/**
 * ops rule 39 (ops-P7): the no-show and cancellation report. Before each case every existing
 * person becomes a tester (testers are left out, rule 41), so each case sees only its own rows.
 * The period is September 2026; the pattern window is the 90 days before 1 October 2026.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings } from "@beam/db/schema";
import { createTestDb, makeSession } from "@beam/db/testing";
import { makeCreditGrant, makeEntry } from "@beam/db/testing/credits-factories";
import { sql } from "@/lib/ctx";
import { resetRuntime, staffActor } from "@/lib/testing";
import { makeCustomer } from "../dashboard/ops-p3.fixtures";
import { getNoShowReport } from "../retention/queries";
import { computeNoShowReport, parseDateRange } from "./no-shows";
import { REPORT_CSV } from "./registry";

let h: DbHandle;
const NOW = new Date("2026-11-05T10:00:00Z");
const RANGE = { from: "2026-09-01", to: "2026-09-30" };

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await h.db.execute(sql`update persons set is_tester = true where is_tester = false`);
});

type Status = "cancelled" | "late_cancelled" | "no_show" | "attended";

/** A booking of `personId` with `status` on a new day session starting at `startsAt` (Brussels 10:00 on a CEST date is 08:00Z). */
async function booking(personId: string, status: Status, startsAt: Date, opts: { sessionCancelled?: boolean; credit?: { unitValueCents: number; released?: boolean } } = {}) {
  const session = await makeSession(h.db, { startsAt, ...(opts.sessionCancelled ? { status: "cancelled" as const, cancelledAt: new Date(startsAt.getTime() - 86_400_000), cancelReason: "Heating failure" } : {}) });
  const cancelled = status === "cancelled" || status === "late_cancelled";
  const [b] = await h.db
    .insert(bookings)
    .values({
      sessionId: session.id,
      personId,
      status,
      paidWith: opts.credit ? "credit" : "free",
      source: "admin",
      ...(cancelled ? { cancelledAt: new Date(startsAt.getTime() - (status === "late_cancelled" ? 2 : 48) * 3_600_000), cancelReasonCode: opts.sessionCancelled ? "session_cancelled" : "customer" } : {}),
      ...(status === "attended" ? { attendedAt: startsAt } : {}),
    })
    .returning();
  if (opts.credit) {
    const grant = await makeCreditGrant(h.db, { personId, units: 10, unitValueCents: opts.credit.unitValueCents });
    const consume = await makeEntry(h.db, { grantId: grant.id, kind: "consume", quantity: -1, refType: "booking", refId: b!.id });
    if (opts.credit.released) await makeEntry(h.db, { grantId: grant.id, kind: "release", quantity: 1, refType: "booking", refId: b!.id, reversesEntryId: consume.id });
  }
  return b!;
}
const sept = (day: number) => new Date(Date.UTC(2026, 8, day, 8));

describe("rule 39: getNoShowReport", () => {
  it("totals per status, the no-show rate, and the value and credits forfeited", async () => {
    const p = await makeCustomer(h.db);
    await booking(p.id, "no_show", sept(2), { credit: { unitValueCents: 2_500 } });
    await booking(p.id, "late_cancelled", sept(3), { credit: { unitValueCents: 2_000 } });
    await booking(p.id, "cancelled", sept(4), { credit: { unitValueCents: 3_000, released: true } });
    await booking(p.id, "cancelled", sept(5));
    await booking(p.id, "attended", sept(6));
    await booking(p.id, "attended", sept(7));
    await booking(p.id, "attended", sept(8));
    await booking(p.id, "no_show", new Date(Date.UTC(2026, 9, 2, 8))); // October: outside the period
    const tester = await makeCustomer(h.db, { isTester: true });
    await booking(tester.id, "no_show", sept(9));

    const r = await computeNoShowReport(h.db, { range: RANGE, now: NOW });
    expect(r.totals).toEqual({ cancelled: 2, lateCancelled: 1, noShows: 1, attended: 3, rate: 0.25, valueForfeitedCents: 4_500, creditUnitsForfeited: 2 });
    expect(r.customers).toHaveLength(1);
    expect(r.customers[0]).toMatchObject({ personId: p.id, cancelled: 2, lateCancelled: 1, noShows: 1, attended: 3, rate: 0.25, valueForfeitedCents: 4_500, creditUnitsForfeited: 2 });
    expect(r.byWeekdayHour.reduce((n, c) => n + c.noShows + c.lateCancelled + c.cancelled, 0)).toBe(4);
    // 2 September 2026 is a Wednesday (ISO 3); 08:00Z is 10:00 Brussels.
    expect(r.byWeekdayHour.find((c) => c.weekday === 3 && c.hour === 10)).toMatchObject({ noShows: 1 });
    expect(r.byTemplate.reduce((n, c) => n + c.noShows, 0)).toBe(1);
  });

  it("flags a pattern at 3 no-shows in 90 days, not at 2 or with an older one", async () => {
    const three = await makeCustomer(h.db);
    for (const d of [2, 10, 20]) await booking(three.id, "no_show", sept(d));
    const two = await makeCustomer(h.db);
    for (const d of [2, 10]) await booking(two.id, "no_show", sept(d));
    await booking(two.id, "no_show", new Date(Date.UTC(2026, 4, 20, 8))); // May: more than 90 days before 1 October
    const r = await computeNoShowReport(h.db, { range: RANGE, now: NOW });
    expect(r.pattern).toEqual({ count: 3, days: 90 });
    expect(r.customers.find((c) => c.personId === three.id)).toMatchObject({ noShows: 3, recentNoShows: 3, pattern: true });
    expect(r.customers.find((c) => c.personId === two.id)).toMatchObject({ noShows: 2, recentNoShows: 2, pattern: false });
    expect(r.customers[0]!.personId).toBe(three.id);
  });

  it("shows sessions BEAM cancelled apart and never counts them in a customer's figures or pattern", async () => {
    const p = await makeCustomer(h.db);
    await booking(p.id, "no_show", sept(2));
    await booking(p.id, "no_show", sept(3));
    await booking(p.id, "no_show", sept(4), { sessionCancelled: true });
    await booking(p.id, "cancelled", sept(5), { sessionCancelled: true, credit: { unitValueCents: 2_000, released: true } });
    const r = await computeNoShowReport(h.db, { range: RANGE, now: NOW });
    expect(r.sessionCancelled).toEqual({ bookings: 2, sessions: 2 });
    expect(r.totals).toMatchObject({ cancelled: 0, noShows: 2 });
    expect(r.customers[0]).toMatchObject({ personId: p.id, noShows: 2, cancelled: 0, recentNoShows: 2, pattern: false });
  });

  it("needs reports.read, and the CSV has exactly the customer rows of the page", async () => {
    const p = await makeCustomer(h.db);
    await booking(p.id, "no_show", sept(2));
    const ctx = { tx: h.db, actor: staffActor({ permissions: ["reports.read"] }), now: NOW, locale: "en" as const };
    const page = await getNoShowReport(ctx, RANGE);
    expect(page.customers.map((c) => c.personId)).toEqual([p.id]);
    await expect(getNoShowReport({ ...ctx, actor: staffActor({ permissions: ["tasks.all"] }) }, RANGE)).rejects.toMatchObject({ name: "ForbiddenError" });
    const rows: unknown[][] = [];
    for await (const row of REPORT_CSV["no-shows"](ctx, RANGE)) rows.push(row);
    expect(rows).toEqual([[p.id, 0, 0, 1, 0, 1, 0, 0, 1, false]]);
  });

  it("parseDateRange defaults to the last 30 days and swaps a reversed range", () => {
    expect(parseDateRange({}, NOW)).toEqual({ from: "2026-10-07", to: "2026-11-05" });
    expect(parseDateRange({ from: "2026-09-30", to: "2026-09-01" }, NOW)).toEqual(RANGE);
    expect(parseDateRange({ from: "nope", to: "2026-09-30" }, NOW)).toEqual({ from: "2026-09-30", to: "2026-10-07" });
  });
});
