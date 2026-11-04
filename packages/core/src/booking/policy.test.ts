import { describe, expect, it } from "vitest";
import { InvalidTransitionError, isBookingConflict } from "./errors";
import {
  BOOKING_TRANSITIONS,
  bookingTransition,
  canReschedule,
  cancellationOutcome,
  freeCancelUntil,
  overlapsByLocation,
  sessionTransition,
  type BookingLike,
} from "./policy";
import { DEFAULT_BOOKING_RULES as RULES, DEFAULT_BUSINESS_HOURS } from "./rules";
import { openingHoursFor, type ExceptionLike } from "./schedule";
import { BOOKING_STATUSES, SESSION_STATUSES, type ActorKind, type BookingStatus } from "./types";

const H = 3_600_000;
const START = new Date("2026-11-20T09:00:00Z");
const before = (ms: number) => new Date(START.getTime() - ms);

describe("cancellationOutcome (R28, R29)", () => {
  it("day: free until exactly 24 h before start, late one second after", () => {
    const b = { kind: "day" as const, startsAt: START, paidWith: "credit" as const };
    expect(cancellationOutcome(b, RULES, before(24 * H))).toEqual({ status: "cancelled", releaseCredit: true, refund: false, freeUntil: before(24 * H) });
    expect(cancellationOutcome(b, RULES, before(24 * H - 1000))).toEqual({ status: "late_cancelled", releaseCredit: false, refund: false, freeUntil: before(24 * H) });
  });

  it("night: 72 h window; order-paid rows are refunded inside it only", () => {
    const b = { kind: "night" as const, startsAt: START, paidWith: "order" as const };
    expect(cancellationOutcome(b, RULES, before(72 * H))).toMatchObject({ status: "cancelled", refund: true, releaseCredit: false });
    expect(cancellationOutcome(b, RULES, before(72 * H - 1000))).toMatchObject({ status: "late_cancelled", refund: false });
  });

  it("events with a null window are never free", () => {
    const b = { kind: "event" as const, startsAt: START, paidWith: "order" as const };
    expect(freeCancelUntil("event", START, RULES)).toBeNull();
    expect(cancellationOutcome(b, RULES, before(1000 * H))).toEqual({ status: "late_cancelled", releaseCredit: false, refund: false, freeUntil: null });
  });

  it("late_cancel_releases_credit releases credits on late cancellation", () => {
    const rules = { ...RULES, late_cancel_releases_credit: true };
    expect(cancellationOutcome({ kind: "day", startsAt: START, paidWith: "guest" }, rules, before(H))).toMatchObject({ status: "late_cancelled", releaseCredit: true });
    expect(cancellationOutcome({ kind: "day", startsAt: START, paidWith: "order" }, rules, before(H))).toMatchObject({ releaseCredit: false, refund: false });
  });

  it("free bookings release nothing", () => {
    expect(cancellationOutcome({ kind: "day", startsAt: START, paidWith: "free" }, RULES, before(48 * H))).toMatchObject({ status: "cancelled", releaseCredit: false, refund: false });
  });
});

describe("canReschedule (R31)", () => {
  const from: BookingLike = { kind: "day", startsAt: START, paidWith: "credit", creditKind: "day", productId: "p1" };
  const to = { kind: "day" as const, startsAt: new Date(START.getTime() + 48 * H), creditKind: "day" as const, productId: "p1" };
  const now = before(48 * H);
  it("allows a same-kind move inside the free window", () => {
    expect(canReschedule(from, to, RULES, 0, now)).toEqual({ ok: true });
    expect(canReschedule(from, to, RULES, 1, now)).toEqual({ ok: true });
  });
  it("refuses outside the window", () => {
    expect(canReschedule(from, to, RULES, 0, before(24 * H - 1))).toEqual({ ok: false, code: "outside_window" });
    expect(canReschedule({ ...from, kind: "event", creditKind: null }, { ...to, kind: "event", creditKind: null }, RULES, 0, now)).toEqual({ ok: false, code: "outside_window" });
  });
  it("refuses another kind or credit kind", () => {
    expect(canReschedule(from, { ...to, kind: "night", creditKind: "night" }, RULES, 0, now)).toEqual({ ok: false, code: "different_kind" });
    expect(canReschedule(from, { ...to, creditKind: null }, RULES, 0, now)).toEqual({ ok: false, code: "different_kind" });
  });
  it("refuses another product for order-paid rows only", () => {
    expect(canReschedule({ ...from, paidWith: "order" }, { ...to, productId: "p2" }, RULES, 0, now)).toEqual({ ok: false, code: "different_product" });
    expect(canReschedule(from, { ...to, productId: "p2" }, RULES, 0, now)).toEqual({ ok: true });
  });
  it("refuses after max_reschedules_per_booking along the chain", () => {
    expect(canReschedule(from, to, RULES, 2, now)).toEqual({ ok: false, code: "too_many" });
  });
});

describe("bookingTransition (R27b)", () => {
  const allowed: Array<[BookingStatus | null, BookingStatus, ActorKind]> = [
    [null, "reserved", "customer"],
    [null, "reserved", "staff"],
    [null, "reserved", "public"],
    [null, "confirmed", "customer"],
    [null, "confirmed", "staff"],
    [null, "confirmed", "public"],
    [null, "confirmed", "system"],
    ["reserved", "confirmed", "webhook"],
    ["reserved", "confirmed", "staff"],
    ["reserved", "confirmed", "customer"],
    ["reserved", "confirmed", "system"],
    ["reserved", "cancelled", "system"],
    ["reserved", "cancelled", "webhook"],
    ["reserved", "cancelled", "staff"],
    ["confirmed", "cancelled", "customer"],
    ["confirmed", "cancelled", "staff"],
    ["confirmed", "cancelled", "system"],
    ["confirmed", "late_cancelled", "customer"],
    ["confirmed", "late_cancelled", "staff"],
    ["confirmed", "attended", "staff"],
    ["confirmed", "no_show", "system"],
    ["confirmed", "no_show", "staff"],
    ["attended", "confirmed", "staff"],
    ["no_show", "attended", "staff"],
    ["late_cancelled", "cancelled", "staff"],
  ];

  it.each(allowed)("%s -> %s by %s is allowed", (from, to, actor) => {
    expect(() => bookingTransition(from, to, actor)).not.toThrow();
  });

  it("forbids every status pair outside the table", () => {
    const pairs = new Set(Object.entries(BOOKING_TRANSITIONS).flatMap(([from, tos]) => Object.keys(tos).map((to) => `${from}>${to}`)));
    let checked = 0;
    for (const from of [null, ...BOOKING_STATUSES]) {
      for (const to of BOOKING_STATUSES) {
        if (pairs.has(`${from ?? "new"}>${to}`)) continue;
        checked++;
        for (const actor of ["staff", "customer", "system", "webhook", "public"] as const) {
          expect(() => bookingTransition(from, to, actor)).toThrow(InvalidTransitionError);
        }
      }
    }
    expect(checked).toBe(7 * 6 - pairs.size);
  });

  it("forbids the listed pairs for actors that may not make them", () => {
    const forbidden: Array<[BookingStatus | null, BookingStatus, ActorKind]> = [
      ["reserved", "cancelled", "customer"],
      ["reserved", "cancelled", "public"],
      ["confirmed", "attended", "customer"],
      ["confirmed", "attended", "system"],
      ["confirmed", "late_cancelled", "system"],
      ["confirmed", "no_show", "customer"],
      ["attended", "confirmed", "system"],
      ["no_show", "attended", "customer"],
      ["late_cancelled", "cancelled", "customer"],
      [null, "reserved", "system"],
      [null, "confirmed", "webhook"],
    ];
    for (const [from, to, actor] of forbidden) expect(() => bookingTransition(from, to, actor)).toThrow(InvalidTransitionError);
  });

  it("cancelled is terminal and the error is a conflict with reason invalid_transition", () => {
    try {
      bookingTransition("cancelled", "confirmed", "staff");
      expect.unreachable();
    } catch (e) {
      expect(isBookingConflict(e, "invalid_transition")).toBe(true);
      expect((e as InvalidTransitionError).code).toBe("conflict");
      expect((e as InvalidTransitionError).message).toBe("invalid_transition");
    }
  });
});

describe("sessionTransition", () => {
  const allowed = new Set(["open>closed", "closed>open", "open>cancelled", "closed>cancelled"]);
  for (const from of SESSION_STATUSES) {
    for (const to of SESSION_STATUSES) {
      const ok = allowed.has(`${from}>${to}`);
      it(`${from} -> ${to} is ${ok ? "allowed" : "forbidden"}`, () => {
        if (ok) expect(() => sessionTransition(from, to)).not.toThrow();
        else expect(() => sessionTransition(from, to)).toThrow(InvalidTransitionError);
      });
    }
  }
});

describe("openingHoursFor (3.0b)", () => {
  const ex = (e: Partial<ExceptionLike> & Pick<ExceptionLike, "onDate" | "kind">): ExceptionLike => ({ templateIds: null, opensAt: null, closesAt: null, ...e });
  it("uses the weekday's business hours; Monday is closed", () => {
    expect(openingHoursFor("2026-11-03", DEFAULT_BUSINESS_HOURS, [])).toEqual({ opensAt: "08:30", closesAt: "19:00" });
    expect(openingHoursFor("2026-11-02", DEFAULT_BUSINESS_HOURS, [])).toBeNull();
  });
  it("a special-hours exception replaces the day's hours", () => {
    const special = [ex({ onDate: "2026-12-24", kind: "special_hours", opensAt: "10:00:00", closesAt: "15:00:00" })];
    expect(openingHoursFor("2026-12-24", DEFAULT_BUSINESS_HOURS, special)).toEqual({ opensAt: "10:00", closesAt: "15:00" });
    expect(openingHoursFor("2026-12-23", DEFAULT_BUSINESS_HOURS, special)).toEqual({ opensAt: "08:30", closesAt: "19:00" });
  });
  it("a closed or holiday exception for every template closes the day; a template-specific one does not", () => {
    expect(openingHoursFor("2026-12-25", DEFAULT_BUSINESS_HOURS, [ex({ onDate: "2026-12-25", kind: "holiday" })])).toBeNull();
    expect(openingHoursFor("2026-12-26", DEFAULT_BUSINESS_HOURS, [ex({ onDate: "2026-12-26", kind: "closed", templateIds: ["t1"] })])).not.toBeNull();
  });
});

describe("overlapsByLocation (R6b)", () => {
  const at = (h: number) => new Date(START.getTime() + h * H);
  const others = [
    { id: "same-room-overlap", location: " Sauna Hall ", startsAt: at(1), endsAt: at(3) },
    { id: "same-room-after", location: "sauna hall", startsAt: at(2), endsAt: at(4) },
    { id: "other-room", location: "Garden", startsAt: at(0), endsAt: at(2) },
    { id: "no-room", location: null, startsAt: at(0), endsAt: at(2) },
  ];
  it("matches the same room case-insensitively when the times overlap", () => {
    expect(overlapsByLocation({ location: "SAUNA HALL", startsAt: at(0), endsAt: at(2) }, others)).toEqual(["same-room-overlap"]);
  });
  it("returns nothing without a location", () => {
    expect(overlapsByLocation({ location: null, startsAt: at(0), endsAt: at(2) }, others)).toEqual([]);
    expect(overlapsByLocation({ location: "  ", startsAt: at(0), endsAt: at(2) }, others)).toEqual([]);
  });
});
