import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { capacityHolds, sessionExceptions, sessionTemplates, sessions, waitlistEntries } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { addDays, brusselsDate, brusselsTime, isoWeekday, zonedTimeToUtc } from "@beam/core/booking";
import { belgianPublicHolidays } from "@beam/core/platform";
import { asc, eq } from "@/lib/ctx";
import { makeJobCtx, resetRuntime, runJobTwice } from "@/lib/testing";
import { addBooking, clearSchedule, makeTemplate, queued } from "../actions/booking-p2.fixtures";
import { dateConflicts, materialiseRange, runMaterialise, runRegenerateDate, runRegenerateTemplate } from "./schedule";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => clearSchedule(h.db));

/** Monday 2027-02-01 03:10 in Brussels: the daily run. The window is 2027-02-01 .. 2027-05-02. */
const NOW = zonedTimeToUtc("2027-02-01", "03:10");
const TODAY = "2027-02-01";
const LAST = addDays(TODAY, 90);

const ctxFor = (kind: "sessions.materialise" | "sessions.regenerate_template" | "sessions.regenerate_date") => makeJobCtx(h.db, kind, { now: NOW });

const sessionsOf = (templateId: string) => h.db.select().from(sessions).where(eq(sessions.templateId, templateId)).orderBy(asc(sessions.startsAt));

/** Runs `sessions.materialise` and then every continuation it queued. */
async function materialiseAll(): Promise<number> {
  let inserted = 0;
  const first = await runMaterialise(ctxFor("sessions.materialise"), {});
  inserted += first.inserted;
  const done = new Set<string>();
  for (;;) {
    const next = (await queued(h.db, "sessions.materialise")).find((j) => !done.has(j.id));
    if (!next) break;
    done.add(next.id);
    inserted += (await runMaterialise(ctxFor("sessions.materialise"), next.payload as { fromOn: string; days: number })).inserted;
  }
  return inserted;
}

/** Dates of the window on which a Tue-Sun template runs. */
function tueToSunDates(): string[] {
  const out: string[] = [];
  for (let d = TODAY; d <= LAST; d = addDays(d, 1)) if (isoWeekday(d) !== 1) out.push(d);
  return out;
}

async function blocks() {
  return Promise.all(["09:00", "11:30", "14:00", "16:30"].map((startTime) => makeTemplate(h.db, { startTime })));
}

describe("sessions.materialise (R1)", () => {
  it("creates the expected sessions for today + 90 days in 30-day chunks", async () => {
    const templates = await blocks();
    const night = await makeTemplate(h.db, { kind: "night", weekdays: [5, 6], startTime: "21:00", durationMinutes: 720, capacitySeats: null, capacityBeds: 6, creditKind: "night" });
    const inserted = await materialiseAll();
    const dayDates = tueToSunDates();
    const nightDates = dayDates.filter((d) => [5, 6].includes(isoWeekday(d)));
    expect(dayDates).toHaveLength(78);
    expect(inserted).toBe(4 * dayDates.length + nightDates.length);
    for (const t of templates) {
      const rows = await sessionsOf(t.id);
      expect(rows.map((r) => brusselsDate(r.startsAt))).toEqual(dayDates);
      expect(new Set(rows.map((r) => brusselsTime(r.startsAt)))).toEqual(new Set([t.startTime.slice(0, 5)]));
      expect(rows[0]).toMatchObject({ kind: "day", capacitySeats: 12, creditKind: "day", templateVersion: 1, status: "open", hasManualChanges: false });
      expect(rows[0]!.publishedAt).not.toBeNull();
    }
    const nights = await sessionsOf(night.id);
    expect(nights).toHaveLength(nightDates.length);
    // A night across the end of summer time keeps its 720 real minutes.
    expect(nights.every((n) => n.endsAt.getTime() - n.startsAt.getTime() === 720 * 60_000)).toBe(true);
    // Continuations carry `materialise:<run date>:<fromOn>`.
    expect((await queued(h.db, "sessions.materialise")).map((j) => j.idempotencyKey)).toEqual([`materialise:${TODAY}:${addDays(TODAY, 30)}`, `materialise:${TODAY}:${addDays(TODAY, 60)}`]);
  });

  it("a double run leaves the same rows", async () => {
    await blocks();
    await runJobTwice(h.db, "sessions.materialise", { fromOn: "2027-03-01", days: 20 });
    const once = await h.db.select({ id: sessions.id, startsAt: sessions.startsAt }).from(sessions).orderBy(asc(sessions.startsAt));
    expect(once.length).toBeGreaterThan(0);
    await runJobTwice(h.db, "sessions.materialise", { fromOn: "2027-03-01", days: 20 });
    const twice = await h.db.select({ id: sessions.id, startsAt: sessions.startsAt }).from(sessions).orderBy(asc(sessions.startsAt));
    expect(twice).toEqual(once);
  });

  it("skips inactive templates, validity bounds and exceptions", async () => {
    await makeTemplate(h.db, { isActive: false });
    const bounded = await makeTemplate(h.db, { activeFromOn: "2027-02-10", activeToOn: "2027-02-14" });
    await h.db.insert(sessionExceptions).values({ onDate: "2027-02-12", kind: "closed", name: { "nl-BE": "Dicht", "fr-BE": "Fermé", en: "Closed" } });
    const { inserted } = await materialiseRange(h.db, TODAY, LAST);
    expect(inserted).toBe(4);
    expect((await sessionsOf(bounded.id)).map((s) => brusselsDate(s.startsAt))).toEqual(["2027-02-10", "2027-02-11", "2027-02-13", "2027-02-14"]);
  });
});

describe("sessions.regenerate_template (R2, R3)", () => {
  it("updates free sessions, keeps booked and manual ones, removes unmatched free ones", async () => {
    const t = await makeTemplate(h.db, { activeToOn: "2027-02-14" });
    await materialiseRange(h.db, TODAY, LAST);
    const before = await sessionsOf(t.id);
    expect(before).toHaveLength(12);
    const sunday = before.find((s) => brusselsDate(s.startsAt) === "2027-02-07")!;
    const tuesday = before.find((s) => brusselsDate(s.startsAt) === "2027-02-09")!;
    const saturday = before.find((s) => brusselsDate(s.startsAt) === "2027-02-13")!;
    const sundayHeld = before.find((s) => brusselsDate(s.startsAt) === "2027-02-14")!;
    const wednesdayWaiting = before.find((s) => brusselsDate(s.startsAt) === "2027-02-10")!;
    await addBooking(h.db, sunday.id, { status: "cancelled" });
    await h.db.update(sessions).set({ hasManualChanges: true, capacitySeats: 8 }).where(eq(sessions.id, tuesday.id));
    await addBooking(h.db, saturday.id);
    await h.db.insert(capacityHolds).values({ sessionId: sundayHeld.id, kind: "staff", quantity: 2 });
    await h.db.insert(waitlistEntries).values({ sessionId: wednesdayWaiting.id, personId: (await makePerson(h.db)).id });

    // The edit: no more Sundays, 10 seats, 90 minutes (what `updateTemplate` writes).
    await h.db.update(sessionTemplates).set({ weekdays: [2, 3, 4, 5, 6], capacitySeats: 10, durationMinutes: 90, version: 2 }).where(eq(sessionTemplates.id, t.id));
    const first = await runRegenerateTemplate(ctxFor("sessions.regenerate_template"), { templateId: t.id });
    const after = await sessionsOf(t.id);
    // Sunday 2027-02-07 has a (cancelled) booking: kept. Sunday 2027-02-14 has a hold: kept.
    expect(after.map((s) => brusselsDate(s.startsAt))).toEqual(["2027-02-02", "2027-02-03", "2027-02-04", "2027-02-05", "2027-02-06", "2027-02-07", "2027-02-09", "2027-02-10", "2027-02-11", "2027-02-12", "2027-02-13", "2027-02-14"]);
    expect(first).toEqual({ inserted: 0, updated: 7, removed: 0, untouched: 5 });
    const byId = new Map(after.map((s) => [s.id, s]));
    expect(byId.get(tuesday.id)).toMatchObject({ capacitySeats: 8, templateVersion: 1 });
    expect(byId.get(saturday.id)).toMatchObject({ capacitySeats: 12, templateVersion: 1 });
    expect(byId.get(wednesdayWaiting.id)).toMatchObject({ capacitySeats: 12 });
    const free = after.find((s) => brusselsDate(s.startsAt) === "2027-02-11")!;
    expect(free).toMatchObject({ capacitySeats: 10, templateVersion: 2 });
    expect(free.endsAt.getTime() - free.startsAt.getTime()).toBe(90 * 60_000);

    // A free Sunday disappears, and a new start time replaces the free sessions.
    await h.db.delete(capacityHolds);
    await h.db.update(sessionTemplates).set({ startTime: "10:00", version: 3 }).where(eq(sessionTemplates.id, t.id));
    const second = await runRegenerateTemplate(ctxFor("sessions.regenerate_template"), { templateId: t.id });
    expect(second).toMatchObject({ removed: 8, inserted: 10 });
    const last = await sessionsOf(t.id);
    expect(last.filter((s) => brusselsTime(s.startsAt) === "09:00").map((s) => s.id).sort()).toEqual([sunday.id, tuesday.id, wednesdayWaiting.id, saturday.id].sort());
    expect(last.filter((s) => brusselsTime(s.startsAt) === "10:00")).toHaveLength(10);
    // Idempotent: the same version again changes nothing.
    expect(await runRegenerateTemplate(ctxFor("sessions.regenerate_template"), { templateId: t.id })).toMatchObject({ inserted: 0, removed: 0 });
  });

  it("an unknown template is a permanent error", async () => {
    await expect(runRegenerateTemplate(ctxFor("sessions.regenerate_template"), { templateId: "00000000-0000-4000-8000-000000000009" })).rejects.toThrow(/unknown session template/);
  });
});

describe("sessions.regenerate_date (R4, R4b)", () => {
  const onDate = "2027-02-09";

  it("a closed day removes free sessions and reports booked ones; deleting the exception re-inserts them", async () => {
    const templates = await blocks();
    await materialiseRange(h.db, TODAY, LAST);
    const ofDay = async () => (await h.db.select().from(sessions).orderBy(asc(sessions.startsAt))).filter((s) => brusselsDate(s.startsAt) === onDate);
    const booked = (await ofDay()).find((s) => s.templateId === templates[1]!.id)!;
    await addBooking(h.db, booked.id);
    await addBooking(h.db, booked.id);

    const [exception] = await h.db.insert(sessionExceptions).values({ onDate, kind: "closed", name: { "nl-BE": "Dicht", "fr-BE": "Fermé", en: "Closed" } }).returning();
    const result = await runRegenerateDate(ctxFor("sessions.regenerate_date"), { onDate });
    expect(result).toEqual({ inserted: 0, removed: 3, conflicts: [{ sessionId: booked.id, startsAt: booked.startsAt, liveBookings: 2 }] });
    expect((await ofDay()).map((s) => s.id)).toEqual([booked.id]);
    expect(booked.status).toBe("open");
    // Double run: nothing more to do, same conflicts.
    expect(await runRegenerateDate(ctxFor("sessions.regenerate_date"), { onDate })).toEqual({ ...result, removed: 0 });
    // Other dates are untouched.
    expect((await h.db.select().from(sessions)).filter((s) => brusselsDate(s.startsAt) === "2027-02-10")).toHaveLength(4);

    await h.db.delete(sessionExceptions).where(eq(sessionExceptions.id, exception!.id));
    const back = await runRegenerateDate(ctxFor("sessions.regenerate_date"), { onDate });
    expect(back).toEqual({ inserted: 3, removed: 0, conflicts: [] });
    expect(await ofDay()).toHaveLength(4);
  });

  it("special hours remove only the blocks outside [opens_at, closes_at); a template filter narrows it", async () => {
    const templates = await blocks();
    await materialiseRange(h.db, TODAY, LAST);
    await h.db.insert(sessionExceptions).values({ onDate, kind: "special_hours", opensAt: "11:00", closesAt: "16:30", name: { "nl-BE": "Kort", "fr-BE": "Court", en: "Short" } });
    expect(await runRegenerateDate(ctxFor("sessions.regenerate_date"), { onDate })).toMatchObject({ removed: 2 });
    const left = (await h.db.select().from(sessions)).filter((s) => brusselsDate(s.startsAt) === onDate).map((s) => brusselsTime(s.startsAt)).sort();
    expect(left).toEqual(["11:30", "14:00"]);

    await h.db.delete(sessionExceptions);
    await h.db.insert(sessionExceptions).values({ onDate, kind: "closed", templateIds: [templates[0]!.id], name: { "nl-BE": "Dicht", "fr-BE": "Fermé", en: "Closed" } });
    expect(await runRegenerateDate(ctxFor("sessions.regenerate_date"), { onDate })).toMatchObject({ inserted: 1, removed: 0 });
    const now = (await h.db.select().from(sessions)).filter((s) => brusselsDate(s.startsAt) === onDate).map((s) => brusselsTime(s.startsAt)).sort();
    expect(now).toEqual(["11:30", "14:00", "16:30"]);
  });

  it("“Close this day” on a Belgian public holiday removes its sessions", async () => {
    // Labour Day 2027-05-01 is a Saturday, inside the 90-day window of 2027-02-01.
    const holiday = belgianPublicHolidays(2027).find((x) => x.key === "labour_day")!;
    expect(holiday.on).toBe("2027-05-01");
    await blocks();
    await materialiseRange(h.db, TODAY, LAST);
    const onHoliday = async () => (await h.db.select().from(sessions)).filter((s) => brusselsDate(s.startsAt) === holiday.on);
    expect(await onHoliday()).toHaveLength(4);
    await h.db.insert(sessionExceptions).values({ onDate: holiday.on, kind: "holiday", name: { "nl-BE": "Dag van de Arbeid", "fr-BE": "Fête du Travail", en: "Labour Day" } });
    expect(await runRegenerateDate(ctxFor("sessions.regenerate_date"), { onDate: holiday.on })).toEqual({ inserted: 0, removed: 4, conflicts: [] });
    expect(await onHoliday()).toHaveLength(0);
    // The daily run does not bring them back.
    expect((await materialiseRange(h.db, TODAY, LAST)).inserted).toBe(0);
    expect(await dateConflicts(h.db, holiday.on, NOW)).toEqual([]);
  });
});
