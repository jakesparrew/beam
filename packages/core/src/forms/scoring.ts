/**
 * Scoring (forms spec rules S1 to S8): weighted answers, dimensions in dependency order, ranges,
 * the total, outcomes and the sensitivity of dimensions. Pure; scores are computed once at
 * submit with the pinned version and stored (S8).
 */
import { evaluateNumber, expressionRefs, parseExpression, type Expr } from "./expression";
import { deriveSensitiveKeys, evaluateCondition, isAnswered } from "./logic";
import type { AnswerValue, Answers, Dimension, DimensionKey, DimensionScore, Field, FieldKey, FormDefinition, FormScoring, Outcome, Range, ScoreResult, ScoreState } from "./types";

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/**
 * Rule S1: the range holding `value`. `from` is inclusive and `to` exclusive, except for the
 * last range (the one with the highest `to`), whose `to` is inclusive. `null` matches nothing.
 */
export function findRange(ranges: readonly Range[], value: number | null): Range | null {
  if (value === null || !Number.isFinite(value) || ranges.length === 0) return null;
  const top = Math.max(...ranges.map((r) => r.to));
  for (const r of ranges) if (value >= r.from && (value < r.to || (r.to === top && value === top))) return r;
  return null;
}

/** Rule S2: what one answered field adds to a dimension, or `null` when it does not contribute. */
export function contribution(f: Field, dim: DimensionKey, v: AnswerValue): number | null {
  switch (f.type) {
    case "single_choice":
    case "dropdown": {
      const o = f.options.find((x) => x.key === v);
      return own(o?.scores, dim) ?? null;
    }
    case "multiple_choice": {
      if (!Array.isArray(v)) return null;
      const parts = f.options.filter((o) => v.includes(o.key)).map((o) => own(o.scores, dim));
      const nums = parts.filter((p): p is number => typeof p === "number");
      return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
    }
    case "yes_no":
      if (typeof v !== "boolean") return null;
      return own(v ? f.scores?.yes : f.scores?.no, dim) ?? null;
    case "rating":
    case "number": {
      const w = own(f.weights, dim);
      return typeof v === "number" && typeof w === "number" ? v * w : null;
    }
    default:
      return null;
  }
}

/** True when a field can add to `dim` (it carries a score or weight for it). */
export function contributes(f: Field, dim: DimensionKey): boolean {
  switch (f.type) {
    case "single_choice":
    case "dropdown":
    case "multiple_choice":
      return f.options.some((o) => own(o.scores, dim) !== undefined);
    case "yes_no":
      return own(f.scores?.yes, dim) !== undefined || own(f.scores?.no, dim) !== undefined;
    case "rating":
    case "number":
      return own(f.weights, dim) !== undefined;
    default:
      return false;
  }
}

/** The fields a dimension reads: contributing fields for `sum`/`avg`, `answer.<key>` refs for formulas. */
export function dimensionFields(def: FormDefinition, d: Dimension): FieldKey[] {
  if (d.kind === "formula") {
    const p = d.formula ? parseExpression(d.formula) : null;
    return p?.ok ? expressionRefs(p.ast).answers.filter((k) => Object.hasOwn(def.fields, k)) : [];
  }
  return Object.values(def.fields).filter((f) => contributes(f, d.key)).map((f) => f.key);
}

/** Dimensions a dimension formula reads. */
export function dimensionDeps(d: Dimension): DimensionKey[] {
  if (d.kind !== "formula" || !d.formula) return [];
  const p = parseExpression(d.formula);
  return p.ok ? expressionRefs(p.ast).dims : [];
}

/**
 * Rule S5: dimension keys in dependency order. Dimensions on a cycle (or depending on one) are
 * listed in `cyclic` and left out of `order` (a publish error; they compute to `null`).
 */
export function dimensionOrder(scoring: FormScoring): { order: DimensionKey[]; cyclic: DimensionKey[] } {
  const byKey = new Map(scoring.dimensions.map((d) => [d.key, d]));
  const state = new Map<string, "visiting" | "done" | "cyclic">();
  const order: string[] = [];
  const visit = (k: string): boolean => {
    const s = state.get(k);
    if (s === "done") return true;
    if (s === "visiting" || s === "cyclic") return false;
    state.set(k, "visiting");
    let ok = true;
    for (const dep of dimensionDeps(byKey.get(k)!)) if (byKey.has(dep) && !visit(dep)) ok = false;
    state.set(k, ok ? "done" : "cyclic");
    if (ok) order.push(k);
    return ok;
  };
  for (const d of scoring.dimensions) visit(d.key);
  return { order, cyclic: scoring.dimensions.map((d) => d.key).filter((k) => state.get(k) === "cyclic") };
}

/**
 * Rule S6: sensitive dimensions given the sensitive field keys: a contributing or referenced
 * field is sensitive, or the formula reads a sensitive dimension. The total is sensitive when
 * it sums a sensitive dimension or its formula reads sensitive data.
 */
export function sensitiveDimensions(def: FormDefinition, scoring: FormScoring, sensitiveFields: ReadonlySet<string>): { dimensions: Set<DimensionKey>; total: boolean } {
  const dims = new Set<string>();
  const { order, cyclic } = dimensionOrder(scoring);
  const byKey = new Map(scoring.dimensions.map((d) => [d.key, d]));
  for (const k of [...order, ...cyclic]) {
    const d = byKey.get(k)!;
    if (dimensionFields(def, d).some((f) => sensitiveFields.has(f)) || dimensionDeps(d).some((x) => dims.has(x))) dims.add(k);
  }
  let total = false;
  if (scoring.total?.kind === "sum_dimensions") total = scoring.dimensions.some((d) => dims.has(d.key));
  else if (scoring.total?.kind === "formula" && scoring.total.formula) {
    const p = parseExpression(scoring.total.formula);
    total = p.ok ? expressionRefs(p.ast).dims.some((x) => dims.has(x)) || expressionRefs(p.ast).answers.some((a) => sensitiveFields.has(a)) : false;
  }
  return { dimensions: dims, total };
}

const sensitivityCache = new WeakMap<FormDefinition, WeakMap<FormScoring, { dimensions: Set<string>; total: boolean }>>();
/** S6 with L6-derived sensitive fields, cached per definition and scoring object. */
function sensitivityOf(def: FormDefinition, scoring: FormScoring): { dimensions: Set<string>; total: boolean } {
  let inner = sensitivityCache.get(def);
  if (!inner) sensitivityCache.set(def, (inner = new WeakMap()));
  let hit = inner.get(scoring);
  if (!hit) inner.set(scoring, (hit = sensitiveDimensions(def, scoring, new Set(deriveSensitiveKeys(def, scoring)))));
  return hit;
}

const clampTo = (v: number | null, d: Dimension): number | null => {
  if (v === null) return null;
  let x = v;
  if (d.min !== undefined) x = Math.max(d.min, x);
  if (d.max !== undefined) x = Math.min(d.max, x);
  return x;
};

const parsed = new Map<string, Expr | null>();
function ast(formula: string | undefined): Expr | null {
  if (!formula) return null;
  if (!parsed.has(formula)) {
    const p = parseExpression(formula);
    if (parsed.size > 500) parsed.clear();
    parsed.set(formula, p.ok ? p.ast : null);
  }
  return parsed.get(formula) ?? null;
}

/**
 * Rules S1 to S3 and S6: every dimension (in dependency order), its range, the total and its
 * range. `answers` are the clean answers (hidden and unanswered fields add nothing).
 */
export function computeScore(def: FormDefinition, scoring: FormScoring, answers: Answers): ScoreResult {
  const dimensions: Record<string, DimensionScore> = {};
  const values: Record<string, number | null> = {};
  const { order, cyclic } = dimensionOrder(scoring);
  const byKey = new Map(scoring.dimensions.map((d) => [d.key, d]));
  for (const k of cyclic) values[k] = null;
  for (const k of order) {
    const d = byKey.get(k)!;
    let v: number | null;
    if (d.kind === "formula") {
      const e = ast(d.formula);
      v = e ? evaluateNumber(e, { dims: values, answers }) : null;
    } else {
      let sum = 0;
      let n = 0;
      for (const f of Object.values(def.fields)) {
        if (!contributes(f, k)) continue;
        const a = own(answers, f.key);
        if (a === undefined || !isAnswered(a)) continue;
        const c = contribution(f, k, a);
        n++;
        sum += c ?? 0;
      }
      v = d.kind === "avg" ? (n === 0 ? null : sum / n) : sum;
    }
    values[k] = clampTo(v, d);
  }
  for (const d of scoring.dimensions) {
    const v = values[d.key] ?? null;
    dimensions[d.key] = { value: v, rangeKey: findRange(d.ranges, v)?.key ?? null };
  }

  let total: number | null = null;
  if (scoring.total?.kind === "sum_dimensions") {
    const xs = scoring.dimensions.map((d) => values[d.key]).filter((x): x is number => typeof x === "number");
    total = xs.length ? xs.reduce((a, b) => a + b, 0) : null;
  } else if (scoring.total?.kind === "formula") {
    const e = ast(scoring.total.formula);
    total = e ? evaluateNumber(e, { dims: values, answers }) : null;
  }
  const totalRangeKey = scoring.total ? (findRange(scoring.total.ranges, total)?.key ?? null) : null;

  const sens = sensitivityOf(def, scoring);
  return {
    total,
    totalRangeKey,
    dimensions,
    sensitiveDimensionKeys: scoring.dimensions.map((d) => d.key).filter((k) => sens.dimensions.has(k)),
    totalSensitive: sens.total,
  };
}

/** Rule S4: the first outcome by ascending `priority` whose `when` matches, else the default. */
export function selectOutcome(scoring: FormScoring, answers: Answers, score: ScoreState): Outcome | null {
  if (scoring.outcomes.length === 0) return null;
  const sorted = scoring.outcomes.map((o, i) => ({ o, i })).sort((a, b) => a.o.priority - b.o.priority || a.i - b.i);
  for (const { o } of sorted) if (evaluateCondition(o.when, { answers, scores: score })) return o;
  return scoring.outcomes.find((o) => o.key === scoring.defaultOutcomeKey) ?? null;
}

/**
 * Rule S6: the score as stored in `form_submissions.score` (non-sensitive dimensions, and the
 * total only when it does not depend on a sensitive dimension) and the sensitive values that go
 * to `form_sensitive_answers` as `score:<key>`.
 */
export function splitScore(score: ScoreResult): {
  plain: { total: number | null; totalRangeKey: string | null; dimensions: Record<string, DimensionScore> };
  sensitive: Record<string, DimensionScore>;
} {
  const plainDims: Record<string, DimensionScore> = {};
  const sensitive: Record<string, DimensionScore> = {};
  for (const [k, v] of Object.entries(score.dimensions)) (score.sensitiveDimensionKeys.includes(k) ? sensitive : plainDims)[`${k}`] = v;
  return {
    plain: { total: score.totalSensitive ? null : score.total, totalRangeKey: score.totalSensitive ? null : score.totalRangeKey, dimensions: plainDims },
    sensitive,
  };
}
