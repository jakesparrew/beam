import { describe, expect, it } from "vitest";
import * as automation from "@beam/core/automation";
import * as builder from "./builder";
import * as frequency from "./frequency";

describe("@beam/core/automation index (fix-w22-automation-wiring)", () => {
  it("re-exports the frequency rules", () => {
    for (const name of Object.keys(frequency)) expect(automation).toHaveProperty(name, frequency[name as keyof typeof frequency]);
    expect(typeof automation.applyFrequencyRules).toBe("function");
  });

  it("re-exports the builder graph helpers", () => {
    for (const name of Object.keys(builder)) expect(automation).toHaveProperty(name, builder[name as keyof typeof builder]);
    expect(automation.BUILDER_BLOCKS).toContain("trigger");
  });
});
