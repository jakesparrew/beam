import { describe, expect, it } from "vitest";
import { automationCategory } from "./category";
import { SEED_AUTOMATIONS } from "./seeds";

describe("automationCategory", () => {
  it("derives the category from the trigger", () => {
    expect(automationCategory({ event: "booking.confirmed" })).toBe("bookings");
    expect(automationCategory({ event: ["waitlist.offered", "x.y"] })).toBe("bookings");
    expect(automationCategory({ event: "credits.expiry_approaching" })).toBe("packages");
    expect(automationCategory({ event: "membership.renewal_due" })).toBe("memberships");
    expect(automationCategory({ event: "webinar.registered" })).toBe("leads");
    expect(automationCategory({ event: "person.inactive_days" })).toBe("reengagement");
    expect(automationCategory({ segment_enter: "seg" })).toBe("reengagement");
    expect(automationCategory({ event: "checkout.abandoned" })).toBe("transactional");
    expect(automationCategory({ manual: true })).toBe("other");
    expect(automationCategory(null)).toBe("other");
  });

  it("puts every seeded journey in a named category", () => {
    const other = SEED_AUTOMATIONS.filter((s) => automationCategory(s.definition.trigger) === "other").map((s) => s.slug);
    expect(other).toEqual([]);
  });
});
