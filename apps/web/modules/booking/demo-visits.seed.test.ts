/** booking's demo visit plan: past visits carry an outcome, upcoming ones none; nearly finished packages keep their balance. */
import { describe, expect, it, vi } from "vitest";

// commerce's api barrel reaches booking's book.ts through its actions; stubbing them keeps the cycle closed.
vi.mock("@/modules/commerce/actions", () => ({ redeemVoucher: vi.fn() }));

const { demoVisitPlan } = await import("./seed");

describe("demoVisitPlan", () => {
  const plan = demoVisitPlan();

  it("gives every past visit an outcome and leaves upcoming visits confirmed", () => {
    for (const v of plan) expect(v.outcome === null, `${v.person} ${v.day}`).toBe(v.day >= 0);
    expect(plan.filter((v) => v.day >= 0 && v.day <= 21).length).toBeGreaterThan(20);
  });

  it("never cancels a visit of the two nearly finished packages (4 of 5 used)", () => {
    for (const p of ["platform.person.customer3", "crm.customer.lies-vermeulen"]) {
      const visits = plan.filter((v) => v.person === p);
      expect(visits).toHaveLength(4);
      expect(visits.some((v) => v.outcome === "cancelled")).toBe(false);
    }
  });
});
