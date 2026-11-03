import { describe, expect, it } from "vitest";
import { beamVitest, isModuleId, MODULE_IDS } from "./index";

describe("@beam/config", () => {
  it("keeps the ESLint module list equal to MODULE_IDS", async () => {
    const specifier = "../eslint.config.js";
    const eslint = (await import(specifier)) as { MODULE_IDS: string[] };
    expect(eslint.MODULE_IDS).toEqual([...MODULE_IDS]);
    expect(MODULE_IDS).toHaveLength(12);
    expect(isModuleId("crm")).toBe(true);
    expect(isModuleId("billing")).toBe(false);
  });

  it("gives every workspace the shared Vitest limits (DR-6)", () => {
    const { test } = beamVitest({ jsdom: true });
    expect(test).toMatchObject({ pool: "forks", maxWorkers: 2, passWithNoTests: true, environment: "jsdom" });
    expect(test?.exclude).toContain("**/__fixtures__/**");
  });
});
