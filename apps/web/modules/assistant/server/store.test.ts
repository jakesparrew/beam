import { describe, expect, it } from "vitest";
import { toolFact } from "./store";

describe("toolFact", () => {
  it("keeps every session of an availability result, compactly", () => {
    const sessions = Array.from({ length: 6 }, (_, i) => ({ when: `za 21 nov, ${10 + i}:00`, kind: i === 5 ? "night" : "day", free_places: i + 1, price_eur: i === 5 ? 420 : 120, session_id: "x".repeat(36), title: "Dagsessie" }));
    const line = toolFact({ name: "get_availability", output: { sessions } });
    expect(line).toContain("za 21 nov, 15:00 night 6 free €420");
    expect(line.split(";")).toHaveLength(6);
    expect(line).not.toContain("session_id");
  });

  it("says so when nothing is free, and shortens other tools", () => {
    expect(toolFact({ name: "get_availability", output: { sessions: [] } })).toBe("get_availability: no free places");
    expect(toolFact({ name: "get_offer", output: [{ name: "x".repeat(900) }] }).length).toBeLessThan(420);
  });
});
