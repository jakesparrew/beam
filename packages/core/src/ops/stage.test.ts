import { describe, expect, it } from "vitest";
import { B2C_STAGES, computeB2cStage, stageAnchor, stageChangedDedupeKey, type StageInput } from "./stage";

const now = new Date("2026-11-04T10:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const daysAhead = (n: number) => new Date(now.getTime() + n * 86_400_000);

const base: StageInput = {
  status: "lead",
  purchases: 0,
  visits: 0,
  lastVisitAt: null,
  lastPurchaseAt: null,
  hasFutureBooking: false,
  attendedEventOrWebinar: false,
  lastEngagementAt: null,
  now,
};
const stage = (over: Partial<StageInput>) => computeB2cStage({ ...base, ...over });

describe("computeB2cStage (rules 8-13)", () => {
  it("R8 member when v_person_status is member, whatever the history", () => {
    expect(stage({ status: "member", purchases: 5, visits: 20, lastVisitAt: daysAgo(500), lastPurchaseAt: daysAgo(500) })).toBe("member");
  });

  it("R8-R9 precedence: member over lost", () => {
    const lostInput = { purchases: 3, lastVisitAt: daysAgo(400), lastPurchaseAt: daysAgo(400) };
    expect(stage({ ...lostInput, status: "customer" })).toBe("lost");
    expect(stage({ ...lostInput, status: "member" })).toBe("member");
  });

  it("R9 lost after more than stage_lost_days without visit or purchase and no future booking", () => {
    expect(stage({ status: "customer", purchases: 1, lastPurchaseAt: daysAgo(366) })).toBe("lost");
    expect(stage({ status: "customer", purchases: 1, lastPurchaseAt: daysAgo(366), hasFutureBooking: true })).toBe("first_purchase");
  });

  it("R10 retention after more than stage_retention_days", () => {
    expect(stage({ status: "customer", purchases: 2, lastVisitAt: daysAgo(91), lastPurchaseAt: daysAgo(200) })).toBe("retention");
    expect(stage({ status: "customer", purchases: 2, lastVisitAt: daysAgo(90), lastPurchaseAt: daysAgo(200) })).toBe("repeat");
  });

  it("R10 a changed stage_retention_days moves the boundary", () => {
    const input = { status: "customer" as const, purchases: 2, lastVisitAt: daysAgo(61) };
    expect(stage(input)).toBe("repeat");
    expect(stage({ ...input, thresholds: { stage_retention_days: 60 } })).toBe("retention");
  });

  it("R11 repeat, active and first_purchase", () => {
    expect(stage({ status: "customer", purchases: 2, lastPurchaseAt: daysAgo(5) })).toBe("repeat");
    expect(stage({ status: "customer", purchases: 1, visits: 2, lastVisitAt: daysAgo(3), lastPurchaseAt: daysAgo(10) })).toBe("active");
    expect(stage({ status: "customer", purchases: 1, visits: 1, lastVisitAt: daysAgo(3), lastPurchaseAt: daysAgo(10) })).toBe("first_purchase");
  });

  it("R12 first_visit for a guest or free visit, experienced after an event or a webinar", () => {
    expect(stage({ visits: 1, lastVisitAt: daysAgo(3) })).toBe("first_visit");
    expect(stage({ attendedEventOrWebinar: true })).toBe("experienced");
  });

  it("R13 engaged_lead inside the engagement window, else lead", () => {
    expect(stage({ lastEngagementAt: daysAgo(90) })).toBe("engaged_lead");
    expect(stage({ lastEngagementAt: daysAgo(91) })).toBe("lead");
    expect(stage({})).toBe("lead");
  });

  it("R3 a no-show is never a visit and never moves the stage forward", () => {
    expect(stage({ noShows: 4, visits: 0 })).toBe("lead");
    expect(stage({ noShows: 4, visits: 0, lastEngagementAt: daysAgo(2) })).toBe("engaged_lead");
  });

  it("has one case per stage", () => {
    const seen = new Set([
      stage({}),
      stage({ lastEngagementAt: daysAgo(1) }),
      stage({ attendedEventOrWebinar: true }),
      stage({ visits: 1 }),
      stage({ purchases: 1, lastPurchaseAt: daysAgo(1) }),
      stage({ purchases: 1, visits: 2, lastVisitAt: daysAgo(1) }),
      stage({ purchases: 2, lastPurchaseAt: daysAgo(1) }),
      stage({ status: "member" }),
      stage({ purchases: 1, lastPurchaseAt: daysAgo(100) }),
      stage({ purchases: 1, lastPurchaseAt: daysAgo(400) }),
    ]);
    expect([...seen].sort()).toEqual([...B2C_STAGES].sort());
  });

  it("R10 a future booking keeps a lapsed customer out of retention", () => {
    expect(stage({ purchases: 2, lastVisitAt: daysAgo(120), hasFutureBooking: true, lastPurchaseAt: daysAhead(-130) })).toBe("repeat");
  });
});

describe("stage helpers", () => {
  it("anchors on the later of last visit and last purchase", () => {
    expect(stageAnchor({ lastVisitAt: daysAgo(3), lastPurchaseAt: daysAgo(10) })).toEqual(daysAgo(3));
    expect(stageAnchor({ lastVisitAt: null, lastPurchaseAt: daysAgo(10) })).toEqual(daysAgo(10));
    expect(stageAnchor({ lastVisitAt: null, lastPurchaseAt: null })).toBeNull();
  });

  it("R14 dedupe key", () => {
    expect(stageChangedDedupeKey("p1", "repeat", "2026-11-04")).toBe("stage:p1:repeat:2026-11-04");
  });
});
