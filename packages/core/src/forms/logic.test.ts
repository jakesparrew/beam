import { describe, expect, it } from "vitest";
import {
  checkValue,
  computePath,
  conditionRefs,
  deriveConsentPurposes,
  deriveSensitiveKeys,
  EMPTY_SCORES,
  evaluateCondition,
  isAnswered,
  isIsoDate,
  isVisible,
  nextStep,
  sectionOf,
  splitSensitive,
  validateAnswers,
  validateSection,
  visibleAnswers,
} from "./logic";
import type { Answers, Field, FormDefinition, FormScoring, ScoreState } from "./types";

const T = { "nl-BE": "x", "fr-BE": "x", en: "x" };
const B = { label: T, required: false, sensitive: false } as const;
const choice = (key: string, opts: string[], extra: Partial<Field> = {}): Field => ({ ...B, key, type: "single_choice", options: opts.map((k) => ({ key: k, label: T })), ...extra }) as Field;
const end = (key: string) => ({ key, kind: "thank_you" as const, title: T, body: T, showScore: false, showDimensions: [], ctas: [] });
const NO: FormScoring = { dimensions: [], outcomes: [] };

/** s1 (goal, age) -> s2 (sleep detail, shown for goal=sleep) -> s3 (stress) -> s4 (final). */
function def(over: Partial<FormDefinition> = {}): FormDefinition {
  const fields: Field[] = [
    choice("goal", ["sleep", "stress", "none"]),
    { ...B, key: "age", type: "number", min: 0, max: 120 },
    { ...B, key: "nap", type: "yes_no" },
    { ...B, key: "nap_minutes", type: "number", visibleIf: { field: "nap", op: "eq", value: true }, required: true },
    { ...B, key: "stress", type: "rating", scale: 10, required: true },
    { ...B, key: "note", type: "long_text" },
  ];
  return {
    title: T,
    settings: { resumeEnabled: false, resumeDays: 7, skipKnownFields: true, capturePartialLeads: false, showProgress: true, sendResultEmail: false, submitLabel: T, createInboxThread: false, staffEntryAllowed: false },
    sections: [
      { key: "s1", fieldKeys: ["goal", "age"] },
      { key: "s2", fieldKeys: ["nap", "nap_minutes"], visibleIf: { field: "goal", op: "eq", value: "sleep" } },
      { key: "s3", fieldKeys: ["stress"] },
      { key: "s4", fieldKeys: ["note"] },
    ],
    fields: Object.fromEntries(fields.map((f) => [f.key, f])),
    logic: [],
    endings: [end("thanks"), end("calm"), end("busy")],
    ...over,
  };
}

const S = (answers: Answers, scores: ScoreState = EMPTY_SCORES) => ({ answers, scores });

describe("conditions (F4)", () => {
  it("field operators", () => {
    const a: Answers = { c: "b", m: ["x", "y"], n: 5, y: false, d: "2026-03-01", t: "" };
    expect(evaluateCondition({ field: "c", op: "eq", value: "b" }, S(a))).toBe(true);
    expect(evaluateCondition({ field: "c", op: "neq", value: "b" }, S(a))).toBe(false);
    expect(evaluateCondition({ field: "c", op: "in", value: ["a", "b"] }, S(a))).toBe(true);
    expect(evaluateCondition({ field: "c", op: "not_in", value: ["a", "b"] }, S(a))).toBe(false);
    expect(evaluateCondition({ field: "m", op: "contains", value: "x" }, S(a))).toBe(true);
    expect(evaluateCondition({ field: "m", op: "contains", value: ["x", "z"] }, S(a))).toBe(false);
    expect(evaluateCondition({ field: "m", op: "in", value: ["z", "y"] }, S(a))).toBe(true);
    expect(evaluateCondition({ field: "m", op: "eq", value: ["y", "x"] }, S(a))).toBe(true);
    expect(evaluateCondition({ field: "m", op: "gte", value: 2 }, S(a))).toBe(true);
    expect(evaluateCondition({ field: "n", op: "gt", value: 4 }, S(a))).toBe(true);
    expect(evaluateCondition({ field: "n", op: "lte", value: 4 }, S(a))).toBe(false);
    expect(evaluateCondition({ field: "n", op: "eq", value: 5 }, S(a))).toBe(true);
    expect(evaluateCondition({ field: "n", op: "in", value: [4, 5] }, S(a))).toBe(true);
    expect(evaluateCondition({ field: "y", op: "eq", value: false }, S(a))).toBe(true);
    expect(evaluateCondition({ field: "y", op: "answered" }, S(a))).toBe(true);
    expect(evaluateCondition({ field: "d", op: "lt", value: "2026-04-01" }, S(a))).toBe(true);
    expect(evaluateCondition({ field: "t", op: "not_answered" }, S(a))).toBe(true);
    expect(evaluateCondition({ field: "missing", op: "neq", value: "b" }, S(a))).toBe(false);
    expect(evaluateCondition({ field: "missing", op: "not_answered" }, S(a))).toBe(true);
    expect(evaluateCondition({ field: "c", op: "gt", value: 1 }, S(a))).toBe(false);
  });

  it("multiple conditions: all, any, not", () => {
    const a: Answers = { c: "b", n: 5 };
    const yes = { field: "c", op: "eq", value: "b" } as const;
    const no = { field: "n", op: "lt", value: 1 } as const;
    expect(evaluateCondition({ all: [yes, { not: no }] }, S(a))).toBe(true);
    expect(evaluateCondition({ all: [yes, no] }, S(a))).toBe(false);
    expect(evaluateCondition({ any: [no, yes] }, S(a))).toBe(true);
    expect(evaluateCondition({ any: [no, { not: yes }] }, S(a))).toBe(false);
  });

  it("score and range leaves; null matches nothing", () => {
    const sc: ScoreState = { total: 12, totalRangeKey: "mid", dimensions: { sleep: { value: 3, rangeKey: "low" }, stress: { value: null, rangeKey: null } } };
    expect(evaluateCondition({ score: "total", op: "gte", value: 12 }, S({}, sc))).toBe(true);
    expect(evaluateCondition({ score: "sleep", op: "lt", value: 3 }, S({}, sc))).toBe(false);
    expect(evaluateCondition({ score: "sleep", op: "neq", value: 2 }, S({}, sc))).toBe(true);
    expect(evaluateCondition({ score: "stress", op: "lt", value: 100 }, S({}, sc))).toBe(false);
    expect(evaluateCondition({ score: "stress", op: "not_answered", value: 0 }, S({}, sc))).toBe(true);
    expect(evaluateCondition({ score: "sleep", op: "contains", value: 0 }, S({}, sc))).toBe(false);
    expect(evaluateCondition({ range: { dimension: "sleep", key: "low" } }, S({}, sc))).toBe(true);
    expect(evaluateCondition({ range: { dimension: "total", key: "mid" } }, S({}, sc))).toBe(true);
    expect(evaluateCondition({ range: { dimension: "stress", key: "low" } }, S({}, sc))).toBe(false);
  });

  it("conditionRefs", () => {
    expect(conditionRefs({ all: [{ field: "a", op: "answered" }, { not: { score: "d", op: "gt", value: 1 } }, { any: [{ range: { dimension: "e", key: "x" } }] }] })).toEqual({ fields: ["a"], dimensions: ["d", "e"] });
  });
});

describe("L1 to L7: visibility, path and endings", () => {
  it("L1: show/hide", () => {
    const d = def();
    expect(isVisible(d.fields.nap_minutes!, S({ nap: true }))).toBe(true);
    expect(isVisible(d.fields.nap_minutes!, S({ nap: false }))).toBe(false);
    expect(isVisible(d.fields.goal!, S({}))).toBe(true);
  });

  it("conditional section: s2 only for goal=sleep", () => {
    const d = def();
    expect(computePath(d, NO, { goal: "sleep", stress: 3 }).path).toEqual(["s1", "s2", "s3", "s4"]);
    expect(computePath(d, NO, { goal: "stress", stress: 3 }).path).toEqual(["s1", "s3", "s4"]);
    expect(nextStep(d, NO, { goal: "none" }, "s1")).toEqual({ section: "s3" });
    expect(nextStep(d, NO, {}, null)).toEqual({ section: "s1" });
  });

  it("skip: goto past sections", () => {
    const d = def({ logic: [{ key: "skip", afterSection: "s1", if: { field: "goal", op: "eq", value: "none" }, then: { goto: "s4" } }] });
    expect(computePath(d, NO, { goal: "none" }).path).toEqual(["s1", "s4"]);
    expect(computePath(d, NO, { goal: "stress" }).path).toEqual(["s1", "s3", "s4"]);
  });

  it("branch: several rules on one section, the first matching wins", () => {
    const d = def({
      logic: [
        { key: "a", afterSection: "s1", if: { field: "age", op: "gte", value: 65 }, then: { goto: "s4" } },
        { key: "b", afterSection: "s1", if: { field: "age", op: "gte", value: 18 }, then: { goto: "s3" } },
      ],
    });
    expect(nextStep(d, NO, { goal: "sleep", age: 70 }, "s1")).toEqual({ section: "s4" });
    expect(nextStep(d, NO, { goal: "sleep", age: 30 }, "s1")).toEqual({ section: "s3" });
    expect(nextStep(d, NO, { goal: "sleep", age: 10 }, "s1")).toEqual({ section: "s2" });
  });

  it("conditional ending: an end rule, else the first ending", () => {
    const d = def({
      logic: [
        { key: "calm", afterSection: "s3", if: { field: "stress", op: "lte", value: 3 }, then: { end: "calm" } },
        { key: "busy", afterSection: "s4", if: { field: "note", op: "answered" }, then: { end: "busy" } },
      ],
    });
    expect(computePath(d, NO, { goal: "none", stress: 2 })).toEqual({ path: ["s1", "s3"], endingKey: "calm" });
    expect(computePath(d, NO, { goal: "none", stress: 8, note: "hi" })).toEqual({ path: ["s1", "s3", "s4"], endingKey: "busy" });
    expect(computePath(d, NO, { goal: "none", stress: 8 })).toEqual({ path: ["s1", "s3", "s4"], endingKey: "thanks" });
    expect(nextStep(d, NO, { goal: "none", stress: 2 }, "s3")).toEqual({ end: "calm" });
  });

  it("L7: the selected outcome's ending when no end rule matched", () => {
    const d = def();
    const scoring: FormScoring = {
      dimensions: [],
      outcomes: [{ key: "hi", label: T, priority: 1, when: { field: "stress", op: "gte", value: 7 }, endingKey: "busy", tagKeys: [] }, { key: "lo", label: T, priority: 2, when: { field: "stress", op: "lt", value: 7 }, endingKey: "calm", tagKeys: [] }],
      defaultOutcomeKey: "lo",
    };
    expect(computePath(d, scoring, { goal: "none", stress: 9 }).endingKey).toBe("busy");
    expect(computePath(d, scoring, { goal: "none", stress: 1 }).endingKey).toBe("calm");
  });

  it("L3: forward only, a backward goto is ignored and every path terminates", () => {
    const d = def({ logic: [{ key: "back", afterSection: "s3", if: { field: "stress", op: "answered" }, then: { goto: "s1" } }] });
    expect(computePath(d, NO, { goal: "none", stress: 3 }).path).toEqual(["s1", "s3", "s4"]);
  });

  it("a goto onto a hidden section continues to the next visible one; no ending gives null", () => {
    const d = def({ logic: [{ key: "g", afterSection: "s1", if: { field: "goal", op: "answered" }, then: { goto: "s2" } }] });
    expect(nextStep(d, NO, { goal: "stress" }, "s1")).toEqual({ section: "s3" });
    const none = def({ endings: [] });
    expect(computePath(none, NO, { goal: "none" }).endingKey).toBeNull();
    const empty = def({ sections: [] });
    expect(computePath(empty, NO, {})).toEqual({ path: [], endingKey: "thanks" });
  });

  it("hidden answers dropped: an answer on a skipped section or a hidden field does not count", () => {
    const d = def();
    const answers: Answers = { goal: "stress", nap: true, nap_minutes: 20, stress: 4 };
    expect(visibleAnswers(d, NO, answers)).toEqual({ goal: "stress", stress: 4 });
    expect(visibleAnswers(d, NO, { goal: "sleep", nap: false, nap_minutes: 20, stress: 4 })).toEqual({ goal: "sleep", nap: false, stress: 4 });
  });

  it("nextStep with a current section off the computed path falls back to definition order", () => {
    const d = def({
      logic: [
        { key: "skip", afterSection: "s1", if: { field: "goal", op: "eq", value: "none" }, then: { goto: "s4" } },
        { key: "x", afterSection: "s3", if: { field: "stress", op: "gte", value: 5 }, then: { end: "busy" } },
      ],
    });
    expect(computePath(d, NO, { goal: "none", stress: 9 }).path).toEqual(["s1", "s4"]);
    expect(nextStep(d, NO, { goal: "none", stress: 9 }, "s3")).toEqual({ end: "busy" });
    expect(nextStep(d, NO, {}, "unknown")).toEqual({ section: "s1" });
  });
});

describe("U9: validateAnswers", () => {
  it("drops hidden answers and requires visible required fields only", () => {
    const d = def();
    const path = computePath(d, NO, { goal: "sleep", nap: false }).path;
    const r = validateAnswers(d, path, { goal: "sleep", nap: false, nap_minutes: 30, stress: 5, extra: "x" }, { final: true });
    expect(r).toEqual({ ok: true, clean: { goal: "sleep", nap: false, stress: 5 } });
    const missing = validateAnswers(d, path, { goal: "sleep", nap: true }, { final: true });
    expect(missing).toEqual({ ok: false, fields: { nap_minutes: "required", stress: "required" } });
    expect(validateAnswers(d, path, { goal: "sleep", nap: true }, { final: false })).toEqual({ ok: true, clean: { goal: "sleep", nap: true } });
  });

  it("a forged path fails: required fields of the real path are checked by the caller's computePath", () => {
    const d = def();
    const real = computePath(d, NO, { goal: "sleep" }).path;
    expect(validateAnswers(d, real, { goal: "sleep" }, { final: true }).ok).toBe(false);
  });

  it("per-type checks", () => {
    const f = (x: Partial<Field> & { type: Field["type"] }) => ({ ...B, key: "k", ...x }) as Field;
    expect(checkValue(f({ type: "short_text" }), "  hi  ")).toEqual({ value: "hi" });
    expect(checkValue(f({ type: "short_text" }), "x".repeat(256))).toEqual({ error: "too_long" });
    expect(checkValue(f({ type: "long_text", maxLength: 3 }), "abcd")).toEqual({ error: "too_long" });
    expect(checkValue(f({ type: "long_text" }), 3)).toEqual({ error: "invalid" });
    expect(checkValue(f({ type: "email" }), " Lotte@Example.COM ")).toEqual({ value: "lotte@example.com" });
    expect(checkValue(f({ type: "email" }), "nope")).toEqual({ error: "invalid_email" });
    expect(checkValue(f({ type: "email" }), 4)).toEqual({ error: "invalid_email" });
    expect(checkValue(f({ type: "phone" }), "0470 12 34 56")).toEqual({ value: "+32470123456" });
    expect(checkValue(f({ type: "phone" }), "abc")).toEqual({ error: "invalid_phone" });
    expect(checkValue(f({ type: "phone" }), 12)).toEqual({ error: "invalid_phone" });
    const num = f({ type: "number", min: 0, max: 10, step: 0.5 });
    expect(checkValue(num, 2.5)).toEqual({ value: 2.5 });
    expect(checkValue(num, 2.3)).toEqual({ error: "invalid_step" });
    expect(checkValue(num, 11)).toEqual({ error: "out_of_range" });
    expect(checkValue(num, "3")).toEqual({ error: "invalid_number" });
    const rating = f({ type: "rating", scale: 5 });
    expect(checkValue(rating, 5)).toEqual({ value: 5 });
    expect(checkValue(rating, 6)).toEqual({ error: "out_of_range" });
    expect(checkValue(rating, 2.5)).toEqual({ error: "invalid_number" });
    const sc = choice("k", ["a", "b"]);
    expect(checkValue(sc, "a")).toEqual({ value: "a" });
    expect(checkValue(sc, "z")).toEqual({ error: "invalid_option" });
    const mc = { ...B, key: "k", type: "multiple_choice", options: ["a", "b", "c"].map((k) => ({ key: k, label: T })), minSelected: 2, maxSelected: 2 } as Field;
    expect(checkValue(mc, ["a", "b", "a"])).toEqual({ value: ["a", "b"] });
    expect(checkValue(mc, ["a"])).toEqual({ error: "too_few" });
    expect(checkValue(mc, ["a", "b", "c"])).toEqual({ error: "too_many" });
    expect(checkValue(mc, ["z"])).toEqual({ error: "invalid_option" });
    expect(checkValue(mc, [])).toEqual({ value: undefined });
    expect(checkValue(f({ type: "yes_no" }), "yes")).toEqual({ error: "invalid" });
    const date = f({ type: "date", min: "2000-01-01", max: "2030-12-31" });
    expect(checkValue(date, "2026-02-29")).toEqual({ error: "invalid_date" });
    expect(checkValue(date, "2024-02-29")).toEqual({ value: "2024-02-29" });
    expect(checkValue(date, "1999-12-31")).toEqual({ error: "out_of_range" });
    expect(checkValue(f({ type: "hidden", from: "query", param: "ref" }), ` ${"x".repeat(120)}`)).toEqual({ value: "x".repeat(100) });
    expect(checkValue(f({ type: "utm", param: "utm_source" }), {})).toEqual({ error: "invalid" });
    expect(isIsoDate("2026-13-01")).toBe(false);
  });

  it("consent and acknowledgement boxes must be ticked when required", () => {
    const fields: Field[] = [
      { ...B, key: "ack", type: "acknowledgement", required: true, text: T },
      { ...B, key: "c", type: "consent", purpose: "sensitive_processing", wording: T, required: true },
      { ...B, key: "nl", type: "consent", purpose: "newsletter", wording: T },
    ];
    const d = def({ sections: [{ key: "s1", fieldKeys: ["ack", "c", "nl"] }], fields: Object.fromEntries(fields.map((f) => [f.key, f])) });
    expect(validateAnswers(d, ["s1"], { ack: false, c: false, nl: false }, { final: true })).toEqual({ ok: false, fields: { ack: "required", c: "required" } });
    expect(validateAnswers(d, ["s1"], { ack: true, c: true, nl: false }, { final: true })).toEqual({ ok: true, clean: { ack: true, c: true, nl: false } });
  });
});

describe("sensitivity (L6, SE1) and consent purposes", () => {
  const sens = (): FormDefinition => {
    const d = def();
    d.fields.stress = { ...d.fields.stress!, sensitive: true, sensitiveKind: "stress" };
    d.fields.note = { ...d.fields.note!, visibleIf: { field: "stress", op: "gte", value: 7 } };
    d.sections[3] = { ...d.sections[3]!, fieldKeys: ["note"] };
    return d;
  };

  it("a field shown by a sensitive condition is derived sensitive", () => {
    expect(deriveSensitiveKeys(sens())).toEqual(["stress", "note"]);
  });

  it("every field of a section shown by a sensitive condition is sensitive", () => {
    const d = sens();
    d.fields.note = { ...d.fields.note!, visibleIf: undefined };
    d.sections[3] = { ...d.sections[3]!, visibleIf: { field: "stress", op: "gt", value: 3 } };
    expect(deriveSensitiveKeys(d)).toEqual(["stress", "note"]);
  });

  it("score conditions count as sensitive without scoring, and follow S6 with it", () => {
    const d = def();
    d.fields.note = { ...d.fields.note!, visibleIf: { score: "calm", op: "gt", value: 1 } };
    expect(deriveSensitiveKeys(d)).toEqual(["note"]);
    const scoring: FormScoring = { dimensions: [{ key: "calm", label: T, kind: "formula", formula: "answer.age", ranges: [] }], outcomes: [] };
    expect(deriveSensitiveKeys(d, scoring)).toEqual([]);
    d.fields.age = { ...d.fields.age!, sensitive: true };
    expect(deriveSensitiveKeys(d, scoring)).toEqual(["age", "note"]);
  });

  it("splitSensitive keeps sensitive answers out of the plain set", () => {
    expect(splitSensitive(sens(), { goal: "sleep", stress: 8, note: "tired" })).toEqual({ plain: { goal: "sleep" }, sensitive: { stress: 8, note: "tired" } });
  });

  it("deriveConsentPurposes and helpers", () => {
    const d = def({
      fields: {
        a: { ...B, key: "a", type: "consent", purpose: "newsletter", wording: T },
        b: { ...B, key: "b", type: "consent", purpose: "sensitive_processing", wording: T },
        c: { ...B, key: "c", type: "consent", purpose: "newsletter", wording: T },
      },
    });
    expect(deriveConsentPurposes(d)).toEqual(["newsletter", "sensitive_processing"]);
    expect(sectionOf(def(), "stress")?.key).toBe("s3");
    expect(isAnswered(false)).toBe(true);
    expect(isAnswered(" ")).toBe(false);
    expect(isAnswered([])).toBe(false);
  });
});

describe("U2 with L4: validateSection (fix-w09-forms-review finding 3)", () => {
  /** s3 holds `detail` (shown when goal = stress, from s1) and `why` (required unless goal = stress). */
  const cross = (): FormDefinition => {
    const d = def();
    d.fields.detail = { ...B, key: "detail", type: "short_text", visibleIf: { field: "goal", op: "eq", value: "stress" } };
    d.fields.why = { ...B, key: "why", type: "short_text", required: true, visibleIf: { not: { field: "goal", op: "eq", value: "stress" } } };
    d.sections[2]!.fieldKeys = ["stress", "detail", "why"];
    return d;
  };

  it("a field shown by an earlier section's answer keeps its answer", () => {
    const r = validateSection(cross(), ["s1"], "s3", { goal: "stress", stress: 4, detail: "work" }, NO);
    expect(r).toEqual({ ok: true, clean: { goal: "stress", stress: 4, detail: "work" } });
    expect(validateAnswers(cross(), ["s3"], { goal: "stress", stress: 4, detail: "work" }, { final: true }, NO)).toMatchObject({ ok: false });
  });

  it("a required field hidden by an earlier section's answer does not block the save", () => {
    expect(validateSection(cross(), ["s1"], "s3", { goal: "stress", stress: 4 }, NO)).toMatchObject({ ok: true });
    expect(validateSection(cross(), ["s1"], "s3", { goal: "none", stress: 4 }, NO)).toEqual({ ok: false, fields: { why: "required" } });
  });

  it("reports errors of this section only; earlier invalid or missing answers are context, not errors", () => {
    const r = validateSection(cross(), ["s1", "s3"], "s3", { goal: "stress", age: 999 }, NO);
    expect(r).toEqual({ ok: false, fields: { stress: "required" } });
    expect(validateSection(cross(), ["s1", "s2", "s3"], "s3", { goal: "stress", age: 999, nap: true, stress: 2 }, NO)).toMatchObject({ ok: true });
  });
});
