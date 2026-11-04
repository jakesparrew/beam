import { describe, expect, it } from "vitest";
import { computeScore, contribution, dimensionOrder, findRange, selectOutcome, sensitiveDimensions, splitScore } from "./scoring";
import { recoveryCheckSeed } from "./seed-definitions";
import type { Answers, Field, FormDefinition, FormScoring, Range } from "./types";

const T = { "nl-BE": "x", "fr-BE": "x", en: "x" };
const B = { label: T, required: false, sensitive: false } as const;
const r = (key: string, from: number, to: number): Range => ({ key, from, to, label: T });

function def(fields: Field[]): FormDefinition {
  return {
    title: T,
    settings: { resumeEnabled: false, resumeDays: 7, skipKnownFields: true, capturePartialLeads: false, showProgress: true, sendResultEmail: false, submitLabel: T, createInboxThread: false, staffEntryAllowed: false },
    sections: [{ key: "s", fieldKeys: fields.map((f) => f.key) }],
    fields: Object.fromEntries(fields.map((f) => [f.key, f])),
    logic: [],
    endings: [{ key: "e", kind: "result", title: T, body: T, showScore: true, showDimensions: [], ctas: [] }],
  };
}

const FIELDS: Field[] = [
  { ...B, key: "c", type: "single_choice", options: [{ key: "a", label: T, scores: { body: 1 } }, { key: "b", label: T, scores: { body: 5, mind: 2 } }] },
  { ...B, key: "m", type: "multiple_choice", options: [{ key: "x", label: T, scores: { body: 2 } }, { key: "y", label: T, scores: { body: 3 } }, { key: "z", label: T }] },
  { ...B, key: "yn", type: "yes_no", scores: { yes: { mind: 4 }, no: { mind: 0 } } },
  { ...B, key: "rt", type: "rating", scale: 10, weights: { mind: 0.5 } },
  { ...B, key: "nb", type: "number", weights: { body: 2 } },
  { ...B, key: "txt", type: "short_text" },
];
const D = def(FIELDS);

describe("S1: ranges", () => {
  const ranges = [r("low", 0, 10), r("mid", 10, 20), r("high", 20, 30)];
  it("from inclusive, to exclusive, except the last range whose to is inclusive", () => {
    expect(findRange(ranges, 0)?.key).toBe("low");
    expect(findRange(ranges, 9.99)?.key).toBe("low");
    expect(findRange(ranges, 10)?.key).toBe("mid");
    expect(findRange(ranges, 20)?.key).toBe("high");
    expect(findRange(ranges, 30)?.key).toBe("high");
    expect(findRange(ranges, 30.01)).toBeNull();
    expect(findRange(ranges, -1)).toBeNull();
    expect(findRange(ranges, null)).toBeNull();
    expect(findRange([], 5)).toBeNull();
    expect(findRange([r("hi", 20, 30), r("lo", 0, 20)], 30)?.key).toBe("hi");
  });
});

describe("S2: weighted answers", () => {
  it("weighted options, multiple choice sums, yes/no and rating weights", () => {
    expect(contribution(FIELDS[0]!, "body", "b")).toBe(5);
    expect(contribution(FIELDS[0]!, "mind", "a")).toBeNull();
    expect(contribution(FIELDS[1]!, "body", ["x", "y", "z"])).toBe(5);
    expect(contribution(FIELDS[1]!, "body", ["z"])).toBeNull();
    expect(contribution(FIELDS[2]!, "mind", true)).toBe(4);
    expect(contribution(FIELDS[2]!, "mind", false)).toBe(0);
    expect(contribution(FIELDS[3]!, "mind", 8)).toBe(4);
    expect(contribution(FIELDS[4]!, "body", 3)).toBe(6);
    expect(contribution(FIELDS[5]!, "body", "x")).toBeNull();
  });

  it("sum and avg; avg ignores unanswered fields", () => {
    const scoring: FormScoring = {
      dimensions: [
        { key: "body", label: T, kind: "sum", ranges: [r("low", 0, 10), r("high", 10, 40)] },
        { key: "mind", label: T, kind: "avg", ranges: [] },
      ],
      outcomes: [],
    };
    const s = computeScore(D, scoring, { c: "b", m: ["x"], nb: 2, yn: true, rt: 8 });
    expect(s.dimensions.body).toEqual({ value: 11, rangeKey: "high" });
    // mind: c=b adds 2, yn adds 4, rt adds 4 -> avg over 3 answered contributing fields
    expect(s.dimensions.mind!.value).toBeCloseTo(10 / 3);
    const partial = computeScore(D, scoring, { yn: true });
    expect(partial.dimensions.mind!.value).toBe(4);
    expect(partial.dimensions.body).toEqual({ value: 0, rangeKey: "low" });
    expect(computeScore(D, scoring, {}).dimensions.mind!.value).toBeNull();
    expect(s.total).toBeNull();
    expect(s.totalRangeKey).toBeNull();
  });

  it("min and max clamp a dimension", () => {
    const scoring: FormScoring = { dimensions: [{ key: "body", label: T, kind: "sum", min: 0, max: 6, ranges: [] }], outcomes: [] };
    expect(computeScore(D, scoring, { c: "b", nb: 10 }).dimensions.body!.value).toBe(6);
  });
});

describe("S3 and S5: formula dimensions and the total", () => {
  const scoring: FormScoring = {
    dimensions: [
      { key: "ratio", label: T, kind: "formula", formula: "dim.body / dim.mind", ranges: [r("lo", 0, 1), r("hi", 1, 100)] },
      { key: "body", label: T, kind: "sum", ranges: [] },
      { key: "mind", label: T, kind: "sum", ranges: [] },
    ],
    total: { kind: "sum_dimensions", ranges: [r("small", 0, 10), r("big", 10, 1000)] },
    outcomes: [],
  };

  it("formula dimension computed after its dependencies", () => {
    expect(dimensionOrder(scoring).order).toEqual(["body", "mind", "ratio"]);
    const s = computeScore(D, scoring, { c: "b", yn: true });
    expect(s.dimensions.ratio).toEqual({ value: 5 / 6, rangeKey: "lo" });
  });

  it("total by sum of dimensions", () => {
    const s = computeScore(D, scoring, { c: "b", yn: true });
    expect(s.total).toBeCloseTo(5 + 6 + 5 / 6);
    expect(s.totalRangeKey).toBe("big");
  });

  it("division by zero makes a dimension null; null matches no range and the sum skips it", () => {
    const s = computeScore(D, scoring, { c: "a" });
    expect(s.dimensions.ratio).toEqual({ value: null, rangeKey: null });
    expect(s.total).toBe(1);
    expect(computeScore(D, { ...scoring, dimensions: [scoring.dimensions[0]!] }, {}).total).toBeNull();
  });

  it("total by formula", () => {
    const f: FormScoring = { ...scoring, total: { kind: "formula", formula: "round(dim.body * 10 + answer.rt, 0)", ranges: [r("any", 0, 1000)] } };
    expect(computeScore(D, f, { c: "b", rt: 3 }).total).toBe(53);
  });

  it("a formula cycle is listed and computes to null", () => {
    const cyc: FormScoring = {
      dimensions: [
        { key: "a", label: T, kind: "formula", formula: "dim.b + 1", ranges: [] },
        { key: "b", label: T, kind: "formula", formula: "dim.a + 1", ranges: [] },
        { key: "c", label: T, kind: "formula", formula: "dim.a", ranges: [] },
        { key: "d", label: T, kind: "formula", formula: "2", ranges: [] },
      ],
      outcomes: [],
    };
    expect(dimensionOrder(cyc)).toEqual({ order: ["d"], cyclic: ["a", "b", "c"] });
    const s = computeScore(D, cyc, {});
    expect(s.dimensions.a!.value).toBeNull();
    expect(s.dimensions.d!.value).toBe(2);
    expect(computeScore(D, { dimensions: [{ key: "x", label: T, kind: "formula", ranges: [] }], outcomes: [] }, {}).dimensions.x!.value).toBeNull();
  });
});

describe("S4: outcomes", () => {
  const scoring: FormScoring = {
    dimensions: [{ key: "body", label: T, kind: "sum", ranges: [r("low", 0, 5), r("high", 5, 40)] }],
    total: { kind: "sum_dimensions", ranges: [] },
    outcomes: [
      { key: "combo", label: T, priority: 1, when: { all: [{ field: "c", op: "eq", value: "a" }, { field: "yn", op: "eq", value: true }] }, endingKey: "e", tagKeys: [] },
      { key: "by_total", label: T, priority: 3, when: { score: "total", op: "gte", value: 8 }, endingKey: "e", tagKeys: [] },
      { key: "by_range", label: T, priority: 2, when: { range: { dimension: "body", key: "high" } }, endingKey: "e", tagKeys: [] },
      { key: "fallback", label: T, priority: 9, when: { field: "txt", op: "eq", value: "never" }, endingKey: "e", tagKeys: [] },
    ],
    defaultOutcomeKey: "fallback",
  };
  const pick = (a: Answers) => selectOutcome(scoring, a, computeScore(D, scoring, a))?.key ?? null;

  it("S4: outcome by answer combination", () => {
    expect(pick({ c: "a", yn: true, nb: 10 })).toBe("combo");
  });
  it("S4: outcome by category range (ascending priority wins over the total)", () => {
    expect(pick({ c: "b", nb: 2 })).toBe("by_range");
  });
  it("S4: outcome by total", () => {
    const totalOnly: FormScoring = { ...scoring, outcomes: scoring.outcomes.filter((o) => o.key !== "by_range") };
    expect(selectOutcome(totalOnly, { nb: 4 }, computeScore(D, totalOnly, { nb: 4 }))?.key).toBe("by_total");
  });
  it("S4: default outcome when nothing matches", () => {
    expect(pick({ c: "a" })).toBe("fallback");
  });
  it("no outcomes gives no outcome; an unknown default gives none", () => {
    expect(selectOutcome({ dimensions: [], outcomes: [] }, {}, computeScore(D, { dimensions: [], outcomes: [] }, {}))).toBeNull();
    const noDefault: FormScoring = { ...scoring, defaultOutcomeKey: "missing" };
    expect(selectOutcome(noDefault, { c: "a" }, computeScore(D, noDefault, { c: "a" }))).toBeNull();
  });
  it("equal priorities keep array order", () => {
    const same: FormScoring = { ...scoring, outcomes: scoring.outcomes.map((o) => ({ ...o, priority: 1 })) };
    expect(selectOutcome(same, { c: "b", nb: 2 }, computeScore(D, same, { c: "b", nb: 2 }))?.key).toBe("by_total");
  });
});

describe("S6: sensitive dimensions", () => {
  it("a dimension is sensitive when a contributing field is, or its formula reads a sensitive dimension or field", () => {
    const fields = FIELDS.map((f): Field => (f.key === "yn" ? { ...f, sensitive: true, sensitiveKind: "health" } : f));
    const d = def(fields);
    const scoring: FormScoring = {
      dimensions: [
        { key: "body", label: T, kind: "sum", ranges: [] },
        { key: "mind", label: T, kind: "sum", ranges: [] },
        { key: "mix", label: T, kind: "formula", formula: "dim.mind + 1", ranges: [] },
        { key: "raw", label: T, kind: "formula", formula: "answer.yn * 2", ranges: [] },
        { key: "plain", label: T, kind: "formula", formula: "dim.body * 2", ranges: [] },
      ],
      total: { kind: "sum_dimensions", ranges: [] },
      outcomes: [],
    };
    const s = computeScore(d, scoring, { c: "b", yn: true });
    expect(s.sensitiveDimensionKeys).toEqual(["mind", "mix", "raw"]);
    expect(s.totalSensitive).toBe(true);
    const plainTotal: FormScoring = { ...scoring, total: { kind: "formula", formula: "dim.plain", ranges: [] } };
    expect(computeScore(d, plainTotal, { c: "b" }).totalSensitive).toBe(false);
    const sensTotal: FormScoring = { ...scoring, total: { kind: "formula", formula: "answer.yn", ranges: [] } };
    expect(sensitiveDimensions(d, sensTotal, new Set(["yn"])).total).toBe(true);
    expect(sensitiveDimensions(d, { dimensions: [], outcomes: [] }, new Set()).total).toBe(false);
  });

  it("splitScore keeps sensitive dimensions and a sensitive total out of the plain score", () => {
    const form = recoveryCheckSeed({ baseUrl: "https://beam.example.com" });
    const a: Answers = { sleep_hours: "7_8", sleep_quality: 4, stress_level: 7, stress_physical: true, movement: "daily", screen_time: "lt1", recovery_practices: ["sauna", "walks"], cold_exposure: true };
    const s = computeScore(form.definition, form.scoring, a);
    expect(s.sensitiveDimensionKeys).toEqual(["sleep", "stress"]);
    expect(s.dimensions.sleep).toEqual({ value: 10, rangeKey: "good" });
    expect(s.dimensions.stress).toEqual({ value: 7.5, rangeKey: "high" });
    expect(s.dimensions.habits).toEqual({ value: 24, rangeKey: "high" });
    expect(s.total).toBe(80);
    expect(s.totalSensitive).toBe(false);
    const split = splitScore(s);
    expect(Object.keys(split.plain.dimensions)).toEqual(["habits"]);
    expect(Object.keys(split.sensitive)).toEqual(["sleep", "stress"]);
    expect(split.plain.total).toBe(80);
    expect(selectOutcome(form.scoring, a, s)?.key).toBe("recovery_pro");
    const hidden = splitScore({ ...s, totalSensitive: true });
    expect(hidden.plain).toMatchObject({ total: null, totalRangeKey: null });
  });
});
