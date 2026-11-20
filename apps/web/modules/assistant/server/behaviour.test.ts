import { describe, expect, it } from "vitest";
import { computeBehaviour, type BehaviourInput } from "./behaviour";

const now = new Date("2026-11-19T12:00:00Z");
const DAY = 86_400_000;
const visit = (daysAgo: number, kind: "day" | "night" = "day", status: BehaviourInput["bookings"][number]["status"] = "attended", hourUtc = 9) => {
  const startsAt = new Date(now.getTime() - daysAgo * DAY);
  startsAt.setUTCHours(hourUtc, 0, 0, 0);
  return { kind, startsAt, status, createdAt: new Date(startsAt.getTime() - 3 * DAY), isGuest: false };
};
const base: BehaviourInput = { now, status: "customer", bookings: [], credits: [], isMember: false, paidCents: 0, paidOrders: 0, newsletter: true, activeFlows: [] };

describe("computeBehaviour", () => {
  it("someone who never came is a lead without visits", () => {
    const f = computeBehaviour({ ...base, status: "lead", newsletter: false });
    expect(f).toMatchObject({ visits: 0, rhythmDays: null, lastVisitOn: null });
    expect(f.signals).toEqual(["never_visited", "no_newsletter"]);
  });

  it("a weekly visitor is loyal, with rhythm, favourite kind and booking lead time", () => {
    const f = computeBehaviour({ ...base, bookings: [70, 63, 56, 49, 42, 35, 28, 21, 14, 7].map((d) => visit(d)) });
    expect(f).toMatchObject({ visits: 10, visits90: 10, rhythmDays: 7, favouriteKind: "day", favouriteDaypart: "morning", leadTimeDays: 3, daysSinceLastVisit: 7 });
    expect(f.signals).toEqual(["loyal"]);
  });

  it("twice the usual gap without a new booking is lapsing; a booking ahead is not", () => {
    const lapsing = computeBehaviour({ ...base, bookings: [100, 86, 72, 58].map((d) => visit(d)) });
    expect(lapsing.signals).toContain("lapsing");
    const back = computeBehaviour({ ...base, bookings: [...[100, 86, 72, 58].map((d) => visit(d)), visit(-5, "day", "confirmed")] });
    expect(back.signals).not.toContain("lapsing");
    expect(back.signals).toContain("has_upcoming");
    expect(back.nextBookingOn).toBe("2026-11-24");
  });

  it("flags expiring and unused credits, night fans and unreliable bookers", () => {
    const f = computeBehaviour({
      ...base,
      bookings: [visit(200, "night"), visit(190, "night"), visit(120, "day"), visit(60, "day", "no_show"), visit(50, "day", "late_cancelled")],
      credits: [{ kind: "day", remainingUnits: 3, nextExpiresAt: new Date(now.getTime() + 20 * DAY) }],
    });
    expect(f.signals).toEqual(expect.arrayContaining(["night_fan", "no_show_risk", "credits_expiring", "credits_unused", "lapsing"]));
    expect(f.credits).toEqual([{ kind: "day", remaining: 3, expiresOn: "2026-12-09" }]);
  });

  it("guest seats and cancelled bookings never count as visits", () => {
    const f = computeBehaviour({ ...base, bookings: [{ ...visit(10), isGuest: true }, visit(5, "day", "cancelled")] });
    expect(f.visits).toBe(0);
  });
});
