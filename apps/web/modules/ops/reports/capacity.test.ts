/**
 * The capacity report (ops-P7, R2) over booking's `v_session_utilisation`: its figures equal the
 * view's (sums, the largest waitlist peak, the capacity-weighted utilisation), grouped by session
 * template, ISO weekday, Brussels start hour and month. Each case uses its own months, so the
 * sessions of one case never fall in the range of another.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, sessionTemplates } from "@beam/db/schema";
import { vSessionUtilisation } from "@beam/db/schema";
import { createTestDb, makeSession } from "@beam/db/testing";
import { and, gte, lte } from "@/lib/ctx";
import { resetRuntime, staffActor } from "@/lib/testing";
import { makeCustomer } from "../dashboard/ops-p3.fixtures";
import { getCapacityReport } from "../retention/queries";
import { computeCapacityReport } from "./capacity";
import { REPORT_CSV } from "./registry";

let h: DbHandle;
const NOW = new Date("2026-11-05T10:00:00Z");

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

async function template(en: string) {
  const [t] = await h.db
    .insert(sessionTemplates)
    .values({ kind: "day", name: { "nl-BE": en, "fr-BE": en, en }, weekdays: [1, 2, 3, 4, 5, 6, 7], startTime: "10:00", durationMinutes: 120, capacitySeats: 10, creditKind: "day", activeFromOn: "2026-01-01" })
    .returning();
  return t!;
}

/** A session with `booked` confirmed bookings (`attended` of them attended when the session is past). */
async function session(startsAt: Date, opts: { templateId?: string; seats?: number; booked?: number; attended?: number; noShows?: number; cancelled?: number }) {
  const s = await makeSession(h.db, { startsAt, capacitySeats: opts.seats ?? 10, ...(opts.templateId ? { templateId: opts.templateId } : {}) });
  const add = async (status: "confirmed" | "attended" | "no_show" | "cancelled", n: number) => {
    for (let i = 0; i < n; i++) {
      const p = await makeCustomer(h.db);
      await h.db.insert(bookings).values({
        sessionId: s.id,
        personId: p.id,
        status,
        paidWith: "free",
        source: "admin",
        ...(status === "attended" ? { attendedAt: startsAt } : {}),
        ...(status === "cancelled" ? { cancelledAt: new Date(startsAt.getTime() - 2 * 86_400_000), cancelReasonCode: "customer" as const } : {}),
      });
    }
  };
  await add("confirmed", opts.booked ?? 0);
  await add("attended", opts.attended ?? 0);
  await add("no_show", opts.noShows ?? 0);
  await add("cancelled", opts.cancelled ?? 0);
  return s;
}

const viewRows = (from: string, to: string) => h.db.select().from(vSessionUtilisation).where(and(gte(vSessionUtilisation.dayOn, from), lte(vSessionUtilisation.dayOn, to)));

describe("capacity report", () => {
  it("by template: the figures equal v_session_utilisation", async () => {
    const yoga = await template("Morning sauna");
    const evening = await template("Evening sauna");
    // Past sessions (June 2026): utilisation counts attended and no-show units.
    await session(new Date("2026-06-01T08:00:00Z"), { templateId: yoga.id, seats: 10, attended: 4, noShows: 1, cancelled: 1 });
    await session(new Date("2026-06-02T08:00:00Z"), { templateId: yoga.id, seats: 20, attended: 2 });
    await session(new Date("2026-06-03T16:00:00Z"), { templateId: evening.id, seats: 8, attended: 8 });
    const range = { from: "2026-06-01", to: "2026-06-30" };
    const r = await computeCapacityReport(h.db, { range, groupBy: "template" });
    const view = await viewRows(range.from, range.to);
    expect(r.total.sessions).toBe(view.length);
    const sum = (k: "capacity" | "attended" | "noShows" | "cancellations" | "bookedTotal") => view.reduce((n, v) => n + Number(v[k]), 0);
    expect(r.total).toMatchObject({ capacity: sum("capacity"), attended: sum("attended"), noShows: sum("noShows"), cancellations: sum("cancellations"), bookedTotal: sum("bookedTotal") });
    const y = r.rows.find((x) => x.key === yoga.id)!;
    const yv = view.filter((v) => v.templateId === yoga.id);
    expect(y).toMatchObject({ name: { en: "Morning sauna" }, sessions: 2, capacity: 30, attended: 6, noShows: 1, cancellations: 1 });
    const weighted = yv.reduce((n, v) => n + Number(v.utilisationPct) * v.capacity, 0) / yv.reduce((n, v) => n + v.capacity, 0);
    expect(y.utilisationPct).toBeCloseTo(Math.round(weighted * 10) / 10, 5);
    expect(r.rows.find((x) => x.key === evening.id)).toMatchObject({ sessions: 1, utilisationPct: Number(view.find((v) => v.templateId === evening.id)!.utilisationPct) });
  });

  it("groups by ISO weekday, Brussels start hour and month", async () => {
    // Upcoming sessions (2027): utilisation counts booked units.
    await session(new Date("2027-01-04T09:00:00Z"), { booked: 5 }); // Monday 10:00 Brussels
    await session(new Date("2027-01-11T09:00:00Z"), { booked: 3 }); // Monday 10:00
    await session(new Date("2027-01-06T17:00:00Z"), { booked: 10 }); // Wednesday 18:00
    await session(new Date("2027-02-03T17:00:00Z"), { booked: 1 }); // Wednesday 18:00, February
    const range = { from: "2027-01-01", to: "2027-02-28" };
    const byWeekday = await computeCapacityReport(h.db, { range, groupBy: "weekday" });
    expect(byWeekday.rows.map((r) => [r.key, r.sessions, r.bookedTotal])).toEqual([
      ["1", 2, 8],
      ["3", 2, 11],
    ]);
    expect(byWeekday.rows[0]!.utilisationPct).toBe(40);
    const byHour = await computeCapacityReport(h.db, { range, groupBy: "hour" });
    expect(byHour.rows.map((r) => [r.key, r.sessions])).toEqual([
      ["10", 2],
      ["18", 2],
    ]);
    const byMonth = await computeCapacityReport(h.db, { range, groupBy: "month" });
    expect(byMonth.rows.map((r) => [r.key, r.sessions, r.bookedTotal, r.utilisationPct])).toEqual([
      ["2027-01", 3, 18, 60],
      ["2027-02", 1, 1, 10],
    ]);
  });

  it("needs reports.read; defaults to the past and next 90 days; the CSV has exactly the grouped rows", async () => {
    await session(new Date("2026-11-20T09:00:00Z"), { booked: 2 });
    const ctx = { tx: h.db, actor: staffActor({ permissions: ["reports.read"] }), now: NOW, locale: "en" as const };
    const page = await getCapacityReport(ctx, { groupBy: "month" });
    expect(page.range).toEqual({ from: "2026-08-07", to: "2027-02-03" });
    await expect(getCapacityReport({ ...ctx, actor: staffActor({ permissions: [] }) })).rejects.toMatchObject({ name: "ForbiddenError" });
    const rows: unknown[][] = [];
    for await (const row of REPORT_CSV.capacity(ctx, { groupBy: "month" })) rows.push(row);
    expect(rows.map((r) => r[1])).toEqual(page.rows.map((r) => r.key));
    expect(rows.every((r) => r[0] === "month")).toBe(true);
  });
});
