import { describe, expect, it } from "vitest";
import { belgianPublicHolidays } from "../platform/holidays";
import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from "./rules";
import {
  MATERIALISE_DAYS,
  addDays,
  brusselsDate,
  brusselsTime,
  diffTemplateSessions,
  eachDate,
  holidaySuggestions,
  isoWeekday,
  localDateTimeToUtc,
  nextOpening,
  planOccurrences,
  zonedTimeToUtc,
  type ExceptionLike,
  type TemplateLike,
} from "./schedule";

const day: TemplateLike = { id: "t-day", weekdays: [1, 2, 3, 4, 5, 6, 7], startTime: "10:00", durationMinutes: 120, activeFromOn: "2026-01-01", activeToOn: null };
const night: TemplateLike = { id: "t-night", weekdays: [5, 6], startTime: "21:00:00", durationMinutes: 720, activeFromOn: "2026-01-01", activeToOn: null };
const ex = (e: Partial<ExceptionLike> & Pick<ExceptionLike, "onDate" | "kind">): ExceptionLike => ({ templateIds: null, opensAt: null, closesAt: null, ...e });
const localStarts = (rows: Array<{ startsAt: Date }>) => rows.map((r) => `${brusselsDate(r.startsAt)} ${brusselsTime(r.startsAt)}`);

describe("date helpers", () => {
  it("knows ISO weekdays and date arithmetic", () => {
    expect(isoWeekday("2026-11-02")).toBe(1); // Monday
    expect(isoWeekday("2026-11-08")).toBe(7); // Sunday
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(eachDate("2026-11-01", "2026-11-03")).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
  });

  it("converts Brussels wall-clock times both ways", () => {
    expect(zonedTimeToUtc("2026-07-01", "10:00").toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(zonedTimeToUtc("2026-12-01", "10:00").toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(localDateTimeToUtc("2026-12-01T18:30").toISOString()).toBe("2026-12-01T17:30:00.000Z");
    expect(brusselsDate(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
  });
});

describe("planOccurrences (R1, R4)", () => {
  it("keeps only the template's weekdays", () => {
    const t = { ...day, weekdays: [2, 4] };
    expect(localStarts(planOccurrences(t, [], "2026-11-02", "2026-11-08"))).toEqual(["2026-11-03 10:00", "2026-11-05 10:00"]);
  });

  it("respects the validity range", () => {
    const t = { ...day, activeFromOn: "2026-11-04", activeToOn: "2026-11-06" };
    expect(planOccurrences(t, [], "2026-11-01", "2026-11-30").map((o) => brusselsDate(o.startsAt))).toEqual(["2026-11-04", "2026-11-05", "2026-11-06"]);
    expect(planOccurrences({ ...day, activeToOn: "2026-10-01" }, [], "2026-11-01", "2026-11-30")).toEqual([]);
  });

  it("suppresses closed and holiday dates, for all templates or only the listed ones", () => {
    const exceptions = [ex({ onDate: "2026-11-03", kind: "closed" }), ex({ onDate: "2026-11-04", kind: "holiday", templateIds: ["t-day"] }), ex({ onDate: "2026-11-05", kind: "closed", templateIds: ["other"] })];
    expect(planOccurrences(day, exceptions, "2026-11-03", "2026-11-05").map((o) => brusselsDate(o.startsAt))).toEqual(["2026-11-05"]);
  });

  it("suppresses starts outside special hours [opens_at, closes_at)", () => {
    const special = [ex({ onDate: "2026-11-03", kind: "special_hours", opensAt: "12:00", closesAt: "18:00" })];
    expect(planOccurrences(day, special, "2026-11-03", "2026-11-03")).toEqual([]);
    const late = { ...day, startTime: "12:00" };
    expect(planOccurrences(late, special, "2026-11-03", "2026-11-03")).toHaveLength(1);
    const atClose = { ...day, startTime: "18:00" };
    expect(planOccurrences(atClose, special, "2026-11-03", "2026-11-03")).toEqual([]);
  });

  it("keeps 10:00 local across the spring and autumn DST changes", () => {
    const spring = planOccurrences(day, [], "2026-03-28", "2026-03-29");
    expect(spring.map((o) => o.startsAt.toISOString())).toEqual(["2026-03-28T09:00:00.000Z", "2026-03-29T08:00:00.000Z"]);
    const autumn = planOccurrences(day, [], "2026-10-24", "2026-10-25");
    expect(autumn.map((o) => o.startsAt.toISOString())).toEqual(["2026-10-24T08:00:00.000Z", "2026-10-25T09:00:00.000Z"]);
    expect(localStarts([...spring, ...autumn]).every((s) => s.endsWith("10:00"))).toBe(true);
  });

  it("keeps a 21:00 night's real length of 720 minutes across DST", () => {
    const spring = planOccurrences(night, [], "2026-03-28", "2026-03-28")[0]!;
    expect(spring.startsAt.toISOString()).toBe("2026-03-28T20:00:00.000Z");
    expect(spring.endsAt.getTime() - spring.startsAt.getTime()).toBe(720 * 60_000);
    expect(brusselsTime(spring.endsAt)).toBe("10:00");
    const autumn = planOccurrences(night, [], "2026-10-24", "2026-10-24")[0]!;
    expect(autumn.startsAt.toISOString()).toBe("2026-10-24T19:00:00.000Z");
    expect(brusselsTime(autumn.endsAt)).toBe("08:00");
    const normal = planOccurrences(night, [], "2026-11-06", "2026-11-06")[0]!;
    expect(brusselsTime(normal.startsAt)).toBe("21:00");
    expect(brusselsTime(normal.endsAt)).toBe("09:00");
  });

  it("covers today plus 90 days (91 dates)", () => {
    const today = "2026-11-03";
    expect(planOccurrences(day, [], today, addDays(today, MATERIALISE_DAYS))).toHaveLength(91);
  });
});

describe("diffTemplateSessions (R2, R3)", () => {
  const at = (d: string) => zonedTimeToUtc(d, "10:00");
  it("keeps booked, waitlisted, held and manual sessions; updates, removes and inserts the rest", () => {
    const planned = [{ startsAt: at("2026-11-03") }, { startsAt: at("2026-11-04") }, { startsAt: at("2026-11-05") }];
    const existing = [
      { id: "free-match", startsAt: at("2026-11-03"), hasBookings: false, hasManualChanges: false },
      { id: "free-gone", startsAt: at("2026-11-06"), hasBookings: false, hasManualChanges: false },
      { id: "booked-gone", startsAt: at("2026-11-07"), hasBookings: true, hasManualChanges: false },
      { id: "manual-match", startsAt: at("2026-11-04"), hasBookings: false, hasManualChanges: true },
      { id: "held", startsAt: at("2026-11-08"), hasBookings: false, hasHolds: true, hasManualChanges: false },
      { id: "waiting", startsAt: at("2026-11-09"), hasBookings: false, hasWaitlistEntries: true, hasManualChanges: false },
    ];
    const diff = diffTemplateSessions(planned, existing);
    expect(diff.update).toEqual(["free-match"]);
    expect(diff.remove).toEqual(["free-gone"]);
    expect(diff.untouched.sort()).toEqual(["booked-gone", "held", "manual-match", "waiting"]);
    expect(diff.insert).toEqual([at("2026-11-05")]);
  });
});

describe("holidaySuggestions (R4b)", () => {
  const holidays = [2026, 2027, 2028].flatMap((y) => belgianPublicHolidays(y));
  it("lists platform's holidays for 2026-2028 without an exception", () => {
    const list = holidaySuggestions(holidays, [], "2026-01-01", "2028-12-31");
    expect(list).toHaveLength(30);
    expect(list).toContainEqual({ onDate: "2026-04-06", key: "easter_monday" });
    expect(list).toContainEqual({ onDate: "2026-05-14", key: "ascension" });
    expect(list).toContainEqual({ onDate: "2026-05-25", key: "whit_monday" });
    expect(list).toContainEqual({ onDate: "2027-03-29", key: "easter_monday" });
    expect(list).toContainEqual({ onDate: "2028-04-17", key: "easter_monday" });
  });

  it("does not suggest a date that already has an exception, nor dates outside the range", () => {
    const list = holidaySuggestions(holidays, [ex({ onDate: "2026-04-06", kind: "special_hours", opensAt: "10:00", closesAt: "14:00" })], "2026-04-01", "2026-05-31");
    expect(list.map((h) => h.key)).toEqual(["labour_day", "ascension", "whit_monday"]);
  });
});

describe("nextOpening (3.0b)", () => {
  const easter2027 = belgianPublicHolidays(2027);
  it("returns from when inside opening hours", () => {
    const from = zonedTimeToUtc("2026-11-04", "12:00"); // Wednesday
    expect(nextOpening(from, DEFAULT_BUSINESS_HOURS, [], [])).toEqual(from);
  });

  it("skips the closed Monday", () => {
    const sunday = zonedTimeToUtc("2026-11-08", "20:00");
    expect(nextOpening(sunday, DEFAULT_BUSINESS_HOURS, [], [])).toEqual(zonedTimeToUtc("2026-11-10", "08:30"));
  });

  it("uses special hours and skips closed exceptions for all templates", () => {
    const tuesday = zonedTimeToUtc("2026-11-10", "07:00");
    const special = [ex({ onDate: "2026-11-10", kind: "special_hours", opensAt: "12:00:00", closesAt: "15:00:00" })];
    expect(nextOpening(tuesday, DEFAULT_BUSINESS_HOURS, special, [])).toEqual(zonedTimeToUtc("2026-11-10", "12:00"));
    const closed = [ex({ onDate: "2026-11-10", kind: "closed" })];
    expect(nextOpening(tuesday, DEFAULT_BUSINESS_HOURS, closed, [])).toEqual(zonedTimeToUtc("2026-11-11", "08:30"));
    const onlyOne = [ex({ onDate: "2026-11-10", kind: "closed", templateIds: ["t-day"] })];
    expect(nextOpening(tuesday, DEFAULT_BUSINESS_HOURS, onlyOne, [])).toEqual(zonedTimeToUtc("2026-11-10", "08:30"));
  });

  it("skips Easter Monday when the holidays are passed", () => {
    const hours: BusinessHours = { ...DEFAULT_BUSINESS_HOURS, week: { ...DEFAULT_BUSINESS_HOURS.week, 1: { opens_at: "09:00", closes_at: "17:00" } } };
    const sundayNight = zonedTimeToUtc("2027-03-28", "20:00");
    expect(nextOpening(sundayNight, hours, [], easter2027)).toEqual(zonedTimeToUtc("2027-03-30", "08:30"));
    expect(nextOpening(sundayNight, hours, [], [])).toEqual(zonedTimeToUtc("2027-03-29", "09:00"));
  });

  it("returns null after 30 closed days", () => {
    const closed: BusinessHours = { ...DEFAULT_BUSINESS_HOURS, week: { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null } };
    expect(nextOpening(new Date("2026-11-03T10:00:00Z"), closed, [], [])).toBeNull();
    const exceptions = eachDate("2026-11-03", addDays("2026-11-03", 29)).map((d) => ex({ onDate: d, kind: "closed" }));
    expect(nextOpening(zonedTimeToUtc("2026-11-03", "10:00"), DEFAULT_BUSINESS_HOURS, exceptions, [])).toBeNull();
  });
});
