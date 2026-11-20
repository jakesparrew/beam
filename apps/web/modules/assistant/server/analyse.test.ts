import { describe, expect, it } from "vitest";
import { parseJsonObject, tagsFor, validateAnalysis, type AnalystOutput } from "./analyse";

const visitor = "Ik wil mijn vriendin verrassen met een nachtsessie, liefst volgend weekend. Kan ik een cadeaubon kopen? Ik vind 420 euro wel duur.";

const base: AnalystOutput = {
  summary: "Zoekt een cadeau.",
  intent: "gift",
  interests: ["night", "gift_card"],
  urgency: "high",
  sentiment: "neutral",
  objections: ["price"],
  quotes: { intent: "Kan ik een cadeaubon kopen?", interests: "verrassen met een nachtsessie", urgency: "liefst volgend weekend", objections: "420 euro wel duur" },
};

describe("validateAnalysis", () => {
  it("keeps every value whose quote is the visitor's own words", () => {
    const { analysis, dropped } = validateAnalysis(base, visitor);
    expect(dropped).toEqual([]);
    expect(analysis).toMatchObject({ intent: "gift", interests: ["night", "gift_card"], urgency: "high", objections: ["price"] });
  });

  it("drops a value the model cannot quote (no invented interest)", () => {
    const { analysis, dropped } = validateAnalysis({ ...base, interests: ["membership"], quotes: { ...base.quotes, interests: "ik wil lid worden" } }, visitor);
    expect(analysis.interests).toEqual([]);
    expect(dropped).toContain("interests");
  });

  it("ignores case and spacing in the quote", () => {
    const { analysis } = validateAnalysis({ ...base, quotes: { ...base.quotes, urgency: "LIEFST   volgend weekend" } }, visitor);
    expect(analysis.urgency).toBe("high");
  });

  it("never needs a quote for 'other'", () => {
    const { analysis, dropped } = validateAnalysis({ ...base, intent: "other", quotes: {} , interests: [], objections: [], urgency: null }, visitor);
    expect(analysis.intent).toBe("other");
    expect(dropped).toEqual([]);
  });
});

describe("parseJsonObject and tagsFor", () => {
  it("reads the object out of a fenced answer", () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject("no json")).toBeNull();
  });

  it("tags intents worth acting on, interests, objections and the temperature", () => {
    expect(tagsFor(base, "hot")).toEqual(["intent:gift", "interest:night", "interest:gift_card", "objection:price", "lead:hot"]);
    expect(tagsFor({ ...base, intent: "information", interests: [], objections: [] }, "cold")).toEqual([]);
  });
});
