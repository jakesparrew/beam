import { describe, expect, it } from "vitest";
import { RETENTION_BASE_SCORES, RETENTION_REASONS, retentionScore, retentionUrgency } from "./retention-score";

describe("retentionScore", () => {
  it("is the base score for a person without revenue and no urgency", () => {
    for (const reason of RETENTION_REASONS) {
      const input = { revenueCents: 0, daysUntil: 25, daysSinceActivity: 0 };
      expect(retentionScore(reason, input), reason).toBe(RETENTION_BASE_SCORES[reason]);
    }
  });

  it("adds revenue_cents / 20000 (integer division), capped at 30", () => {
    expect(retentionScore("package_nearly_finished", { revenueCents: 19_999 })).toBe(35);
    expect(retentionScore("package_nearly_finished", { revenueCents: 20_000 })).toBe(36);
    expect(retentionScore("package_nearly_finished", { revenueCents: 599_999 })).toBe(35 + 29);
    expect(retentionScore("package_nearly_finished", { revenueCents: 600_000 })).toBe(65);
    expect(retentionScore("package_nearly_finished", { revenueCents: 5_000_000 })).toBe(65);
  });

  it("urgency for package_expiring is 20 minus days until expiry, never negative", () => {
    expect(retentionUrgency("package_expiring", { revenueCents: 0, daysUntil: 0 })).toBe(20);
    expect(retentionUrgency("package_expiring", { revenueCents: 0, daysUntil: 5 })).toBe(15);
    expect(retentionUrgency("package_expiring", { revenueCents: 0, daysUntil: 30 })).toBe(0);
  });

  it("urgency for membership_renewal_due adds 10 when cancel_at is set", () => {
    expect(retentionUrgency("membership_renewal_due", { revenueCents: 0, daysUntil: 10 })).toBe(10);
    expect(retentionUrgency("membership_renewal_due", { revenueCents: 0, daysUntil: 10, cancelAtSet: true })).toBe(20);
    expect(retentionUrgency("membership_renewal_due", { revenueCents: 0, daysUntil: 40, cancelAtSet: true })).toBe(10);
  });

  it("urgency for activity reasons is days_since_activity / 10, capped at 20", () => {
    for (const reason of ["visiting_less", "high_value_inactive", "unused_sessions"] as const) {
      expect(retentionUrgency(reason, { revenueCents: 0, daysSinceActivity: 59 })).toBe(5);
      expect(retentionUrgency(reason, { revenueCents: 0, daysSinceActivity: 500 })).toBe(20);
    }
  });

  it("has no urgency for the other reasons", () => {
    for (const reason of ["package_nearly_finished", "package_finished_no_repurchase", "purchased_never_booked"] as const) {
      expect(retentionUrgency(reason, { revenueCents: 0, daysUntil: 0, daysSinceActivity: 300, cancelAtSet: true })).toBe(0);
    }
  });

  it("combines base, value and urgency", () => {
    // high_value_inactive: 50 + min(30, 150000/20000 = 7) + min(20, 75/10 = 7)
    expect(retentionScore("high_value_inactive", { revenueCents: 150_000, daysSinceActivity: 75 })).toBe(64);
    // package_expiring: 45 + 1 + (20 - 3)
    expect(retentionScore("package_expiring", { revenueCents: 25_000, daysUntil: 3 })).toBe(63);
  });
});
