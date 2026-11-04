import { describe, expect, it } from "vitest";
import { ERASE_EXTERNAL_PROVIDERS, ERASE_ORDER, FIRST_ERASE_MODULE, nextEraseModule } from "./privacy-order";
import type { ModuleId } from "./types";

const ALL_MODULES: ModuleId[] = ["platform", "crm", "booking", "commerce", "credits", "finance", "forms", "email", "automation", "ops", "site", "webinar"];

describe("ERASE_ORDER (rule 62)", () => {
  it("holds all twelve module ids exactly once", () => {
    expect(ERASE_ORDER).toHaveLength(12);
    expect(new Set(ERASE_ORDER).size).toBe(12);
    expect([...ERASE_ORDER].sort()).toEqual([...ALL_MODULES].sort());
  });

  it("runs crm second to last and platform last", () => {
    expect(ERASE_ORDER[ERASE_ORDER.length - 2]).toBe("crm");
    expect(ERASE_ORDER[ERASE_ORDER.length - 1]).toBe("platform");
  });

  it("matches the spec order", () => {
    expect([...ERASE_ORDER]).toEqual(["webinar", "automation", "email", "forms", "booking", "credits", "commerce", "finance", "site", "ops", "crm", "platform"]);
  });

  it("chains every step to the next and ends after platform", () => {
    expect(FIRST_ERASE_MODULE).toBe("webinar");
    const visited: ModuleId[] = [];
    let m: ModuleId | null = FIRST_ERASE_MODULE;
    while (m) {
      visited.push(m);
      m = nextEraseModule(m);
    }
    expect(visited).toEqual([...ERASE_ORDER]);
    expect(() => nextEraseModule("nope" as ModuleId)).toThrow(RangeError);
  });

  it("propagates to three external providers first", () => {
    expect([...ERASE_EXTERNAL_PROVIDERS]).toEqual(["billit", "mandates", "resend"]);
  });
});
