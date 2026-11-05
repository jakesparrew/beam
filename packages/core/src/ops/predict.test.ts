/**
 * Rule 76 (ops-P9): churn, repurchase and predicted value for fixed inputs, the clamps, the
 * member halving and the 0.05 churn with a future booking.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIAN_INTERVAL_DAYS, meanVisitIntervalDays, median, predictIndicators, tenureYears, type PredictInput } from "./predict";

const day = (iso: string) => new Date(`${iso}T10:00:00.000Z`);

const base: PredictInput = {
  visits: 5,
  firstVisitAt: day("2026-01-01"),
  lastVisitAt: day("2026-03-02"), // 60 days: a mean interval of 15 days
  daysSinceActivity: 30,
  purchases: 3,
  avgOrderCents: 10_000,
  tenureYears: 1,
  isActiveMember: false,
  hasFutureBooking: false,
  hasLowActiveGrant: false,
};

describe("predictIndicators (rule 76)", () => {
  it("computes the three values for a fixed input", () => {
    // r = 30 / 15 = 2; churn = 1 - exp(-0.35) = 0.2953 -> 0.295
    expect(predictIndicators(base)).toEqual({ churn: 0.295, repurchase: 0.705, predictedValueCents: 21_150 });
  });

  it("floors the mean interval at 14 days", () => {
    // 11 visits over 50 days = 5-day interval, floored to 14; 28 days -> r = 2
    const r = predictIndicators({ ...base, visits: 11, lastVisitAt: day("2026-02-20"), daysSinceActivity: 28 });
    expect(r.churn).toBe(0.295);
  });

  it("uses the population median, else 30 days, with fewer than two visits", () => {
    expect(predictIndicators({ ...base, visits: 1, daysSinceActivity: 60 }).churn).toBe(0.295); // 60 / 30
    expect(predictIndicators({ ...base, visits: 0, firstVisitAt: null, lastVisitAt: null, daysSinceActivity: 120, medianIntervalDays: 60 }).churn).toBe(0.295);
    expect(predictIndicators({ ...base, visits: 1, daysSinceActivity: 15 }).churn).toBe(0); // r < 1
    expect(DEFAULT_MEDIAN_INTERVAL_DAYS).toBe(30);
  });

  it("clamps churn at 0.99 and repurchase between 0 and 0.99", () => {
    const old = predictIndicators({ ...base, daysSinceActivity: 10_000, purchases: 6, hasLowActiveGrant: true });
    expect(old.churn).toBe(0.99);
    expect(old.repurchase).toBe(0.11); // 0.01 * 1 + 0.1
    const fresh = predictIndicators({ ...base, daysSinceActivity: 0, hasLowActiveGrant: true });
    expect(fresh.churn).toBe(0);
    expect(fresh.repurchase).toBe(0.99); // 1 + 0.1 clamped
    const none = predictIndicators({ ...base, purchases: 0, daysSinceActivity: 0 });
    expect(none).toEqual({ churn: 0, repurchase: 0, predictedValueCents: 0 });
    expect(predictIndicators({ ...base, purchases: 0, daysSinceActivity: 0, hasLowActiveGrant: true }).repurchase).toBe(0.1);
  });

  it("halves churn for active members", () => {
    expect(predictIndicators({ ...base, daysSinceActivity: 10_000, isActiveMember: true }).churn).toBe(0.495);
    expect(predictIndicators({ ...base, isActiveMember: true }).churn).toBe(0.148); // 0.2953 / 2
  });

  it("sets churn to 0.05 with a future booking, member or not", () => {
    expect(predictIndicators({ ...base, daysSinceActivity: 10_000, hasFutureBooking: true }).churn).toBe(0.05);
    const both = predictIndicators({ ...base, daysSinceActivity: 10_000, hasFutureBooking: true, isActiveMember: true });
    expect(both.churn).toBe(0.05);
    expect(both.repurchase).toBe(0.95);
    expect(both.predictedValueCents).toBe(28_500); // 10 000 * 3 / 1 * 0.95
  });

  it("scales the predicted value by tenure, floored at a quarter year", () => {
    const one = { ...base, purchases: 1, avgOrderCents: 5_000, daysSinceActivity: 0 };
    expect(predictIndicators({ ...one, tenureYears: 0.1 }).predictedValueCents).toBe(20_000);
    expect(predictIndicators({ ...one, tenureYears: 2 }).predictedValueCents).toBe(2_500);
  });
});

describe("helpers", () => {
  it("meanVisitIntervalDays needs two visits", () => {
    expect(meanVisitIntervalDays(base)).toBe(15);
    expect(meanVisitIntervalDays({ ...base, visits: 1 })).toBeNull();
  });
  it("median of odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it("tenureYears", () => {
    expect(tenureYears(null, base.lastVisitAt!)).toBe(0);
    expect(tenureYears(day("2025-01-01"), day("2026-01-01"))).toBeCloseTo(0.999, 3);
  });
});
