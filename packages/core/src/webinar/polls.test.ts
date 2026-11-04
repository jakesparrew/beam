import { describe, expect, it } from "vitest";
import { answerOptionKey, tagsForAnswer, validatePollAnswer, visibleAt } from "./polls";
import { PollOptions, TagRules, UpsertPollInput } from "./schemas";
import type { PollDefinition } from "./types";

const poll: PollDefinition = {
  key: "interest",
  options: [{ key: "sleep" }, { key: "stress" }, { key: "energy" }],
  allowMultiple: false,
  tagRules: [
    { option_keys: ["sleep"], tag_key: "interest_sleep", modes: ["live", "replay"] },
    { option_keys: ["stress", "energy"], tag_key: "interest_vitality", modes: ["live"] },
    { option_keys: ["sleep", "energy"], tag_key: "engaged", modes: ["live", "replay", "on_demand"] },
  ],
};

describe("validatePollAnswer (rule 33)", () => {
  it("single choice accepts exactly one known key", () => {
    expect(validatePollAnswer(poll, ["sleep"])).toEqual({ ok: true, optionKeys: ["sleep"] });
    expect(validatePollAnswer(poll, ["sleep", "stress"])).toEqual({ ok: false, code: "multiple_not_allowed" });
    expect(validatePollAnswer(poll, [])).toEqual({ ok: false, code: "empty" });
  });

  it("multiple choice accepts several keys in the poll's order", () => {
    const multi = { ...poll, allowMultiple: true };
    expect(validatePollAnswer(multi, ["energy", "sleep"])).toEqual({ ok: true, optionKeys: ["sleep", "energy"] });
    expect(validatePollAnswer(multi, ["sleep", "sleep"])).toEqual({ ok: false, code: "duplicate_option" });
  });

  it("rejects an unknown key and names it", () => {
    expect(validatePollAnswer(poll, ["coffee"])).toEqual({ ok: false, code: "unknown_option", unknown: ["coffee"] });
  });
});

describe("tagsForAnswer (rule 35)", () => {
  it("applies the rules whose option keys intersect and whose modes include the mode", () => {
    expect(tagsForAnswer(poll, ["sleep"], "live")).toEqual(["interest_sleep", "engaged"]);
    expect(tagsForAnswer(poll, ["sleep"], "on_demand")).toEqual(["engaged"]);
    expect(tagsForAnswer(poll, ["stress"], "live")).toEqual(["interest_vitality"]);
    expect(tagsForAnswer(poll, ["stress"], "replay")).toEqual([]);
  });

  it("returns each tag once", () => {
    const dup = { ...poll, tagRules: [...poll.tagRules, { option_keys: ["energy"], tag_key: "engaged", modes: ["live" as const] }] };
    expect(tagsForAnswer(dup, ["sleep", "energy"], "live")).toEqual(["interest_sleep", "interest_vitality", "engaged"]);
  });
});

describe("answerOptionKey", () => {
  it("is the single key, or null for several", () => {
    expect(answerOptionKey(["sleep"])).toBe("sleep");
    expect(answerOptionKey(["sleep", "energy"])).toBeNull();
  });
});

describe("visibleAt (rule 34)", () => {
  const items = [
    { id: "a", showAtSec: 60, showForSec: 120 },
    { id: "b", showAtSec: null, showForSec: 120 },
    { id: "c", showAtSec: 100, showForSec: 30, isActive: false },
    { id: "d", showAtSec: 150, showForSec: 15 },
  ];

  it("shows active items inside [show_at, show_at + show_for)", () => {
    expect(visibleAt(items, 59).map((i) => i.id)).toEqual([]);
    expect(visibleAt(items, 60).map((i) => i.id)).toEqual(["a"]);
    expect(visibleAt(items, 155).map((i) => i.id)).toEqual(["a", "d"]);
    expect(visibleAt(items, 180).map((i) => i.id)).toEqual([]);
  });

  it("never shows an item without show_at_sec outside live", () => {
    expect(visibleAt(items, 0).some((i) => i.id === "b")).toBe(false);
  });
});

describe("poll schemas", () => {
  const label = { "nl-BE": "Slaap", "fr-BE": "Sommeil", en: "Sleep" };

  it("PollOptions needs 2 to 8 options with unique keys", () => {
    expect(PollOptions.safeParse([{ key: "a", label }]).success).toBe(false);
    expect(PollOptions.safeParse([{ key: "a", label }, { key: "a", label }]).success).toBe(false);
    expect(PollOptions.safeParse([{ key: "a", label }, { key: "b", label }]).success).toBe(true);
    expect(PollOptions.safeParse(Array.from({ length: 9 }, (_, i) => ({ key: `o${i}`, label }))).success).toBe(false);
    expect(PollOptions.safeParse([{ key: "A", label }, { key: "b", label }]).success).toBe(false);
  });

  it("TagRules need modes and option keys", () => {
    expect(TagRules.safeParse([{ option_keys: ["a"], tag_key: "t", modes: ["live"] }]).success).toBe(true);
    expect(TagRules.safeParse([{ option_keys: ["a"], tag_key: "t", modes: [] }]).success).toBe(false);
    expect(TagRules.safeParse([{ option_keys: ["a"], tag_key: "t", modes: ["simulive"] }]).success).toBe(false);
  });

  it("UpsertPollInput applies the defaults", () => {
    const parsed = UpsertPollInput.parse({
      webinarId: "3f2b8c1e-7a4d-4e9b-9c2a-5d6e7f8a9b0c",
      key: "interest",
      question: label,
      options: [{ key: "a", label }, { key: "b", label }],
    });
    expect(parsed).toMatchObject({ allowMultiple: false, showForSec: 120, tagRules: [], sortOrder: 0 });
  });
});
