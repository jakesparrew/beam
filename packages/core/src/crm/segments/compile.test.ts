import { describe, expect, it } from "vitest";
import { SENSITIVE_FIELD_KEYS } from "../../privacy/sensitive-keys";
import { compileSegment, fragmentToText, segmentAudienceFragment, SegmentRuleError, validateSegmentRule } from "./compile";
import { COMPARATORS_BY_TYPE, SEGMENT_ALLOWED_EVENT_KINDS, SEGMENT_ALLOWED_FIELDS, SEGMENT_EVENT_DATA_KEYS, SEGMENT_FIELDS, type SegmentFieldType } from "./fields";
import { hasSegmentCycle, referencedSegmentIds, type SegmentRule } from "./schema";

const now = new Date("2026-11-03T10:00:00Z");
const text = (rule: unknown) => fragmentToText(compileSegment(rule, { now }));
const field = (f: string, cmp: string, value?: unknown): SegmentRule => ({ type: "field", field: f, cmp, ...(value === undefined ? {} : { value }) }) as SegmentRule;
const and = (...rules: SegmentRule[]): SegmentRule => ({ op: "and", rules });

/** A valid value per comparator, with the field used to test it. */
const SAMPLE: Record<SegmentFieldType, { field: string; values: Record<string, unknown> }> = {
  enum: { field: "status", values: { eq: "lead", neq: "member", in: ["lead", "customer"], not_in: ["member"], is_null: undefined, is_not_null: undefined } },
  text: { field: "city", values: { eq: "Gent", neq: "Brugge", in: ["Gent", "Brugge"], not_in: ["Antwerpen"], is_null: undefined, is_not_null: undefined } },
  number: { field: "visits", values: { eq: 3, neq: 0, gt: 1, gte: 2, lt: 10, lte: 9, between: [2, 5], is_null: undefined } },
  timestamp: {
    field: "last_visit_at",
    values: { before: "2026-01-01T00:00:00Z", after: "2025-01-01T00:00:00Z", within_last_days: 30, more_than_days_ago: 90, within_next_days: 7, is_null: undefined, is_not_null: undefined },
  },
  "text[]": { field: "tags", values: { contains_any: ["vip"], contains_all: ["vip", "interest:sleep"], contains_none: ["vip"] } },
  boolean: { field: "is_member", values: { is_true: undefined, is_false: undefined } },
};

describe("segment compiler (rules 3.38, 3.39)", () => {
  it("3.38 compiles every comparator of every field type with bound values", () => {
    for (const [type, comparators] of Object.entries(COMPARATORS_BY_TYPE) as [SegmentFieldType, readonly string[]][]) {
      const sample = SAMPLE[type];
      for (const cmp of comparators) {
        expect(cmp in sample.values, `${type}.${cmp} has a sample`).toBe(true);
        const value = sample.values[cmp];
        const out = text(field(sample.field, cmp, value));
        expect(out.text, `${type}.${cmp}`).toContain(`v.${sample.field}`);
        if (value !== undefined) {
          expect(out.params.length, `${type}.${cmp} binds its value`).toBeGreaterThan(0);
          for (const v of [value].flat()) if (typeof v === "string") expect(out.text).not.toContain(v);
        } else expect(out.params).toEqual([]);
      }
    }
  });

  it("3.38 maps comparators to the expected SQL", () => {
    expect(text(field("status", "eq", "lead"))).toEqual({ text: "v.status::text = $1::text", params: ["lead"] });
    expect(text(field("city", "in", ["Gent", "Brugge"]))).toEqual({ text: "v.city::text = any($1::text[])", params: [["Gent", "Brugge"]] });
    expect(text(field("visits", "between", [2, 5]))).toEqual({ text: "v.visits between $1::numeric and $2::numeric", params: [2, 5] });
    expect(text(field("last_visit_at", "within_last_days", 30))).toEqual({
      text: "v.last_visit_at >= $1::timestamptz and v.last_visit_at <= $2::timestamptz",
      params: ["2026-10-04T10:00:00.000Z", "2026-11-03T10:00:00.000Z"],
    });
    expect(text(field("tags", "contains_all", ["vip"])).text).toBe("coalesce(v.tags::text[], '{}'::text[]) @> $1::text[]");
    expect(text(field("is_member", "is_false")).text).toBe("v.is_member is not true");
  });

  it("3.38 an unknown field is rejected with its rule path", () => {
    const r = validateSegmentRule(and(field("status", "eq", "lead"), field("email", "eq", "a@example.com")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues["rules[1]"]).toMatch(/unknown field email/);
    expect(() => compileSegment(field("health_note", "eq", "x"), { now })).toThrow(SegmentRuleError);
  });

  it("3.38 a comparator not allowed for the field type, or a bad value, is rejected", () => {
    expect(validateSegmentRule(field("visits", "contains_any", ["a"])).ok).toBe(false);
    expect(validateSegmentRule(field("status", "eq", "prospect")).ok).toBe(false);
    expect(validateSegmentRule(field("visits", "gt", "3")).ok).toBe(false);
    expect(validateSegmentRule(field("visits", "between", [5, 2])).ok).toBe(false);
    expect(validateSegmentRule(field("last_visit_at", "within_last_days", 0)).ok).toBe(false);
    expect(validateSegmentRule(field("is_member", "is_true", true)).ok).toBe(false);
    expect(validateSegmentRule({ type: "field", field: "status", cmp: "like", value: "%" }).ok).toBe(false);
  });

  it("3.38 at most 50 rules: 50 pass, 51 are rejected", () => {
    const rules = (k: number) => Array.from({ length: k }, () => field("visits", "gt", 1));
    expect(validateSegmentRule(and(...rules(50))).ok).toBe(true);
    expect(validateSegmentRule(and(...rules(51))).ok).toBe(false);
    expect(validateSegmentRule(and(and(...rules(26)), and(...rules(25)))).ok).toBe(false);
  });

  it("3.38 depth 4 passes, depth 5 is rejected", () => {
    const nest = (depth: number): SegmentRule => (depth === 1 ? and(field("visits", "gt", 1)) : and(nest(depth - 1)));
    expect(validateSegmentRule(nest(4)).ok).toBe(true);
    const deep = validateSegmentRule(nest(5));
    expect(deep.ok).toBe(false);
    if (!deep.ok) expect(Object.keys(deep.issues)[0]).toBe("rules[0].rules[0].rules[0].rules[0]");
  });

  it("3.38 values are always bound parameters, never inlined", () => {
    const evil = "x'; drop table persons; --";
    const out = text(and(field("city", "eq", evil), { type: "tag", tagKey: "vip", has: true }, { type: "event", kind: "form.completed", where: { form_slug: evil } }));
    expect(out.text).not.toContain("drop table");
    expect(out.params).toContain(evil);
    expect(out.params).toContain("vip");
  });

  it("compiles groups, not, tag, consent and in_segment rules", () => {
    const seg = "5f0c9c1e-7b5a-4f61-9d1b-3f0c2a1b4c5d";
    const out = text({
      op: "or",
      rules: [
        { type: "not", rule: { type: "tag", tagKey: "vip", has: true } },
        { type: "consent", purpose: "newsletter", granted: true },
        { type: "in_segment", segmentId: seg, negate: true },
      ],
    });
    expect(out.text).toContain("not coalesce((exists (select 1 from person_tags pt join tags t on t.id = pt.tag_id");
    expect(out.text).toContain(" or ");
    expect(out.text).toContain("from v_consent_current c where c.person_id = v.person_id and c.purpose::text = $2 and c.status = 'granted'");
    expect(out.text).toContain("not exists (select 1 from segment_members sm where sm.segment_id = $3::uuid");
    expect(out.params).toEqual(["vip", "newsletter", seg]);
    expect(text({ op: "and", rules: [] }).text).toBe("true");
    expect(text({ op: "or", rules: [] }).text).toBe("false");
  });

  it("compiles event rules over activity_events with mode, data keys, window and count", () => {
    const out = text({ type: "event", kind: "webinar.attended", mode: "replay", where: { cta_key: "book", watched_sec: { gte: 600 } }, withinDays: 30, minCount: 2 });
    expect(out.text).toBe(
      "(select count(*) from activity_events e where e.person_id in (select id from persons where id = v.person_id or merged_into_person_id = v.person_id) and e.kind = $1 and not e.is_sensitive and e.mode::text = $2 and e.data ->> $3 = $4 and (e.data ->> $5)::numeric >= $6::numeric and e.occurred_at >= $7::timestamptz) >= $8",
    );
    expect(out.params).toEqual(["webinar.attended", "replay", "cta_key", "book", "watched_sec", 600, "2026-10-04T10:00:00.000Z", 2]);
    const poll = text({ type: "event", kind: "webinar.poll_answered", where: { option_keys: "yes" }, negate: true });
    expect(poll.text).toMatch(/^not \(/);
    expect(poll.text).toContain("(e.data -> $2) ? $3");
    expect(poll.text).toMatch(/\) >= \$4\)$/);
  });

  it("refuses event kinds and data keys outside the allow-lists", () => {
    expect(validateSegmentRule({ type: "event", kind: "note.added" }).ok).toBe(false);
    expect(validateSegmentRule({ type: "event", kind: "form.completed", where: { body: "x" } }).ok).toBe(false);
    expect(validateSegmentRule({ type: "event", kind: "form.completed", where: { form_slug: { gte: 1 } } }).ok).toBe(false);
  });

  it("fix-w07-crm-1 allows per form kind only the keys that kind's data carries", () => {
    expect(SEGMENT_EVENT_DATA_KEYS["form.started"]).toEqual(["form_slug", "funnel", "form_kind"]);
    expect(SEGMENT_EVENT_DATA_KEYS["form.completed"]).toEqual(["form_slug", "outcome_key", "funnel", "form_kind"]);
    expect(SEGMENT_EVENT_DATA_KEYS["form.abandoned"]).toEqual(["form_slug"]);
    expect(SEGMENT_EVENT_DATA_KEYS["form.result_viewed"]).toEqual(["form_slug", "outcome_key"]);
    expect(SEGMENT_EVENT_DATA_KEYS["assessment.result_generated"]).toEqual(["form_slug", "outcome_key", "funnel", "form_kind"]);
    expect(SEGMENT_EVENT_DATA_KEYS["assessment.cta_clicked"]).toEqual(["form_slug", "outcome_key", "cta_key"]);
    expect(validateSegmentRule({ type: "event", kind: "assessment.cta_clicked", where: { cta_key: "book" } }).ok).toBe(true);
    expect(validateSegmentRule({ type: "event", kind: "form.started", where: { outcome_key: "x" } }).ok).toBe(false);
    expect(validateSegmentRule({ type: "event", kind: "form.abandoned", where: { funnel: "x" } }).ok).toBe(false);
  });

  it("wraps a rule in the audience query that excludes erased, merged and restricted persons", () => {
    const out = fragmentToText(segmentAudienceFragment(field("is_member", "is_true"), { now }));
    expect(out.text).toBe(
      "select v.person_id from v_person_profile v join persons p on p.id = v.person_id where p.erased_at is null and p.merged_into_person_id is null and p.processing_restricted_at is null and (v.is_member is true)",
    );
  });

  it("3.27 no sensitive key or column is in the allow-lists", () => {
    const sensitive = new Set<string>([...SENSITIVE_FIELD_KEYS, "value_enc", "data", "body_enc", "emergency_contact", "email", "phone", "phone_e164", "birth_on"]);
    for (const f of SEGMENT_ALLOWED_FIELDS) expect(sensitive.has(f), f).toBe(false);
    for (const k of SEGMENT_ALLOWED_EVENT_KINDS) {
      expect(k.startsWith("note.") || k.startsWith("sensitive."), k).toBe(false);
      for (const key of SEGMENT_EVENT_DATA_KEYS[k]) expect(sensitive.has(key), `${k}.${key}`).toBe(false);
    }
    expect(SEGMENT_FIELDS.every((f) => f.label === `crm.segments.fields.${f.column}`)).toBe(true);
  });

  it("3.39 finds in_segment references and cycles", () => {
    const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const c = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const rule: SegmentRule = and({ type: "in_segment", segmentId: b }, { type: "not", rule: { type: "in_segment", segmentId: c } });
    expect(referencedSegmentIds(rule)).toEqual([b, c]);
    expect(hasSegmentCycle(a, [b], { [b]: [c], [c]: [] })).toBe(false);
    expect(hasSegmentCycle(a, [b], { [b]: [c], [c]: [a] })).toBe(true);
    expect(hasSegmentCycle(a, [a], {})).toBe(true);
  });
});
