/**
 * The segment compiler (crm spec 4.6, rules 3.38 and 3.39). `compileSegment` turns a validated
 * `SegmentRule` into a `SqlFragment`: SQL text pieces and `{ param }` values, never a value
 * inlined into the text. `apps/web/modules/crm/segments/sql.ts` joins it into a Drizzle `SQL`
 * with `sql.join`, so core never imports Drizzle. Column names come only from the allow-list.
 *
 * The fragment is a boolean expression over `v` (a `v_person_profile` row); wrap it with
 * `segmentAudienceFragment` for the full `select v.person_id …` query.
 */
import { CONSENT_PURPOSES } from "../types";
import {
  COMPARATORS_BY_TYPE,
  SEGMENT_ARRAY_EVENT_KEYS,
  SEGMENT_EVENT_DATA_KEYS,
  SEGMENT_FIELD_BY_COLUMN,
  SEGMENT_NUMERIC_EVENT_KEYS,
  type AllowedEventKind,
  type SegmentField,
} from "./fields";
import { SEGMENT_MAX_DEPTH, SEGMENT_MAX_RULES, SegmentRuleSchema, type EventWhereValue, type SegmentRule } from "./schema";

export type SqlFragment = Array<string | { param: unknown }>;

/** A rule the compiler refuses; `code` maps to the action error `validation`, `fields` by rule path. */
export class SegmentRuleError extends Error {
  override readonly name = "SegmentRuleError";
  readonly code = "validation" as const;
  constructor(readonly fields: Record<string, string>) {
    super(`invalid_segment_rule: ${Object.entries(fields).map(([p, m]) => `${p}: ${m}`).join("; ")}`);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TAG_KEY_RE = /^[a-z0-9][a-z0-9_:-]{1,62}$/;
const MAX_LIST = 500;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isDays = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3650;
const isStrList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.length <= MAX_LIST && v.every((x) => typeof x === "string" && x.length <= 200);
const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

function checkFieldValue(field: SegmentField, cmp: string, value: unknown): string | null {
  const opts = field.options;
  const inOptions = (v: string) => !opts || opts.includes(v);
  switch (cmp) {
    case "is_null":
    case "is_not_null":
    case "is_true":
    case "is_false":
      return value === undefined ? null : "no value expected";
    case "eq":
    case "neq":
      if (field.type === "number") return isNum(value) ? null : "a number is expected";
      return typeof value === "string" && value.length <= 200 && inOptions(value) ? null : "an allowed text value is expected";
    case "in":
    case "not_in":
      return isStrList(value) && value.every(inOptions) ? null : "a list of allowed values is expected";
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return isNum(value) ? null : "a number is expected";
    case "between":
      return Array.isArray(value) && value.length === 2 && isNum(value[0]) && isNum(value[1]) && value[0] <= value[1] ? null : "two ascending numbers are expected";
    case "before":
    case "after":
      return isIso(value) ? null : "a date is expected";
    case "within_last_days":
    case "more_than_days_ago":
    case "within_next_days":
      return isDays(value) ? null : "a number of days (1 to 3650) is expected";
    case "contains_any":
    case "contains_all":
    case "contains_none":
      return isStrList(value) ? null : "a list of values is expected";
    default:
      return "unknown comparator";
  }
}

function checkWhere(kind: AllowedEventKind, where: Partial<Record<string, EventWhereValue>>, path: string, issues: Record<string, string>) {
  const allowed: readonly string[] = SEGMENT_EVENT_DATA_KEYS[kind];
  for (const [key, value] of Object.entries(where)) {
    const at = `${path}.where.${key}`;
    if (!allowed.includes(key)) issues[at] = `data key not allowed for ${kind}`;
    else if (typeof value === "object" && value !== null) {
      if (!SEGMENT_NUMERIC_EVENT_KEYS.includes(key)) issues[at] = "a range is only allowed on a numeric key";
      else if (value.gte === undefined && value.lte === undefined) issues[at] = "a range needs gte or lte";
    } else if (typeof value === "number" && !SEGMENT_NUMERIC_EVENT_KEYS.includes(key)) issues[at] = "a number is only allowed on a numeric key";
  }
}

/**
 * Checks a rule against the allow-lists and limits. Returns the parsed rule, or the problems
 * keyed by rule path (`rules[2].rules[0]`).
 */
export function validateSegmentRule(input: unknown): { ok: true; rule: SegmentRule } | { ok: false; issues: Record<string, string> } {
  const parsed = SegmentRuleSchema.safeParse(input);
  if (!parsed.success) {
    const issues: Record<string, string> = {};
    for (const i of parsed.error.issues) issues[i.path.length ? i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "") : "rule"] ??= i.message;
    return { ok: false, issues };
  }
  const rule = parsed.data;
  const issues: Record<string, string> = {};
  let leaves = 0;

  const walk = (r: SegmentRule, path: string, depth: number) => {
    if ("op" in r || r.type === "not") {
      if (depth > SEGMENT_MAX_DEPTH) {
        issues[path || "rule"] = `nesting deeper than ${SEGMENT_MAX_DEPTH}`;
        return;
      }
      if ("op" in r) r.rules.forEach((child, i) => walk(child, `${path}${path ? "." : ""}rules[${i}]`, depth + 1));
      else walk(r.rule, `${path}${path ? "." : ""}rule`, depth + 1);
      return;
    }
    leaves += 1;
    const at = path || "rule";
    switch (r.type) {
      case "field": {
        const field = SEGMENT_FIELD_BY_COLUMN[r.field];
        if (!field) issues[at] = `unknown field ${r.field}`;
        else if (!(COMPARATORS_BY_TYPE[field.type] as readonly string[]).includes(r.cmp)) issues[at] = `comparator ${r.cmp} not allowed for ${field.type}`;
        else {
          const problem = checkFieldValue(field, r.cmp, r.value);
          if (problem) issues[at] = problem;
        }
        break;
      }
      case "tag":
        if (!TAG_KEY_RE.test(r.tagKey)) issues[at] = "invalid tag key";
        break;
      case "consent":
        if (!(CONSENT_PURPOSES as readonly string[]).includes(r.purpose)) issues[at] = "unknown purpose";
        break;
      case "in_segment":
        break;
      case "event":
        if (!(r.kind in SEGMENT_EVENT_DATA_KEYS)) issues[at] = `event kind ${r.kind} not allowed`;
        else if (r.where) checkWhere(r.kind, r.where, at, issues);
        break;
    }
  };
  walk(rule, "", 1);
  if (leaves > SEGMENT_MAX_RULES) issues.rule = `more than ${SEGMENT_MAX_RULES} rules`;
  return Object.keys(issues).length ? { ok: false, issues } : { ok: true, rule };
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

const p = (param: unknown) => ({ param });
const iso = (d: Date) => d.toISOString();
const daysFrom = (now: Date, days: number) => new Date(now.getTime() + days * DAY_MS);

function compileField(field: SegmentField, cmp: string, value: unknown, now: Date): SqlFragment {
  const col = `v.${field.column}`;
  const txt = `${col}::text`;
  switch (field.type) {
    case "enum":
    case "text":
      switch (cmp) {
        case "eq":
          return [`${txt} = `, p(value), "::text"];
        case "neq":
          return [`${txt} is distinct from `, p(value), "::text"];
        case "in":
          return [`${txt} = any(`, p(value), "::text[])"];
        case "not_in":
          return [`not (coalesce(${txt} = any(`, p(value), "::text[]), false))"];
        case "is_null":
          return [`${col} is null`];
        default:
          return [`${col} is not null`];
      }
    case "number":
      switch (cmp) {
        case "is_null":
          return [`${col} is null`];
        case "between": {
          const [lo, hi] = value as [number, number];
          return [`${col} between `, p(lo), "::numeric and ", p(hi), "::numeric"];
        }
        default: {
          const op = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[cmp as "eq"];
          return [`${col} ${op} `, p(value), "::numeric"];
        }
      }
    case "timestamp":
      switch (cmp) {
        case "before":
          return [`${col} < `, p(value), "::timestamptz"];
        case "after":
          return [`${col} > `, p(value), "::timestamptz"];
        case "within_last_days":
          return [`${col} >= `, p(iso(daysFrom(now, -(value as number)))), `::timestamptz and ${col} <= `, p(iso(now)), "::timestamptz"];
        case "more_than_days_ago":
          return [`${col} < `, p(iso(daysFrom(now, -(value as number)))), "::timestamptz"];
        case "within_next_days":
          return [`${col} >= `, p(iso(now)), `::timestamptz and ${col} < `, p(iso(daysFrom(now, value as number))), "::timestamptz"];
        case "is_null":
          return [`${col} is null`];
        default:
          return [`${col} is not null`];
      }
    case "text[]": {
      const arr = `coalesce(${col}::text[], '{}'::text[])`;
      if (cmp === "contains_any") return [`${arr} && `, p(value), "::text[]"];
      if (cmp === "contains_all") return [`${arr} @> `, p(value), "::text[]"];
      return [`not (${arr} && `, p(value), "::text[])"];
    }
    case "boolean":
      return cmp === "is_true" ? [`${col} is true`] : [`${col} is not true`];
  }
}

function compileEvent(r: Extract<SegmentRule, { type: "event" }>, now: Date): SqlFragment {
  const out: SqlFragment = [
    "(select count(*) from activity_events e where e.person_id in (select id from persons where id = v.person_id or merged_into_person_id = v.person_id) and e.kind = ",
    p(r.kind),
    " and not e.is_sensitive",
  ];
  if (r.mode) out.push(" and e.mode::text = ", p(r.mode));
  for (const [key, value] of Object.entries(r.where ?? {})) {
    if (value === undefined) continue;
    if (SEGMENT_ARRAY_EVENT_KEYS.includes(key) && typeof value !== "object") out.push(" and (e.data -> ", p(key), ") ? ", p(String(value)));
    else if (typeof value === "object") {
      if (value.gte !== undefined) out.push(" and (e.data ->> ", p(key), ")::numeric >= ", p(value.gte), "::numeric");
      if (value.lte !== undefined) out.push(" and (e.data ->> ", p(key), ")::numeric <= ", p(value.lte), "::numeric");
    } else if (typeof value === "number") out.push(" and (e.data ->> ", p(key), ")::numeric = ", p(value), "::numeric");
    else out.push(" and e.data ->> ", p(key), " = ", p(String(value)));
  }
  if (r.withinDays) out.push(" and e.occurred_at >= ", p(iso(daysFrom(now, -r.withinDays))), "::timestamptz");
  out.push(") >= ", p(r.minCount ?? 1));
  return r.negate ? ["not (", ...out, ")"] : out;
}

function compileRule(r: SegmentRule, now: Date): SqlFragment {
  if ("op" in r) {
    if (r.rules.length === 0) return [r.op === "and" ? "true" : "false"];
    const parts: SqlFragment = ["("];
    r.rules.forEach((child, i) => {
      if (i > 0) parts.push(r.op === "and" ? " and " : " or ");
      parts.push("(", ...compileRule(child, now), ")");
    });
    parts.push(")");
    return parts;
  }
  switch (r.type) {
    case "not":
      return ["not coalesce((", ...compileRule(r.rule, now), "), false)"];
    case "field":
      return compileField(SEGMENT_FIELD_BY_COLUMN[r.field]!, r.cmp, r.value, now);
    case "tag":
      return [
        `${r.has ? "" : "not "}exists (select 1 from person_tags pt join tags t on t.id = pt.tag_id where pt.person_id = v.person_id and t.key = `,
        p(r.tagKey),
        ")",
      ];
    case "consent":
      return [
        `${r.granted ? "" : "not "}exists (select 1 from v_consent_current c where c.person_id = v.person_id and c.purpose::text = `,
        p(r.purpose),
        " and c.status = 'granted')",
      ];
    case "in_segment":
      return [
        `${r.negate ? "not " : ""}exists (select 1 from segment_members sm where sm.segment_id = `,
        p(r.segmentId),
        "::uuid and sm.person_id = v.person_id)",
      ];
    case "event":
      return compileEvent(r, now);
  }
}

/** Validates and compiles a rule into a boolean expression over `v`. Throws `SegmentRuleError`. */
export function compileSegment(rule: unknown, opts: { now: Date }): SqlFragment {
  const checked = validateSegmentRule(rule);
  if (!checked.ok) throw new SegmentRuleError(checked.issues);
  return compileRule(checked.rule, opts.now);
}

/**
 * The full audience query of a rule (crm spec 4.6): every non-erased, non-merged, unrestricted
 * person of `v_person_profile` matching the rule.
 */
export function segmentAudienceFragment(rule: unknown, opts: { now: Date }): SqlFragment {
  return [
    "select v.person_id from v_person_profile v join persons p on p.id = v.person_id where p.erased_at is null and p.merged_into_person_id is null and p.processing_restricted_at is null and (",
    ...compileSegment(rule, opts),
    ")",
  ];
}

/** Text with `$1, $2 …` placeholders and the values, for previews and tests. */
export function fragmentToText(fragment: SqlFragment): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const text = fragment.map((f) => (typeof f === "string" ? f : (params.push(f.param), `$${params.length}`))).join("");
  return { text, params };
}
