import { describe, expect, it } from "vitest";
import { parseDefinition } from "@beam/core/automation";
import { ASSISTANT_AUTOMATIONS } from "./automations";

describe("assistant starter journeys", () => {
  it.each(ASSISTANT_AUTOMATIONS.map((a) => [a.slug, a] as const))("%s parses", (_slug, a) => {
    const parsed = parseDefinition(a.definition);
    expect(parsed.ok ? [] : parsed.issues).toEqual([]);
  });

  it("only the sales task starts active; marketing waits for BEAM to review the copy", () => {
    expect(ASSISTANT_AUTOMATIONS.map((a) => [a.slug, a.status, a.isMarketing])).toEqual([
      ["assistant-hot-lead-call", "active", false],
      ["assistant-lead-follow-up", "draft", true],
    ]);
  });
});
