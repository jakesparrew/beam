/**
 * Zod schemas of the forms JSON shapes (forms spec rules F1 to F7, S1, S4, I2):
 * `form_versions.definition` (`FormDefinition`), `form_versions.scoring` (`FormScoring`) and
 * `form_import_sources.mapping` (`ImportMapping`). Structural rules live here (types, key
 * regexes, F7 limits, `acknowledgement` always required); cross-reference and publish rules live
 * in `validate.ts`.
 */
import { z } from "zod";
import { sha256Hex } from "../crm/normalise";
import { LocalizedTextSchema } from "../i18n/localized-text";
import {
  CONDITION_OPS,
  CTA_KINDS,
  FORM_CONSENT_PURPOSES,
  MAPS_TO,
  SENSITIVE_KINDS,
  UTM_PARAMS,
  type ChoiceOption,
  type Condition,
  type Cta,
  type Dimension,
  type Ending,
  type Field,
  type FormDefinition as FormDefinitionT,
  type FormKind,
  type FormScoring as FormScoringT,
  type FormSettings as FormSettingsT,
  type ImportMapping as ImportMappingT,
  type LogicRule,
  type Outcome,
  type Range,
  type Section,
} from "./types";

/** Rule F2: field keys (also used for sections, endings, dimensions, outcomes, rules and CTAs). */
export const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** Option keys may start with a digit (`1`, `0_2_hours`). */
export const OPTION_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** Rule F1: `FormSettings.funnel`. */
export const FUNNEL_RE = /^[a-z0-9_-]{1,64}$/;

/** Rule F7 and F4. */
export const FORM_LIMITS = {
  sections: 30,
  fields: 200,
  outcomes: 50,
  dimensions: 20,
  logicRules: 100,
  bytes: 256 * 1024,
  conditionDepth: 6,
  conditionLeaves: 50,
  optionsMin: 2,
  optionsMax: 50,
  ctas: 4,
  shortText: 255,
  longText: 5000,
  acknowledgementText: 5000,
} as const;

const Key = z.string().regex(KEY_RE, "invalid_key");
const Text = LocalizedTextSchema;
const HttpsUrl = z.url({ protocol: /^https$/ }).max(2000);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date");
const Scores = z.record(Key, z.number().finite());

// ---------------------------------------------------------------------------
// Conditions (F4)
// ---------------------------------------------------------------------------

const ConditionValueSchema = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.array(z.union([z.string().max(200), z.number().finite()])).max(50)]);

const ConditionNode: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionNode).min(1) }).strict(),
    z.object({ any: z.array(ConditionNode).min(1) }).strict(),
    z.object({ not: ConditionNode }).strict(),
    z.object({ field: Key, op: z.enum(CONDITION_OPS), value: ConditionValueSchema.optional() }).strict(),
    z.object({ score: z.union([Key, z.literal("total")]), op: z.enum(CONDITION_OPS), value: z.number().finite() }).strict(),
    z.object({ range: z.object({ dimension: z.union([Key, z.literal("total")]), key: Key }).strict() }).strict(),
  ]),
);

/** Depth (a leaf is 1) and leaf count of a condition. */
export function conditionShape(c: Condition): { depth: number; leaves: number } {
  if ("all" in c || "any" in c) {
    const list = "all" in c ? c.all : c.any;
    const parts = list.map(conditionShape);
    return { depth: 1 + Math.max(0, ...parts.map((p) => p.depth)), leaves: parts.reduce((n, p) => n + p.leaves, 0) };
  }
  if ("not" in c) {
    const p = conditionShape(c.not);
    return { depth: 1 + p.depth, leaves: p.leaves };
  }
  return { depth: 1, leaves: 1 };
}

/** A condition within the F4 limits (depth 6, 50 leaves). */
export const ConditionSchema: z.ZodType<Condition> = ConditionNode.superRefine((c, ctx) => {
  const { depth, leaves } = conditionShape(c);
  if (depth > FORM_LIMITS.conditionDepth) ctx.addIssue({ code: "custom", message: "condition_too_deep" });
  if (leaves > FORM_LIMITS.conditionLeaves) ctx.addIssue({ code: "custom", message: "condition_too_many_leaves" });
});

/** The value operand of a field leaf, checked against the operator. */
function opNeedsValue(op: (typeof CONDITION_OPS)[number]): boolean {
  return op !== "answered" && op !== "not_answered";
}
export { opNeedsValue };

// ---------------------------------------------------------------------------
// Fields (F2)
// ---------------------------------------------------------------------------

const OptionSchema: z.ZodType<ChoiceOption> = z.object({ key: z.string().regex(OPTION_KEY_RE, "invalid_key"), label: Text, scores: Scores.optional() }).strict();
const Options = z.array(OptionSchema).min(FORM_LIMITS.optionsMin).max(FORM_LIMITS.optionsMax);

const base = {
  key: Key,
  label: Text,
  help: Text.optional(),
  placeholder: Text.optional(),
  required: z.boolean().default(false),
  visibleIf: ConditionSchema.optional(),
  sensitive: z.boolean().default(false),
  sensitiveKind: z.enum(SENSITIVE_KINDS).optional(),
  mapsTo: z.enum(MAPS_TO).optional(),
};

const Weights = Scores.optional();
const intCount = z.number().int().min(0).max(FORM_LIMITS.optionsMax);

const FieldUnion = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("single_choice"), options: Options }).strict(),
  z.object({ ...base, type: z.literal("dropdown"), options: Options }).strict(),
  z.object({ ...base, type: z.literal("multiple_choice"), options: Options, minSelected: intCount.optional(), maxSelected: intCount.optional() }).strict(),
  z.object({ ...base, type: z.literal("yes_no"), scores: z.object({ yes: Scores.optional(), no: Scores.optional() }).strict().optional() }).strict(),
  z.object({ ...base, type: z.literal("rating"), scale: z.union([z.literal(5), z.literal(10)]), weights: Weights }).strict(),
  z.object({ ...base, type: z.literal("number"), min: z.number().finite().optional(), max: z.number().finite().optional(), step: z.number().finite().positive().optional(), weights: Weights }).strict(),
  z.object({ ...base, type: z.literal("short_text"), maxLength: z.number().int().min(1).max(FORM_LIMITS.shortText).optional() }).strict(),
  z.object({ ...base, type: z.literal("long_text"), maxLength: z.number().int().min(1).max(FORM_LIMITS.longText).optional() }).strict(),
  z.object({ ...base, type: z.literal("date"), min: IsoDate.optional(), max: IsoDate.optional() }).strict(),
  z.object({ ...base, type: z.literal("email") }).strict(),
  z.object({ ...base, type: z.literal("phone") }).strict(),
  z.object({ ...base, type: z.literal("consent"), purpose: z.enum(FORM_CONSENT_PURPOSES), wording: Text }).strict(),
  z
    .object({
      ...base,
      type: z.literal("acknowledgement"),
      required: z.literal(true, { message: "acknowledgement_not_required" }).default(true),
      text: Text.refine((t) => Object.values(t).every((v) => (v?.length ?? 0) <= FORM_LIMITS.acknowledgementText), "too_long"),
    })
    .strict(),
  z.object({ ...base, type: z.literal("hidden"), from: z.enum(["query", "constant"]), param: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(), value: z.string().max(100).optional() }).strict(),
  z.object({ ...base, type: z.literal("utm"), param: z.enum(UTM_PARAMS) }).strict(),
]);

export const FieldSchema: z.ZodType<Field> = FieldUnion.superRefine((f, ctx) => {
  if (f.type === "multiple_choice" && f.minSelected !== undefined && f.maxSelected !== undefined && f.minSelected > f.maxSelected) {
    ctx.addIssue({ code: "custom", path: ["minSelected"], message: "min_above_max" });
  }
  if (f.type === "number" && f.min !== undefined && f.max !== undefined && f.min > f.max) ctx.addIssue({ code: "custom", path: ["min"], message: "min_above_max" });
  if (f.type === "date" && f.min !== undefined && f.max !== undefined && f.min > f.max) ctx.addIssue({ code: "custom", path: ["min"], message: "min_above_max" });
  if (f.type === "hidden" && f.from === "query" && !f.param) ctx.addIssue({ code: "custom", path: ["param"], message: "param_required" });
  if (f.type === "hidden" && f.from === "constant" && f.value === undefined) ctx.addIssue({ code: "custom", path: ["value"], message: "value_required" });
  if ("options" in f) {
    const seen = new Set<string>();
    f.options.forEach((o, i) => {
      if (seen.has(o.key)) ctx.addIssue({ code: "custom", path: ["options", i, "key"], message: "duplicate_key" });
      seen.add(o.key);
    });
  }
}) as z.ZodType<Field>;

// ---------------------------------------------------------------------------
// Sections, logic, endings (F3, L2, F5)
// ---------------------------------------------------------------------------

export const SectionSchema: z.ZodType<Section> = z
  .object({ key: Key, title: Text.optional(), description: Text.optional(), fieldKeys: z.array(Key).max(FORM_LIMITS.fields), visibleIf: ConditionSchema.optional() })
  .strict();

export const LogicRuleSchema: z.ZodType<LogicRule> = z
  .object({
    key: Key,
    afterSection: Key,
    if: ConditionSchema,
    then: z.union([z.object({ goto: Key }).strict(), z.object({ end: Key }).strict()]),
  })
  .strict();

export const CtaSchema: z.ZodType<Cta> = z
  .object({
    key: Key,
    label: Text,
    kind: z.enum(CTA_KINDS),
    sessionTemplateId: z.uuid().optional(),
    sessionId: z.uuid().optional(),
    productId: z.uuid().optional(),
    webinarId: z.uuid().optional(),
    url: HttpsUrl.optional(),
  })
  .strict();

export const EndingSchema: z.ZodType<Ending> = z
  .object({
    key: Key,
    kind: z.enum(["result", "thank_you", "redirect"]),
    title: Text,
    body: Text,
    showScore: z.boolean().default(false),
    showDimensions: z.array(Key).max(FORM_LIMITS.dimensions).default([]),
    ctas: z.array(CtaSchema).max(FORM_LIMITS.ctas).default([]),
    redirectUrl: HttpsUrl.optional(),
    email: z.object({ subject: Text, intro: Text }).strict().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Settings and definition (F1, F7)
// ---------------------------------------------------------------------------

export const FormSettingsSchema: z.ZodType<FormSettingsT> = z
  .object({
    resumeEnabled: z.boolean().default(false),
    resumeDays: z.number().int().min(1).max(30).default(7),
    skipKnownFields: z.boolean().default(true),
    capturePartialLeads: z.boolean().default(false),
    showProgress: z.boolean().default(true),
    sendResultEmail: z.boolean().default(false),
    submitLabel: Text,
    createInboxThread: z.boolean().default(false),
    funnel: z.string().regex(FUNNEL_RE).optional(),
    validityDays: z.number().int().min(1).max(1095).optional(),
    staffEntryAllowed: z.boolean().default(false),
  })
  .strict();

/** F1 defaults that depend on the form kind (the builder's starting point). */
export function defaultSettings(kind: FormKind, submitLabel: FormSettingsT["submitLabel"]): FormSettingsT {
  return {
    resumeEnabled: false,
    resumeDays: 7,
    skipKnownFields: true,
    capturePartialLeads: false,
    showProgress: true,
    sendResultEmail: kind === "assessment",
    submitLabel,
    createInboxThread: false,
    ...(kind === "intake" ? { validityDays: 365 } : {}),
    staffEntryAllowed: kind === "intake" || kind === "registration",
  };
}

/** F6: long-text fields of assessments and intake forms start as sensitive. */
export function defaultSensitive(kind: FormKind, type: Field["type"]): boolean {
  return type === "long_text" && (kind === "assessment" || kind === "intake");
}

/** `FormDefinition` is both the Zod schema (value) and the type. */
export type FormDefinition = FormDefinitionT;
export const FormDefinition: z.ZodType<FormDefinitionT> = z
  .object({
    title: Text,
    intro: Text.optional(),
    settings: FormSettingsSchema,
    sections: z.array(SectionSchema).max(FORM_LIMITS.sections, "limit_exceeded"),
    fields: z.record(Key, FieldSchema),
    logic: z.array(LogicRuleSchema).max(FORM_LIMITS.logicRules, "limit_exceeded").default([]),
    endings: z.array(EndingSchema).max(FORM_LIMITS.outcomes, "limit_exceeded").default([]),
  })
  .strict()
  .superRefine((d, ctx) => {
    const entries = Object.entries(d.fields);
    if (entries.length > FORM_LIMITS.fields) ctx.addIssue({ code: "custom", path: ["fields"], message: "limit_exceeded" });
    for (const [k, f] of entries) if (f.key !== k) ctx.addIssue({ code: "custom", path: ["fields", k, "key"], message: "key_mismatch" });
  }) as z.ZodType<FormDefinitionT>;

// ---------------------------------------------------------------------------
// Scoring (S1, S4)
// ---------------------------------------------------------------------------

export const RangeSchema: z.ZodType<Range> = z
  .object({ key: Key, from: z.number().finite(), to: z.number().finite(), label: Text, explanation: Text.optional(), recommendation: Text.optional() })
  .strict();

const DimKey = Key.refine((k) => k !== "total", "reserved_key");

export const DimensionSchema: z.ZodType<Dimension> = z
  .object({
    key: DimKey,
    label: Text,
    kind: z.enum(["sum", "avg", "formula"]),
    formula: z.string().max(500).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    ranges: z.array(RangeSchema).max(FORM_LIMITS.outcomes).default([]),
  })
  .strict();

export const OutcomeSchema: z.ZodType<Outcome> = z
  .object({
    key: Key,
    label: Text,
    priority: z.number().int(),
    when: ConditionSchema,
    endingKey: Key,
    tagKeys: z.array(z.string().regex(/^[a-z0-9][a-z0-9_:-]{1,62}$/)).max(20).default([]),
    explanation: Text.optional(),
    recommendation: Text.optional(),
  })
  .strict();

export type FormScoring = FormScoringT;
export const FormScoring: z.ZodType<FormScoringT> = z
  .object({
    dimensions: z.array(DimensionSchema).max(FORM_LIMITS.dimensions, "limit_exceeded").default([]),
    total: z
      .object({ kind: z.enum(["sum_dimensions", "formula"]), formula: z.string().max(500).optional(), ranges: z.array(RangeSchema).max(FORM_LIMITS.outcomes).default([]) })
      .strict()
      .optional(),
    outcomes: z.array(OutcomeSchema).max(FORM_LIMITS.outcomes, "limit_exceeded").default([]),
    defaultOutcomeKey: Key.optional(),
  })
  .strict() as z.ZodType<FormScoringT>;

/** True when a scoring has nothing to compute (`{}` in the database). */
export function isScored(scoring: FormScoringT): boolean {
  return scoring.dimensions.length > 0 || scoring.total !== undefined || scoring.outcomes.length > 0;
}

// ---------------------------------------------------------------------------
// Import mapping (I2)
// ---------------------------------------------------------------------------

const JsonPathSchema = z.string().min(1).max(300).regex(/^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+|\[\d+\]|\[[A-Za-z0-9_.$-]+=[^\]]{1,100}\])*$/, "invalid_path");

export type ImportMapping = ImportMappingT;
export const ImportMapping: z.ZodType<ImportMappingT> = z
  .object({
    email: JsonPathSchema,
    firstName: JsonPathSchema.optional(),
    lastName: JsonPathSchema.optional(),
    phone: JsonPathSchema.optional(),
    locale: JsonPathSchema.optional(),
    externalId: JsonPathSchema,
    completedAt: JsonPathSchema.optional(),
    score: JsonPathSchema.optional(),
    outcome: JsonPathSchema.optional(),
    outcomeMap: z.record(z.string().max(200), Key).optional(),
    answers: z.record(Key, JsonPathSchema),
    sensitiveFieldKeys: z.array(Key).default([]),
    consents: z.partialRecord(z.enum(FORM_CONSENT_PURPOSES), JsonPathSchema).optional(),
  })
  .strict() as z.ZodType<ImportMappingT>;

// ---------------------------------------------------------------------------
// Size limit (F7)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Canonical hash (`form_versions.definition_hash`)
// ---------------------------------------------------------------------------

/** JSON with object keys sorted at every level (arrays keep their order, `undefined` is dropped). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v: unknown) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** sha256 hex of the canonical JSON of `{ definition, scoring }`. */
export function canonicalHash(def: FormDefinitionT, scoring: FormScoringT): string {
  return sha256Hex(canonicalJson({ definition: def, scoring }));
}

/** UTF-8 byte length of the JSON of definition plus scoring. */
export function definitionBytes(def: unknown, scoring: unknown): number {
  return new TextEncoder().encode(JSON.stringify({ definition: def, scoring })).length;
}

/** F7: true when definition plus scoring fit in 256 KB. */
export function withinSizeLimit(def: unknown, scoring: unknown): boolean {
  return definitionBytes(def, scoring) <= FORM_LIMITS.bytes;
}
