import { describe, expect, it } from "vitest";
import { onboardingProgress } from "./onboarding";

describe("onboardingProgress", () => {
  it("is unseen and open before the flow was shown", () => {
    expect(onboardingProgress(null)).toEqual({ unseen: true, answered: 0, total: 4, done: false, next: "emergency" });
  });

  it("counts only answered steps and resumes at the first step without an outcome", () => {
    const p = onboardingProgress({ seen_at: "2026-11-25T10:00:00Z", steps: { emergency: "answered", communication: "skipped" } });
    expect(p).toMatchObject({ unseen: false, answered: 1, done: false, next: "company" });
  });

  it("is done when every step has an outcome, or when dismissed", () => {
    const all = { emergency: "answered", communication: "answered", company: "skipped", about: "answered" } as const;
    expect(onboardingProgress({ seen_at: "x", steps: all })).toMatchObject({ answered: 3, done: true, next: null });
    expect(onboardingProgress({ seen_at: "x", dismissed_at: "y" })).toMatchObject({ done: true, next: "emergency" });
  });
});
