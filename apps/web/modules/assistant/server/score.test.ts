import { describe, expect, it } from "vitest";
import { scoreLead, scoreReason } from "./score";

const base = { hasEmail: false, hasPhone: false, intent: "information" as const, urgency: null, sentiment: null, interests: [], bookingLinkClicked: false };

describe("scoreLead", () => {
  it("an anonymous question is cold", () => {
    expect(scoreLead(base)).toMatchObject({ score: 10, qualified: false, temperature: "cold" });
  });

  it("someone who wants to book soon and left an email is qualified", () => {
    const r = scoreLead({ ...base, hasEmail: true, intent: "booking", urgency: "high", interests: ["night"] });
    expect(r).toMatchObject({ score: 75, qualified: true, temperature: "hot" });
    expect(scoreReason(r.parts)).toBe("email +25 · intent:booking +30 · urgency:high +15 · interests +5");
  });

  it("a hot score without an email is not qualified", () => {
    const r = scoreLead({ ...base, intent: "booking", urgency: "high", bookingLinkClicked: true, interests: ["day"] });
    expect(r.score).toBe(60);
    expect(r.qualified).toBe(false);
  });

  it("stays between 0 and 100", () => {
    expect(scoreLead({ ...base, intent: "complaint", sentiment: "negative" }).score).toBe(0);
    expect(scoreLead({ ...base, hasEmail: true, hasPhone: true, intent: "booking", urgency: "high", bookingLinkClicked: true, interests: ["x"] }).score).toBe(95);
  });
});
