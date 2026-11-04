import { describe, expect, it } from "vitest";
import { compareRank, compareTriggerOrder, exclusiveDomain, resolveExclusivity } from "./exclusivity";

describe("resolveExclusivity (A-15)", () => {
  const active = { groupPriority: 30, automationPriority: 100, enrolmentId: "e1" };

  it("empty domain: enrol", () => {
    expect(resolveExclusivity({ groupPriority: 30, automationPriority: 100 }, null)).toBe("enrol");
  });
  it("a lower group priority wins and supersedes", () => {
    expect(resolveExclusivity({ groupPriority: 10, automationPriority: 100 }, active)).toBe("supersede");
  });
  it("a lower automation priority in the same group wins (assessment-follow-up 50 over welcome-lead)", () => {
    expect(resolveExclusivity({ groupPriority: 30, automationPriority: 50 }, active)).toBe("supersede");
  });
  it("equal pairs keep the existing enrolment", () => {
    expect(resolveExclusivity({ groupPriority: 30, automationPriority: 100 }, active)).toBe("skip");
  });
  it("a higher pair is skipped, whatever the automation priority", () => {
    expect(resolveExclusivity({ groupPriority: 40, automationPriority: 1 }, active)).toBe("skip");
    expect(resolveExclusivity({ groupPriority: 30, automationPriority: 101 }, active)).toBe("skip");
  });
  it("webinar journeys: the deepest engagement wins", () => {
    const attended = { groupPriority: 20, automationPriority: 60, enrolmentId: "w" };
    expect(resolveExclusivity({ groupPriority: 20, automationPriority: 40 }, attended)).toBe("supersede");
    expect(resolveExclusivity({ groupPriority: 20, automationPriority: 70 }, attended)).toBe("skip");
  });
});

describe("domains and ordering", () => {
  it("the domain is coalesce(lane, key) for exclusive groups and null otherwise", () => {
    expect(exclusiveDomain({ key: "webinar", isExclusive: true, lane: "sales_journey" })).toBe("sales_journey");
    expect(exclusiveDomain({ key: "webinar", isExclusive: true, lane: null })).toBe("webinar");
    expect(exclusiveDomain({ key: "package", isExclusive: false, lane: null })).toBeNull();
    expect(exclusiveDomain({ key: "package", isExclusive: false, lane: "sales_journey" })).toBeNull();
  });
  it("A-9: trigger order by group priority, automation priority, then slug", () => {
    const list = [
      { slug: "welcome-lead", groupPriority: 30, automationPriority: 100 },
      { slug: "after-first-visit", groupPriority: 10, automationPriority: 100 },
      { slug: "assessment-follow-up", groupPriority: 30, automationPriority: 50 },
      { slug: "b-journey", groupPriority: 100, automationPriority: 100 },
      { slug: "a-journey", groupPriority: 100, automationPriority: 100 },
    ];
    expect([...list].sort(compareTriggerOrder).map((a) => a.slug)).toEqual([
      "after-first-visit",
      "assessment-follow-up",
      "welcome-lead",
      "a-journey",
      "b-journey",
    ]);
    expect(compareTriggerOrder(list[3]!, list[3]!)).toBe(0);
    expect(compareRank({ groupPriority: 1, automationPriority: 2 }, { groupPriority: 1, automationPriority: 2 })).toBe(0);
  });
});
