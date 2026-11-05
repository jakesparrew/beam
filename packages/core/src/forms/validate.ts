/**
 * Publish-time validation (forms spec rules P1 to P6 and P8, with F7, L3, L4, L6, S1, S5).
 * `validateForPublish` returns every blocking `error` and non-blocking `warning`; publishing
 * fails while any error exists. The server adds the P7 checks (CTA targets active, tags exist,
 * slug free, DPIA approved) with the same `PublishIssue` shape.
 */
import type { z } from "zod";
import { missingLocales, type LocalizedText } from "../i18n/localized-text";
import type { Locale } from "../i18n/locales";
import { FormDefinition as FormDefinitionSchema, FormScoring as FormScoringSchema, canonicalHash, definitionBytes, FORM_LIMITS } from "./definition";
import { expressionRefs, parseExpression } from "./expression";
import { conditionRefs, deriveConsentPurposes, deriveSensitiveKeys } from "./logic";
import { dimensionFields, dimensionOrder, sensitiveDimensions } from "./scoring";
import {
  MARKETING_CONSENT_PURPOSES,
  OPTIONAL_CONSENT_PURPOSES,
  FORM_CONSENT_PURPOSES,
  type Condition,
  type Cta,
  type Dimension,
  type FormDefinition,
  type FormKind,
  type FormScoring,
  type PublishIssue,
  type PublishIssueCode,
  type Range,
} from "./types";

type Ctx = "field" | "section" | "logic" | "outcome";

const MESSAGES: Record<PublishIssueCode, string> = {
  incomplete_text: "A text is not translated in every locale of the form",
  invalid_shape: "The definition does not have the expected shape",
  no_section: "The form has no section",
  duplicate_key: "A key is used twice",
  invalid_key: "A key has an invalid format",
  field_not_in_section: "A field is not placed in any section",
  field_in_two_sections: "A field is placed in more than one section",
  unknown_field: "A referenced field does not exist",
  unknown_section: "A referenced section does not exist",
  unknown_dimension: "A referenced dimension does not exist",
  unknown_range: "A referenced range does not exist",
  unknown_ending: "A referenced ending does not exist",
  unknown_outcome: "A referenced outcome does not exist",
  hidden_field_not_first: "Hidden and UTM fields belong to the first section",
  goto_not_forward: "A logic rule may only jump to a later section",
  condition_forward_reference: "A condition may only use answers given earlier in the form",
  condition_too_deep: "A condition is nested more than 6 levels",
  condition_too_many_leaves: "A condition has more than 50 parts",
  sensitive_in_logic: "Logic rules and outcomes may not use sensitive answers or sensitive scores",
  formula_invalid: "A formula cannot be read",
  dimension_cycle: "Dimension formulas depend on each other in a circle",
  no_ending: "The form needs at least one ending",
  default_outcome_missing: "A form with outcomes needs a default outcome",
  range_overlap: "Two ranges of one score overlap",
  range_invalid: "A range ends before it starts",
  cta_target_missing: "A result button has no target",
  redirect_url_missing: "A redirect ending needs an https URL",
  invalid_option: "An option or value is not valid",
  limit_exceeded: "The form is larger than allowed",
  acknowledgement_not_required: "An acknowledgement is always required",
  email_field_missing: "The form needs a required email field linked to the person's email",
  result_email_missing: "Every result ending needs an email subject and intro when the result email is on",
  sensitive_consent_missing: "A form with sensitive questions needs a required consent for sensitive processing",
  sensitive_consent_late: "The sensitive-processing consent must come before or with the first sensitive question",
  consent_purpose_invalid: "This consent purpose cannot be asked in a form",
  consent_must_be_optional: "Marketing and AI consents must be optional (freely given)",
  dpia_not_approved: "The DPIA for sensitive assessment processing is not approved yet",
  unreachable_section: "This section can never be shown",
  unreachable_ending: "This ending can never be reached",
  outcome_unselectable: "This outcome can never be selected with the score ranges",
  long_text_not_sensitive: "A long-text answer of an assessment is not marked sensitive",
  result_without_cta: "This result ending has no button",
};

const ZOD_CODES: Partial<Record<string, PublishIssueCode>> = {
  invalid_key: "invalid_key",
  limit_exceeded: "limit_exceeded",
  acknowledgement_not_required: "acknowledgement_not_required",
  condition_too_deep: "condition_too_deep",
  condition_too_many_leaves: "condition_too_many_leaves",
  duplicate_key: "duplicate_key",
};

function schemaIssues(prefix: string, error: z.ZodError): PublishIssue[] {
  return error.issues.map((i) => {
    const code: PublishIssueCode = ZOD_CODES[i.message] ?? (i.code === "too_big" ? "limit_exceeded" : "invalid_shape");
    const path = [prefix, ...i.path.map(String)].filter(Boolean).join(".");
    return { level: "error", code, path, message: `${MESSAGES[code]} (${i.message})` };
  });
}

/** Rule P1: every issue of a draft, errors first in traversal order within each group. */
export function validateForPublish(kind: FormKind, def: FormDefinition, scoring: FormScoring, locales: Locale[]): PublishIssue[] {
  const d = FormDefinitionSchema.safeParse(def);
  const s = FormScoringSchema.safeParse(scoring ?? {});
  const early: PublishIssue[] = [];
  if (!d.success) early.push(...schemaIssues("", d.error));
  if (!s.success) early.push(...schemaIssues("scoring", s.error));
  if (definitionBytes(def, scoring) > FORM_LIMITS.bytes) early.push({ level: "error", code: "limit_exceeded", path: "", message: `${MESSAGES.limit_exceeded} (256 KB)` });
  if (!d.success || !s.success) return early;
  return [...early, ...new Checker(kind, d.data, s.data, locales).run()];
}

/**
 * The derived `form_versions` columns, recomputed on every save (never edited directly):
 * `sensitive_field_keys` (L6), `consent_purposes` and `definition_hash`.
 */
export function deriveVersionColumns(def: FormDefinition, scoring: FormScoring): { sensitiveFieldKeys: string[]; consentPurposes: string[]; definitionHash: string } {
  return { sensitiveFieldKeys: deriveSensitiveKeys(def, scoring), consentPurposes: deriveConsentPurposes(def), definitionHash: canonicalHash(def, scoring) };
}

/** True when no issue is an error. */
export function isPublishable(issues: readonly PublishIssue[]): boolean {
  return !issues.some((i) => i.level === "error");
}

class Checker {
  private readonly out: PublishIssue[] = [];
  private readonly pos = new Map<string, { s: number; i: number }>();
  private readonly sensitiveFields: Set<string>;
  private readonly sensitiveDims: { dimensions: Set<string>; total: boolean };

  constructor(
    private readonly kind: FormKind,
    private readonly def: FormDefinition,
    private readonly scoring: FormScoring,
    private readonly locales: Locale[],
  ) {
    def.sections.forEach((sec, s) => sec.fieldKeys.forEach((k, i) => (this.pos.has(k) ? undefined : this.pos.set(k, { s, i }))));
    this.sensitiveFields = new Set(deriveSensitiveKeys(def, scoring));
    this.sensitiveDims = sensitiveDimensions(def, scoring, this.sensitiveFields);
  }

  private add(level: PublishIssue["level"], code: PublishIssueCode, path: string, extra = "", more: Partial<PublishIssue> = {}): void {
    this.out.push({ level, code, path, message: extra ? `${MESSAGES[code]}: ${extra}` : MESSAGES[code], ...more });
  }
  private err(code: PublishIssueCode, path: string, extra = ""): void {
    this.add("error", code, path, extra);
  }
  private warn(code: PublishIssueCode, path: string, extra = ""): void {
    this.add("warning", code, path, extra);
  }

  run(): PublishIssue[] {
    this.completeness();
    this.structure();
    this.scoringRules();
    this.identity();
    this.consents();
    this.warnings();
    return [...this.out.filter((i) => i.level === "error"), ...this.out.filter((i) => i.level === "warning")];
  }

  // P2 ---------------------------------------------------------------------

  private text(path: string, t: LocalizedText | undefined, optional = false): void {
    if (t === undefined && optional) return;
    const missing = missingLocales(t, this.locales);
    if (missing.length) this.add("error", "incomplete_text", path, missing.map((l) => `${l} missing`).join(", "), { message: `${path}: ${missing.map((l) => `${l} missing`).join(", ")}`, locales: missing });
  }

  private completeness(): void {
    const { def, scoring } = this;
    this.text("title", def.title);
    this.text("intro", def.intro, true);
    this.text("settings.submitLabel", def.settings.submitLabel);
    for (const sec of def.sections) {
      this.text(`sections.${sec.key}.title`, sec.title, true);
      this.text(`sections.${sec.key}.description`, sec.description, true);
    }
    for (const f of Object.values(def.fields)) {
      const p = `fields.${f.key}`;
      if (f.type !== "hidden" && f.type !== "utm") this.text(`${p}.label`, f.label);
      this.text(`${p}.help`, f.help, true);
      this.text(`${p}.placeholder`, f.placeholder, true);
      if ("options" in f) for (const o of f.options) this.text(`${p}.options.${o.key}.label`, o.label);
      if (f.type === "consent") this.text(`${p}.wording`, f.wording);
      if (f.type === "acknowledgement") this.text(`${p}.text`, f.text);
    }
    for (const e of def.endings) {
      const p = `endings.${e.key}`;
      this.text(`${p}.title`, e.title);
      if (e.kind !== "redirect") this.text(`${p}.body`, e.body);
      for (const c of e.ctas) this.text(`${p}.ctas.${c.key}.label`, c.label);
      if (e.email) {
        this.text(`${p}.email.subject`, e.email.subject);
        this.text(`${p}.email.intro`, e.email.intro);
      }
    }
    const ranges = (p: string, rs: readonly Range[]): void => {
      for (const r of rs) {
        this.text(`${p}.ranges.${r.key}.label`, r.label);
        this.text(`${p}.ranges.${r.key}.explanation`, r.explanation, true);
        this.text(`${p}.ranges.${r.key}.recommendation`, r.recommendation, true);
      }
    };
    for (const dim of scoring.dimensions) {
      this.text(`scoring.dimensions.${dim.key}.label`, dim.label);
      ranges(`scoring.dimensions.${dim.key}`, dim.ranges);
    }
    if (scoring.total) ranges("scoring.total", scoring.total.ranges);
    for (const o of scoring.outcomes) {
      const p = `scoring.outcomes.${o.key}`;
      this.text(`${p}.label`, o.label);
      this.text(`${p}.explanation`, o.explanation, true);
      this.text(`${p}.recommendation`, o.recommendation, true);
    }
  }

  // P3 ---------------------------------------------------------------------

  private unique(path: string, keys: readonly string[]): void {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) this.err("duplicate_key", `${path}.${k}`, k);
      seen.add(k);
    }
  }

  private structure(): void {
    const { def } = this;
    if (def.sections.length === 0) this.err("no_section", "sections");
    this.unique("sections", def.sections.map((x) => x.key));
    this.unique("endings", def.endings.map((x) => x.key));
    this.unique("logic", def.logic.map((x) => x.key));
    const placed = new Map<string, number>();
    def.sections.forEach((sec, si) => {
      for (const k of sec.fieldKeys) {
        if (!Object.hasOwn(def.fields, k)) this.err("unknown_field", `sections.${sec.key}.fieldKeys`, k);
        placed.set(k, (placed.get(k) ?? 0) + 1);
      }
      if (sec.visibleIf) this.condition(sec.visibleIf, `sections.${sec.key}.visibleIf`, "section", si);
    });
    for (const f of Object.values(def.fields)) {
      const n = placed.get(f.key) ?? 0;
      if (n === 0) this.err("field_not_in_section", `fields.${f.key}`);
      if (n > 1) this.err("field_in_two_sections", `fields.${f.key}`);
      const at = this.pos.get(f.key);
      if ((f.type === "hidden" || f.type === "utm") && at && at.s !== 0) this.err("hidden_field_not_first", `fields.${f.key}`);
      if (f.type === "acknowledgement" && !f.required) this.err("acknowledgement_not_required", `fields.${f.key}.required`);
      if (f.visibleIf && at) this.condition(f.visibleIf, `fields.${f.key}.visibleIf`, "field", at.s, at.i);
    }
    const sectionIndex = new Map(def.sections.map((x, i) => [x.key, i]));
    const endingKeys = new Set(def.endings.map((e) => e.key));
    for (const r of def.logic) {
      const p = `logic.${r.key}`;
      const at = sectionIndex.get(r.afterSection);
      if (at === undefined) {
        this.err("unknown_section", `${p}.afterSection`, r.afterSection);
        continue;
      }
      this.condition(r.if, `${p}.if`, "logic", at);
      if ("goto" in r.then) {
        const to = sectionIndex.get(r.then.goto);
        if (to === undefined) this.err("unknown_section", `${p}.then.goto`, r.then.goto);
        else if (to <= at) this.err("goto_not_forward", `${p}.then.goto`, r.then.goto);
      } else if (!endingKeys.has(r.then.end)) this.err("unknown_ending", `${p}.then.end`, r.then.end);
    }
    if (def.endings.length === 0) this.err("no_ending", "endings");
    const dimKeys = new Set(this.scoring.dimensions.map((x) => x.key));
    for (const e of def.endings) {
      const p = `endings.${e.key}`;
      this.unique(`${p}.ctas`, e.ctas.map((c) => c.key));
      if (e.kind === "redirect" && !e.redirectUrl) this.err("redirect_url_missing", `${p}.redirectUrl`);
      for (const k of e.showDimensions) if (!dimKeys.has(k)) this.err("unknown_dimension", `${p}.showDimensions`, k);
      for (const c of e.ctas) if (!ctaHasTarget(c)) this.err("cta_target_missing", `${p}.ctas.${c.key}`, c.kind);
    }
  }

  /** The fields a score reference (`total` or a dimension) reads. */
  private scoreFields(key: string): string[] {
    const { def, scoring } = this;
    if (key !== "total") {
      const dim = scoring.dimensions.find((x) => x.key === key);
      return dim ? this.dimFieldsDeep(dim, new Set()) : [];
    }
    const t = scoring.total;
    if (!t) return [];
    if (t.kind === "sum_dimensions") return scoring.dimensions.flatMap((x) => this.dimFieldsDeep(x, new Set()));
    const p = t.formula ? parseExpression(t.formula) : null;
    if (!p?.ok) return [];
    const refs = expressionRefs(p.ast);
    return [...refs.answers.filter((k) => Object.hasOwn(def.fields, k)), ...refs.dims.flatMap((k) => this.scoreFields(k))];
  }

  private dimFieldsDeep(d: Dimension, seen: Set<string>): string[] {
    if (seen.has(d.key)) return [];
    seen.add(d.key);
    const own = dimensionFields(this.def, d);
    if (d.kind !== "formula" || !d.formula) return own;
    const p = parseExpression(d.formula);
    const deps = p.ok ? expressionRefs(p.ast).dims : [];
    return [...own, ...deps.flatMap((k) => {
      const dd = this.scoring.dimensions.find((x) => x.key === k);
      return dd ? this.dimFieldsDeep(dd, seen) : [];
    })];
  }

  /** L4, L6 and reference checks of one condition. */
  private condition(c: Condition, path: string, ctx: Ctx, s: number, i = Infinity): void {
    const refs = conditionRefs(c);
    const before = (k: string, strictSection: boolean): boolean => {
      const at = this.pos.get(k);
      if (!at) return true; // reported as field_not_in_section
      if (ctx === "outcome") return true;
      if (ctx === "logic") return at.s <= s;
      if (ctx === "section" || strictSection) return at.s < s;
      return at.s < s || (at.s === s && at.i < i);
    };
    for (const k of refs.fields) {
      if (!Object.hasOwn(this.def.fields, k)) this.err("unknown_field", path, k);
      else if (!before(k, false)) this.err("condition_forward_reference", path, k);
    }
    const dimKeys = new Set(this.scoring.dimensions.map((x) => x.key));
    for (const k of refs.dimensions) {
      if (k === "total" ? !this.scoring.total : !dimKeys.has(k)) {
        this.err("unknown_dimension", path, k);
        continue;
      }
      if (this.scoreFields(k).some((f) => !before(f, true))) this.err("condition_forward_reference", path, k);
    }
    for (const r of rangeLeaves(c)) {
      const list = r.dimension === "total" ? this.scoring.total?.ranges : this.scoring.dimensions.find((x) => x.key === r.dimension)?.ranges;
      if (list && !list.some((x) => x.key === r.key)) this.err("unknown_range", path, `${r.dimension}.${r.key}`);
    }
    if (ctx === "logic" || ctx === "outcome") {
      const sensitive =
        refs.fields.some((k) => this.sensitiveFields.has(k)) ||
        refs.dimensions.some((k) => (k === "total" ? this.sensitiveDims.total : this.sensitiveDims.dimensions.has(k)));
      if (sensitive) this.err("sensitive_in_logic", path);
    }
  }

  private scoringRules(): void {
    const { def, scoring } = this;
    this.unique("scoring.dimensions", scoring.dimensions.map((x) => x.key));
    this.unique("scoring.outcomes", scoring.outcomes.map((x) => x.key));
    const dimKeys = new Set(scoring.dimensions.map((x) => x.key));
    const formula = (path: string, src: string | undefined, allowTotal: boolean): void => {
      if (!src) {
        this.err("formula_invalid", path, "missing formula");
        return;
      }
      const p = parseExpression(src);
      if (!p.ok) {
        this.err("formula_invalid", path, `${p.error.message} at ${p.error.pos}`);
        return;
      }
      const refs = expressionRefs(p.ast);
      for (const k of refs.dims) if (!dimKeys.has(k)) this.err("unknown_dimension", path, k);
      for (const k of refs.answers) if (!Object.hasOwn(def.fields, k)) this.err("unknown_field", path, k);
      if (refs.total && !allowTotal) this.err("formula_invalid", path, "total cannot be used here");
    };
    for (const dim of scoring.dimensions) {
      const p = `scoring.dimensions.${dim.key}`;
      if (dim.kind === "formula") formula(`${p}.formula`, dim.formula, false);
      this.ranges(p, dim.ranges);
    }
    const { cyclic } = dimensionOrder(scoring);
    for (const k of cyclic) this.err("dimension_cycle", `scoring.dimensions.${k}.formula`, k);
    if (scoring.total) {
      if (scoring.total.kind === "formula") formula("scoring.total.formula", scoring.total.formula, false);
      this.ranges("scoring.total", scoring.total.ranges);
    }
    const endingKeys = new Set(def.endings.map((e) => e.key));
    for (const o of scoring.outcomes) {
      const p = `scoring.outcomes.${o.key}`;
      if (!endingKeys.has(o.endingKey)) this.err("unknown_ending", `${p}.endingKey`, o.endingKey);
      this.condition(o.when, `${p}.when`, "outcome", Infinity);
    }
    if (scoring.outcomes.length > 0 && !scoring.defaultOutcomeKey) this.err("default_outcome_missing", "scoring.defaultOutcomeKey");
    if (scoring.defaultOutcomeKey && !scoring.outcomes.some((o) => o.key === scoring.defaultOutcomeKey)) this.err("unknown_outcome", "scoring.defaultOutcomeKey", scoring.defaultOutcomeKey);
  }

  private ranges(path: string, rs: readonly Range[]): void {
    this.unique(`${path}.ranges`, rs.map((r) => r.key));
    for (const r of rs) if (!(r.from < r.to)) this.err("range_invalid", `${path}.ranges.${r.key}`);
    const sorted = [...rs].filter((r) => r.from < r.to).sort((a, b) => a.from - b.from);
    for (let j = 1; j < sorted.length; j++) if (sorted[j]!.from < sorted[j - 1]!.to) this.err("range_overlap", `${path}.ranges.${sorted[j]!.key}`, `${sorted[j - 1]!.key} and ${sorted[j]!.key}`);
  }

  // P4 ---------------------------------------------------------------------

  private identity(): void {
    const { def } = this;
    const hasEmail = Object.values(def.fields).some((f) => f.type === "email" && f.required && f.mapsTo === "person.email" && !f.visibleIf);
    const needsEmail = this.kind !== "survey" || this.sensitiveFields.size > 0 || def.settings.sendResultEmail;
    if (needsEmail && !hasEmail) this.err("email_field_missing", "fields", this.kind === "survey" && this.sensitiveFields.size > 0 ? "a survey with sensitive questions" : this.kind);
    if (def.settings.sendResultEmail) for (const e of def.endings) if (e.kind === "result" && !e.email) this.err("result_email_missing", `endings.${e.key}.email`);
  }

  // P5, P6 -----------------------------------------------------------------

  private consents(): void {
    const { def } = this;
    const fields = Object.values(def.fields);
    if (this.sensitiveFields.size > 0) {
      const consent = fields.find((f) => f.type === "consent" && f.purpose === "sensitive_processing" && f.required && !f.visibleIf);
      if (!consent) this.err("sensitive_consent_missing", "fields");
      else {
        const first = Math.min(...[...this.sensitiveFields].map((k) => this.pos.get(k)?.s ?? Infinity));
        const at = this.pos.get(consent.key)?.s ?? Infinity;
        if (at > first) this.err("sensitive_consent_late", `fields.${consent.key}`);
      }
    }
    const consentFields = fields.filter((f) => f.type === "consent");
    const pureSignUp =
      consentFields.length === 1 &&
      (MARKETING_CONSENT_PURPOSES as readonly string[]).includes(consentFields[0]!.purpose) &&
      fields.every((f) => f.type === "consent" || f.type === "email" || f.type === "hidden" || f.type === "utm" || (f.type === "short_text" && (f.mapsTo === "person.first_name" || f.mapsTo === "person.last_name")));
    for (const f of consentFields) {
      if (!(FORM_CONSENT_PURPOSES as readonly string[]).includes(f.purpose)) this.err("consent_purpose_invalid", `fields.${f.key}.purpose`, f.purpose);
      else if (f.required && (OPTIONAL_CONSENT_PURPOSES as readonly string[]).includes(f.purpose) && !(pureSignUp && f.purpose !== "ai_processing")) this.err("consent_must_be_optional", `fields.${f.key}.required`, f.purpose);
    }
  }

  // P8 ---------------------------------------------------------------------

  private warnings(): void {
    const { def, scoring } = this;
    for (const sec of def.sections) if (sec.visibleIf && !this.satisfiable(sec.visibleIf)) this.warn("unreachable_section", `sections.${sec.key}`);
    const reachableEndings = new Set<string>();
    for (const r of def.logic) if ("end" in r.then && this.satisfiable(r.if)) reachableEndings.add(r.then.end);
    const selectable = scoring.outcomes.filter((o) => this.satisfiable(o.when) || o.key === scoring.defaultOutcomeKey);
    for (const o of scoring.outcomes) if (!this.satisfiable(o.when) && o.key !== scoring.defaultOutcomeKey) this.warn("outcome_unselectable", `scoring.outcomes.${o.key}`);
    for (const o of selectable) reachableEndings.add(o.endingKey);
    const hasDefault = scoring.outcomes.length > 0 && scoring.outcomes.some((o) => o.key === scoring.defaultOutcomeKey);
    if (!hasDefault && def.endings[0]) reachableEndings.add(def.endings[0].key);
    for (const e of def.endings) if (!reachableEndings.has(e.key)) this.warn("unreachable_ending", `endings.${e.key}`);
    if (this.kind === "assessment") for (const f of Object.values(def.fields)) if (f.type === "long_text" && !f.sensitive) this.warn("long_text_not_sensitive", `fields.${f.key}.sensitive`);
    for (const e of def.endings) if (e.kind === "result" && e.ctas.length === 0) this.warn("result_without_cta", `endings.${e.key}.ctas`);
  }

  /** The possible values of a score, from its ranges and bounds; `null` when unbounded. */
  private bounds(key: string): [number, number] | null {
    const ranges = key === "total" ? this.scoring.total?.ranges : this.scoring.dimensions.find((x) => x.key === key)?.ranges;
    const dim = this.scoring.dimensions.find((x) => x.key === key);
    let lo = -Infinity;
    let hi = Infinity;
    if (ranges?.length) {
      lo = Math.min(...ranges.map((r) => r.from));
      hi = Math.max(...ranges.map((r) => r.to));
    }
    if (dim?.min !== undefined) lo = Math.max(lo, dim.min);
    if (dim?.max !== undefined) hi = Math.min(hi, dim.max);
    return lo === -Infinity && hi === Infinity ? null : [lo, hi];
  }

  /** Conservative: `false` only when a condition can never hold (unknown options, scores outside every range). */
  private satisfiable(c: Condition): boolean {
    if ("all" in c) return c.all.every((x) => this.satisfiable(x));
    if ("any" in c) return c.any.some((x) => this.satisfiable(x));
    if ("not" in c) return true;
    if ("range" in c) {
      const list = c.range.dimension === "total" ? this.scoring.total?.ranges : this.scoring.dimensions.find((x) => x.key === c.range.dimension)?.ranges;
      return !!list?.some((r) => r.key === c.range.key);
    }
    if ("score" in c) {
      const b = this.bounds(c.score);
      if (!b) return true;
      const [lo, hi] = b;
      const v = c.value;
      switch (c.op) {
        case "eq":
          return v >= lo && v <= hi;
        case "gt":
          return hi > v;
        case "gte":
          return hi >= v;
        case "lt":
          return lo < v;
        case "lte":
          return lo <= v;
        default:
          return true;
      }
    }
    const f = this.def.fields[c.field];
    if (!f || !("options" in f) || !["eq", "in", "contains"].includes(c.op)) return true;
    const values = Array.isArray(c.value) ? c.value : [c.value];
    return values.some((v) => f.options.some((o) => o.key === String(v)));
  }
}

function rangeLeaves(c: Condition): { dimension: string; key: string }[] {
  if ("all" in c) return c.all.flatMap(rangeLeaves);
  if ("any" in c) return c.any.flatMap(rangeLeaves);
  if ("not" in c) return rangeLeaves(c.not);
  return "range" in c ? [c.range] : [];
}

/**
 * F5: each CTA kind needs its target id or URL. A `webinar` CTA (R2) needs its `webinarId`; that
 * the webinar exists and is linkable is the server's P7 check (`cta-targets.ts`).
 */
export function ctaHasTarget(c: Cta): boolean {
  switch (c.kind) {
    case "booking":
    case "experience":
      return !!c.sessionTemplateId;
    case "event":
      return !!c.sessionId;
    case "product":
      return !!c.productId;
    case "webinar":
      return !!c.webinarId;
    case "url":
      return !!c.url;
  }
}
