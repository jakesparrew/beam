import { describe, expect, it } from "vitest";
import { BookingConflictError, InvalidTransitionError, ProtectedSeatError } from "./errors";
import { DEFAULT_BOOKING_RULES as RULES } from "./rules";
import { WAITLIST_STATES, type ActorKind, type WaitlistQueue, type WaitlistState } from "./types";
import { WAITLIST_TRANSITIONS, nextOfferCandidates, offerExpiry, queuePosition, transition, type WaitlistLike } from "./waitlist";

const T0 = new Date("2026-11-03T10:00:00Z");
const entry = (p: Partial<WaitlistLike> = {}): WaitlistLike => ({
  id: "e1",
  personId: "p1",
  queue: "public",
  state: "waiting",
  joinedAt: T0,
  offersCount: 0,
  rejoinCount: 0,
  isFlaggedDuplicate: false,
  endedReason: null,
  ...p,
});

describe("transition (R41)", () => {
  const allowed: Array<[WaitlistState, WaitlistState]> = [
    ["waiting", "offered"],
    ["waiting", "withdrawn"],
    ["waiting", "released"],
    ["offered", "confirmed"],
    ["offered", "expired"],
    ["offered", "released"],
    ["offered", "withdrawn"],
    ["expired", "waiting"],
    ["released", "waiting"],
    ["withdrawn", "waiting"],
  ];

  it.each(allowed)("%s -> %s is allowed", (from, to) => {
    expect(transition(entry({ state: from }), to, "staff").state).toBe(to);
  });

  it("forbids every other pair with InvalidTransitionError", () => {
    const ok = new Set(allowed.map(([a, b]) => `${a}>${b}`));
    let forbidden = 0;
    for (const from of WAITLIST_STATES) {
      if (from === "confirmed") continue;
      for (const to of WAITLIST_STATES) {
        if (ok.has(`${from}>${to}`)) continue;
        forbidden++;
        expect(() => transition(entry({ state: from }), to, "staff")).toThrow(InvalidTransitionError);
      }
    }
    expect(forbidden).toBe(5 * 6 - allowed.length);
    expect(Object.values(WAITLIST_TRANSITIONS).flat()).toHaveLength(allowed.length);
  });

  it("a confirmed entry is protected from every actor, the system first of all", () => {
    for (const actor of ["system", "staff", "customer", "webhook", "public"] as ActorKind[]) {
      for (const to of WAITLIST_STATES) {
        expect(() => transition(entry({ state: "confirmed" }), to, actor)).toThrow(ProtectedSeatError);
      }
    }
    try {
      transition(entry({ state: "confirmed" }), "released", "system");
    } catch (e) {
      expect((e as ProtectedSeatError).reason).toBe("protected_seat");
      expect((e as ProtectedSeatError).code).toBe("conflict");
    }
  });

  it("an offer counts offers_count + 1", () => {
    expect(transition(entry({ offersCount: 1 }), "offered", "system")).toMatchObject({ state: "offered", offersCount: 2 });
  });

  it("rejoins once, resetting the flag and the ended reason (R40)", () => {
    const back = transition(entry({ state: "expired", endedReason: "offer_timeout", isFlaggedDuplicate: true }), "waiting", "customer");
    expect(back).toMatchObject({ state: "waiting", rejoinCount: 1, isFlaggedDuplicate: false, endedReason: null });
    const second = () => transition(entry({ state: "withdrawn", rejoinCount: 1, endedReason: "customer" }), "waiting", "customer");
    expect(second).toThrow(BookingConflictError);
    try {
      second();
    } catch (e) {
      expect((e as BookingConflictError).reason).toBe("already_waiting");
    }
  });

  it("refuses a rejoin after session_started, session_cancelled or flag_withdrawn", () => {
    for (const endedReason of ["session_started", "session_cancelled", "flag_withdrawn"]) {
      expect(() => transition(entry({ state: "released", endedReason }), "waiting", "customer")).toThrow(InvalidTransitionError);
    }
  });
});

describe("nextOfferCandidates (R42, R24, R25)", () => {
  const at = (min: number) => new Date(T0.getTime() + min * 60_000);
  const e = (id: string, queue: WaitlistQueue, joinedMin: number, p: Partial<WaitlistLike> = {}) => entry({ id, personId: `p-${id}`, queue, joinedAt: at(joinedMin), ...p });
  const list = [
    e("pub1", "public", 1),
    e("lead1", "lead", 2),
    e("cust1", "customer", 3),
    e("lead2", "lead", 0),
    e("cust2", "customer", 4),
    e("flagged", "customer", -5, { isFlaggedDuplicate: true }),
    e("offered", "public", -4, { state: "offered" }),
    e("maxed", "public", -3, { offersCount: 2 }),
  ];
  const ids = (xs: WaitlistLike[]) => xs.map((x) => x.id);

  it("non-lead-magnet and lead phases: every queue by joined_at", () => {
    expect(ids(nextOfferCandidates(list, "none", "general", 10))).toEqual(["lead2", "pub1", "lead1", "cust1", "cust2"]);
    expect(ids(nextOfferCandidates(list, "lead", "general", 2))).toEqual(["lead2", "pub1"]);
  });

  it("lead pool: the lead queue only, and nothing before the window", () => {
    expect(ids(nextOfferCandidates(list, "lead", "lead", 10))).toEqual(["lead2", "lead1"]);
    expect(nextOfferCandidates(list, "pre", "lead", 10)).toEqual([]);
  });

  it("customer_release: the customer queue only", () => {
    expect(ids(nextOfferCandidates(list, "customer_release", "general", 10))).toEqual(["cust1", "cust2"]);
  });

  it("public release: customer, then lead, then public", () => {
    expect(ids(nextOfferCandidates(list, "public", "general", 10))).toEqual(["cust1", "cust2", "lead2", "lead1", "pub1"]);
  });

  it("skips flagged entries, non-waiting entries and people at the offer maximum", () => {
    const got = ids(nextOfferCandidates(list, "none", "general", 10));
    expect(got).not.toContain("flagged");
    expect(got).not.toContain("offered");
    expect(got).not.toContain("maxed");
    expect(ids(nextOfferCandidates(list, "none", "general", 10, { maxOffersPerPerson: 3 }))).toContain("maxed");
    expect(ids(nextOfferCandidates(list, "none", "general", 10, { rules: { ...RULES, waitlist: { ...RULES.waitlist, max_offers_per_person_per_session: 1 } } }))).not.toContain("maxed");
  });

  it("returns nothing for a zero limit", () => {
    expect(nextOfferCandidates(list, "none", "general", 0)).toEqual([]);
  });
});

describe("offerExpiry (R42)", () => {
  const min = (m: number) => m * 60_000;
  it("uses the claim window when the session is far away", () => {
    const starts = new Date(T0.getTime() + min(24 * 60));
    expect(offerExpiry(T0, starts, 120, RULES)).toEqual(new Date(T0.getTime() + min(120)));
  });
  it("is cut off 60 minutes before start", () => {
    const starts = new Date(T0.getTime() + min(150));
    expect(offerExpiry(T0, starts, 120, RULES)).toEqual(new Date(T0.getTime() + min(90)));
  });
  it("makes no offer shorter than min_claim_minutes", () => {
    expect(offerExpiry(T0, new Date(T0.getTime() + min(75)), 120, RULES)).toEqual(new Date(T0.getTime() + min(15)));
    expect(offerExpiry(T0, new Date(T0.getTime() + min(74)), 120, RULES)).toBeNull();
  });
});

describe("queuePosition (R27)", () => {
  it("is 1-based within the entry's own queue", () => {
    const a = entry({ id: "a", queue: "customer", joinedAt: new Date(T0.getTime() + 1) });
    const b = entry({ id: "b", queue: "customer", joinedAt: new Date(T0.getTime() + 2) });
    const c = entry({ id: "c", queue: "lead", joinedAt: T0 });
    expect(queuePosition(b, [a, b, c])).toBe(2);
    expect(queuePosition(c, [a, b, c])).toBe(1);
    expect(queuePosition({ ...a, state: "offered" }, [a, b, c])).toBeNull();
  });
});
