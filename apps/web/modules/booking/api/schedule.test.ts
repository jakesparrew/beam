import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { sessionExceptions, settings } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { DEFAULT_BUSINESS_HOURS, zonedTimeToUtc, type BusinessHours } from "@beam/core/booking";
import { resetRuntime } from "@/lib/testing";
import { getOpeningHours, nextOpeningAt } from "./schedule";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await h.db.delete(sessionExceptions);
  await h.db.delete(settings);
});

const name = { "nl-BE": "Gesloten", "fr-BE": "Fermé", en: "Closed" };

async function setHours(value: BusinessHours) {
  await h.db.insert(settings).values({ key: "business_hours", value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

describe("nextOpeningAt (booking spec 3.0b)", () => {
  it("Sunday evening returns the Tuesday opening (Monday is closed by default)", async () => {
    // 2027-02-07 is a Sunday; the default hours are Tue-Sun 08:30-19:00.
    const from = zonedTimeToUtc("2027-02-07", "20:00");
    expect(await nextOpeningAt(h.db, from)).toEqual(zonedTimeToUtc("2027-02-09", "08:30"));
  });

  it("returns `from` inside opening hours", async () => {
    const from = zonedTimeToUtc("2027-02-09", "10:15");
    expect(await nextOpeningAt(h.db, from)).toEqual(from);
  });

  it("skips a `closed` exception for every template", async () => {
    await h.db.insert(sessionExceptions).values({ onDate: "2027-02-09", kind: "closed", name });
    const from = zonedTimeToUtc("2027-02-07", "20:00");
    expect(await nextOpeningAt(h.db, from)).toEqual(zonedTimeToUtc("2027-02-10", "08:30"));
  });

  it("a `closed` exception for some templates only does not close the centre", async () => {
    await h.db.insert(sessionExceptions).values({ onDate: "2027-02-09", kind: "closed", name, templateIds: ["00000000-0000-4000-8000-000000000001"] });
    const from = zonedTimeToUtc("2027-02-07", "20:00");
    expect(await nextOpeningAt(h.db, from)).toEqual(zonedTimeToUtc("2027-02-09", "08:30"));
  });

  it("skips Easter Monday by default and returns it with includePublicHolidays", async () => {
    const open = { opens_at: "08:30", closes_at: "19:00" };
    await setHours({ ...DEFAULT_BUSINESS_HOURS, week: { ...DEFAULT_BUSINESS_HOURS.week, 1: open } });
    // Easter Monday 2026-04-06 (CEST).
    const from = zonedTimeToUtc("2026-04-06", "06:00");
    expect(await nextOpeningAt(h.db, from)).toEqual(zonedTimeToUtc("2026-04-07", "08:30"));
    expect(await nextOpeningAt(h.db, from, { includePublicHolidays: true })).toEqual(zonedTimeToUtc("2026-04-06", "08:30"));
  });

  it("returns null when nothing opens within 30 days", async () => {
    const week = { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null };
    await setHours({ ...DEFAULT_BUSINESS_HOURS, week });
    expect(await nextOpeningAt(h.db, zonedTimeToUtc("2027-02-07", "20:00"))).toBeNull();
  });
});

describe("getOpeningHours (booking spec 3.0b)", () => {
  it("returns the weekday hours, a special-hours exception and a closed day with its name", async () => {
    await h.db.insert(sessionExceptions).values([
      { onDate: "2027-02-10", kind: "special_hours", opensAt: "12:00", closesAt: "17:00", name: { "nl-BE": "Kortere dag", "fr-BE": "Journée courte", en: "Short day" } },
      { onDate: "2027-02-11", kind: "holiday", name },
    ]);
    const rows = await getOpeningHours(h.db, { from: "2027-02-08", to: "2027-02-11" });
    expect(rows).toEqual([
      { onDate: "2027-02-08", opensAt: null, closesAt: null, exceptionName: null },
      { onDate: "2027-02-09", opensAt: "08:30", closesAt: "19:00", exceptionName: null },
      { onDate: "2027-02-10", opensAt: "12:00", closesAt: "17:00", exceptionName: { "nl-BE": "Kortere dag", "fr-BE": "Journée courte", en: "Short day" } },
      { onDate: "2027-02-11", opensAt: null, closesAt: null, exceptionName: name },
    ]);
  });
});
