/**
 * Form logic (forms spec rules L1 to L7, U9, L6 sensitivity): condition evaluation, visibility,
 * the next step after a section, the full path with its ending, answer validation and the
 * sensitive split. Pure: the server runs it at every save and at submit, the client runs the
 * same functions for display; the server result is authoritative (L5).
 */
import { z } from "zod";
import { normalisePhone } from "../crm/normalise";
import { computeScore, selectOutcome, sensitiveDimensions } from "./scoring";
import { FORM_LIMITS } from "./definition";
import type {
  AnswerValue,
  Answers,
  Condition,
  ConditionValue,
  EndingKey,
  Field,
  FieldKey,
  FormDefinition,
  FormScoring,
  ScoreState,
  Section,
  SectionKey,
} from "./types";

export type EvalState = { answers: Answers; scores: ScoreState };

export const EMPTY_SCORES: ScoreState = Object.freeze({ total: null, totalRangeKey: null, dimensions: {} }) as ScoreState;
const EMPTY_SCORING: FormScoring = { dimensions: [], outcomes: [] };

const own = <T>(rec: Record<string, T>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined);

/** An answer counts when it is not null, not blank and not an empty selection (`false` counts). */
export function isAnswered(v: AnswerValue | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function comparable(v: unknown): number | string | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return v;
  return null;
}

function compare(a: unknown, b: unknown): number | null {
  const x = comparable(a);
  const y = comparable(b);
  if (x === null || y === null) return null;
  if (typeof x === "number" && typeof y === "number") return x - y;
  if (typeof x === "string" && typeof y === "string") return x < y ? -1 : x > y ? 1 : 0;
  const nx = Number(x);
  const ny = Number(y);
  return Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : null;
}

function equals(v: AnswerValue, value: ConditionValue | undefined): boolean {
  if (value === undefined) return false;
  if (Array.isArray(v)) {
    if (Array.isArray(value)) return v.length === value.length && value.every((x) => v.includes(String(x)));
    return v.length === 1 && v[0] === String(value);
  }
  if (Array.isArray(value)) return false;
  if (typeof v === "number" || typeof value === "number") return compare(v, value) === 0;
  return v === value;
}

function inList(v: AnswerValue, value: ConditionValue | undefined): boolean {
  if (!Array.isArray(value)) return equals(v, value);
  if (Array.isArray(v)) return v.some((x) => value.some((y) => String(y) === x));
  return value.some((y) => equals(v, y));
}

function fieldLeaf(v: AnswerValue | undefined, op: string, value: ConditionValue | undefined): boolean {
  const answered = isAnswered(v);
  if (op === "answered") return answered;
  if (op === "not_answered") return !answered;
  if (!answered) return false;
  const a = v as AnswerValue;
  switch (op) {
    case "eq":
      return equals(a, value);
    case "neq":
      return !equals(a, value);
    case "in":
      return inList(a, value);
    case "not_in":
      return !inList(a, value);
    case "contains":
      if (Array.isArray(a)) return Array.isArray(value) ? value.every((x) => a.includes(String(x))) : a.includes(String(value));
      return equals(a, value);
    default: {
      const c = compare(a, value);
      if (c === null) return false;
      return op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0;
    }
  }
}

function scoreLeaf(v: number | null, op: string, value: number): boolean {
  if (op === "answered") return v !== null;
  if (op === "not_answered") return v === null;
  if (v === null) return false;
  switch (op) {
    case "eq":
      return v === value;
    case "neq":
      return v !== value;
    case "gt":
      return v > value;
    case "gte":
      return v >= value;
    case "lt":
      return v < value;
    case "lte":
      return v <= value;
    default:
      return false;
  }
}

function scoreValue(scores: ScoreState, key: string): number | null {
  if (key === "total") return scores.total;
  return own(scores.dimensions, key)?.value ?? null;
}

function rangeKeyOf(scores: ScoreState, dimension: string): string | null {
  if (dimension === "total") return scores.totalRangeKey;
  return own(scores.dimensions, dimension)?.rangeKey ?? null;
}

/** Rule F4: evaluates a condition against answers and scores. A `null` score matches nothing (S3). */
export function evaluateCondition(c: Condition, s: { answers: Answers; scores: ScoreState }): boolean {
  if ("all" in c) return c.all.every((x) => evaluateCondition(x, s));
  if ("any" in c) return c.any.some((x) => evaluateCondition(x, s));
  if ("not" in c) return !evaluateCondition(c.not, s);
  if ("field" in c) return fieldLeaf(own(s.answers, c.field), c.op, c.value);
  if ("score" in c) return scoreLeaf(scoreValue(s.scores, c.score), c.op, c.value);
  return rangeKeyOf(s.scores, c.range.dimension) === c.range.key;
}

/** Rule L1: a field or section without `visibleIf` is visible. */
export function isVisible(target: Field | Section, s: { answers: Answers; scores: ScoreState }): boolean {
  return target.visibleIf === undefined || evaluateCondition(target.visibleIf, s);
}

/** Field keys, score keys (dimensions or `total`) and range dimensions a condition reads. */
export function conditionRefs(c: Condition): { fields: FieldKey[]; dimensions: string[] } {
  const fields = new Set<string>();
  const dimensions = new Set<string>();
  const walk = (x: Condition): void => {
    if ("all" in x) x.all.forEach(walk);
    else if ("any" in x) x.any.forEach(walk);
    else if ("not" in x) walk(x.not);
    else if ("field" in x) fields.add(x.field);
    else if ("score" in x) dimensions.add(x.score);
    else dimensions.add(x.range.dimension);
  };
  walk(c);
  return { fields: [...fields], dimensions: [...dimensions] };
}

const readsScores = (c: Condition | undefined): boolean => c !== undefined && conditionRefs(c).dimensions.length > 0;

function stateFor(def: FormDefinition, scoring: FormScoring, clean: Answers, c: Condition | undefined): EvalState {
  return { answers: clean, scores: readsScores(c) ? computeScore(def, scoring, clean) : EMPTY_SCORES };
}

/** Adds the visible, answered fields of `section` (in order, L4) to `clean`. */
function addVisible(def: FormDefinition, scoring: FormScoring, section: Section, answers: Answers, clean: Answers): void {
  for (const fk of section.fieldKeys) {
    const f = own(def.fields, fk);
    if (!f) continue;
    if (!isVisible(f, stateFor(def, scoring, clean, f.visibleIf))) continue;
    const v = own(answers, fk);
    if (v !== undefined && isAnswered(v)) clean[fk] = v;
  }
}

/** Rule L7: an `end` rule's ending, else the selected outcome's ending, else the first ending. */
function resolveEnding(def: FormDefinition, scoring: FormScoring, clean: Answers, fromRule: EndingKey | null): EndingKey | null {
  const exists = (k: string | undefined): k is string => k !== undefined && def.endings.some((e) => e.key === k);
  if (fromRule !== null && exists(fromRule)) return fromRule;
  if (scoring.outcomes.length > 0 || scoring.defaultOutcomeKey) {
    const outcome = selectOutcome(scoring, clean, computeScore(def, scoring, clean));
    if (exists(outcome?.endingKey)) return outcome.endingKey;
  }
  return def.endings[0]?.key ?? null;
}

type Step = { section: SectionKey } | { end: EndingKey | null };

/** One step with answers that are already clean (only visible fields of the path so far). */
function step(def: FormDefinition, scoring: FormScoring, clean: Answers, current: SectionKey | null): Step {
  const order = def.sections;
  const firstVisibleFrom = (i: number): SectionKey | null => {
    for (let j = i; j < order.length; j++) {
      const s = order[j]!;
      if (isVisible(s, stateFor(def, scoring, clean, s.visibleIf))) return s.key;
    }
    return null;
  };
  const idx = current === null ? -1 : order.findIndex((s) => s.key === current);
  if (idx < 0) {
    const first = firstVisibleFrom(0);
    return first ? { section: first } : { end: resolveEnding(def, scoring, clean, null) };
  }
  for (const rule of def.logic) {
    if (rule.afterSection !== current) continue;
    if (!evaluateCondition(rule.if, stateFor(def, scoring, clean, rule.if))) continue;
    if ("end" in rule.then) return { end: resolveEnding(def, scoring, clean, rule.then.end) };
    const target = order.findIndex((s) => s.key === (rule.then as { goto: string }).goto);
    if (target <= idx) continue; // L3: forward only; a backward rule is ignored (and a publish error)
    const next = firstVisibleFrom(target);
    return next ? { section: next } : { end: resolveEnding(def, scoring, clean, null) };
  }
  const next = firstVisibleFrom(idx + 1);
  return next ? { section: next } : { end: resolveEnding(def, scoring, clean, null) };
}

type Walk = { path: SectionKey[]; clean: Answers; last: Step };

function walk(def: FormDefinition, scoring: FormScoring, answers: Answers, stopAfter?: SectionKey): Walk {
  const clean: Answers = {};
  const path: SectionKey[] = [];
  let cur = step(def, scoring, clean, null);
  for (let guard = 0; "section" in cur && guard <= def.sections.length; guard++) {
    const key = cur.section;
    if (path.includes(key)) break;
    path.push(key);
    addVisible(def, scoring, def.sections.find((s) => s.key === key)!, answers, clean);
    cur = step(def, scoring, clean, key);
    if (key === stopAfter) break;
  }
  return { path, clean, last: cur };
}

/**
 * Rule L2/L5: what follows `current` (`null` = the start). The answers that count are those of
 * the visible fields on the path to `current`; when `current` is not on that path (a client that
 * went elsewhere), the visible fields of every section up to `current` count.
 */
export function nextStep(def: FormDefinition, scoring: FormScoring, answers: Answers, current: SectionKey | null): { section: SectionKey } | { end: EndingKey | null } {
  const sc = scoring ?? EMPTY_SCORING;
  if (current === null) return step(def, sc, {}, null);
  const w = walk(def, sc, answers, current);
  if (w.path.at(-1) === current) return w.last;
  const clean: Answers = {};
  for (const s of def.sections) {
    if (isVisible(s, stateFor(def, sc, clean, s.visibleIf))) addVisible(def, sc, s, answers, clean);
    if (s.key === current) break;
  }
  return step(def, sc, clean, current);
}

/** Rules L2 and L7: the sections a visitor passes with these answers, and the ending reached. */
export function computePath(def: FormDefinition, scoring: FormScoring, answers: Answers): { path: SectionKey[]; endingKey: EndingKey | null } {
  const w = walk(def, scoring ?? EMPTY_SCORING, answers);
  return { path: w.path, endingKey: "end" in w.last ? w.last.end : null };
}

/** Answers of the visible fields on the computed path (hidden answers dropped, L1). */
export function visibleAnswers(def: FormDefinition, scoring: FormScoring, answers: Answers): Answers {
  return walk(def, scoring ?? EMPTY_SCORING, answers).clean;
}

// ---------------------------------------------------------------------------
// Answer validation (U9)
// ---------------------------------------------------------------------------

export type AnswerError =
  | "required"
  | "invalid"
  | "invalid_option"
  | "too_few"
  | "too_many"
  | "too_long"
  | "out_of_range"
  | "invalid_step"
  | "invalid_number"
  | "invalid_email"
  | "invalid_phone"
  | "invalid_date";

const EmailSchema = z.email();
const HIDDEN_MAX = 100;

/** A valid calendar date `YYYY-MM-DD`. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

type Checked = { value: AnswerValue | undefined } | { error: AnswerError };

/** Validates and normalises one value; `value: undefined` = not answered. */
export function checkValue(f: Field, raw: unknown): Checked {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "") || (Array.isArray(raw) && raw.length === 0)) return { value: undefined };
  switch (f.type) {
    case "short_text":
    case "long_text": {
      if (typeof raw !== "string") return { error: "invalid" };
      const v = raw.trim();
      const max = f.maxLength ?? (f.type === "short_text" ? FORM_LIMITS.shortText : FORM_LIMITS.longText);
      return v.length > max ? { error: "too_long" } : { value: v };
    }
    case "hidden":
    case "utm":
      if (typeof raw !== "string" && typeof raw !== "number") return { error: "invalid" };
      return { value: String(raw).trim().slice(0, HIDDEN_MAX) };
    case "email": {
      if (typeof raw !== "string") return { error: "invalid_email" };
      const v = raw.trim().toLowerCase();
      return v.length <= 254 && EmailSchema.safeParse(v).success ? { value: v } : { error: "invalid_email" };
    }
    case "phone": {
      if (typeof raw !== "string") return { error: "invalid_phone" };
      const v = normalisePhone(raw, "BE");
      return v ? { value: v } : { error: "invalid_phone" };
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return { error: "invalid_number" };
      if ((f.min !== undefined && raw < f.min) || (f.max !== undefined && raw > f.max)) return { error: "out_of_range" };
      if (f.step !== undefined) {
        const n = (raw - (f.min ?? 0)) / f.step;
        if (Math.abs(n - Math.round(n)) > 1e-9) return { error: "invalid_step" };
      }
      return { value: raw };
    }
    case "rating":
      if (typeof raw !== "number" || !Number.isInteger(raw)) return { error: "invalid_number" };
      return raw < 1 || raw > f.scale ? { error: "out_of_range" } : { value: raw };
    case "single_choice":
    case "dropdown":
      return typeof raw === "string" && f.options.some((o) => o.key === raw) ? { value: raw } : { error: "invalid_option" };
    case "multiple_choice": {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !f.options.some((o) => o.key === x))) return { error: "invalid_option" };
      const v = [...new Set(raw as string[])];
      if (f.minSelected !== undefined && v.length < f.minSelected) return { error: "too_few" };
      if (f.maxSelected !== undefined && v.length > f.maxSelected) return { error: "too_many" };
      return { value: v };
    }
    case "yes_no":
    case "consent":
    case "acknowledgement":
      return typeof raw === "boolean" ? { value: raw } : { error: "invalid" };
    case "date":
      if (!isIsoDate(raw)) return { error: "invalid_date" };
      return (f.min !== undefined && raw < f.min) || (f.max !== undefined && raw > f.max) ? { error: "out_of_range" } : { value: raw };
  }
}

/** `acknowledgement` is always required (F2). */
export function isRequired(f: Field): boolean {
  return f.required || f.type === "acknowledgement";
}

/**
 * Rule U9 and L1: validates the visible fields of `path` in order. Answers of fields that are
 * hidden or not on the path are dropped from `clean`. With `final`, every visible required
 * field must be answered (consent and acknowledgement boxes must be ticked).
 */
export function validateAnswers(def: FormDefinition, path: SectionKey[], answers: Answers, opts: { final: boolean }, scoring?: FormScoring): { ok: true; clean: Answers } | { ok: false; fields: Record<string, string> } {
  const sc = scoring ?? EMPTY_SCORING;
  const clean: Answers = {};
  const fields: Record<string, string> = {};
  for (const key of path) {
    const section = def.sections.find((s) => s.key === key);
    if (!section) continue;
    for (const fk of section.fieldKeys) {
      const f = own(def.fields, fk);
      if (!f || !isVisible(f, stateFor(def, sc, clean, f.visibleIf))) continue;
      const r = checkValue(f, own(answers, fk));
      if ("error" in r) {
        fields[fk] = r.error;
        continue;
      }
      const ticked = r.value === true;
      const missing = r.value === undefined || ((f.type === "consent" || f.type === "acknowledgement") && !ticked);
      if (missing && opts.final && isRequired(f)) {
        fields[fk] = "required";
        continue;
      }
      if (r.value === undefined) continue;
      if (f.type === "acknowledgement" && !ticked) continue;
      clean[fk] = r.value;
    }
  }
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, clean };
}

// ---------------------------------------------------------------------------
// Sensitivity (L6, S6, SE1) and consent purposes
// ---------------------------------------------------------------------------

/**
 * Rule L6 and S6: the sensitive field keys, in field order. A field is sensitive when it is
 * marked so, when its `visibleIf` reads sensitive data, or when its section's `visibleIf` does.
 * Without `scoring` every score or range reference counts as sensitive (the safe side).
 */
export function deriveSensitiveKeys(def: FormDefinition, scoring?: FormScoring): string[] {
  const sens = new Set(Object.values(def.fields).filter((f) => f.sensitive).map((f) => f.key));
  for (let changed = true; changed; ) {
    changed = false;
    const dims = scoring ? sensitiveDimensions(def, scoring, sens) : null;
    const reads = (c: Condition | undefined): boolean => {
      if (!c) return false;
      const r = conditionRefs(c);
      if (r.fields.some((k) => sens.has(k))) return true;
      if (!r.dimensions.length) return false;
      if (!dims) return true;
      return r.dimensions.some((d) => (d === "total" ? dims.total : dims.dimensions.has(d)));
    };
    const add = (k: string): void => {
      if (!sens.has(k) && Object.hasOwn(def.fields, k)) {
        sens.add(k);
        changed = true;
      }
    };
    for (const f of Object.values(def.fields)) if (reads(f.visibleIf)) add(f.key);
    for (const s of def.sections) if (reads(s.visibleIf)) s.fieldKeys.forEach(add);
  }
  return Object.keys(def.fields).filter((k) => sens.has(k));
}

/** Rule SE1: sensitive answers never go to `form_submissions.answers`. */
export function splitSensitive(def: FormDefinition, answers: Answers, scoring?: FormScoring): { plain: Answers; sensitive: Answers } {
  const keys = new Set(deriveSensitiveKeys(def, scoring));
  const plain: Answers = {};
  const sensitive: Answers = {};
  for (const [k, v] of Object.entries(answers)) (keys.has(k) ? sensitive : plain)[k] = v;
  return { plain, sensitive };
}

/** The purposes of the consent fields, in field order, without duplicates. */
export function deriveConsentPurposes(def: FormDefinition): string[] {
  const out: string[] = [];
  for (const f of Object.values(def.fields)) if (f.type === "consent" && !out.includes(f.purpose)) out.push(f.purpose);
  return out;
}

/** The section that holds a field, or `undefined`. */
export function sectionOf(def: FormDefinition, fieldKey: FieldKey): Section | undefined {
  return def.sections.find((s) => s.fieldKeys.includes(fieldKey));
}
