import { describe, expect, it } from "vitest";
import {
  canonicalHash,
  canonicalJson,
  ConditionSchema,
  defaultSensitive,
  defaultSettings,
  FieldSchema,
  FORM_LIMITS,
  FormDefinition,
  FormScoring,
  ImportMapping,
  isScored,
  KEY_RE,
  withinSizeLimit,
} from "./definition";
import { recoveryCheckSeed, seedDefinitions, SYSTEM_FORM_SLUGS } from "./seed-definitions";
import type { Condition, Field, FormDefinition as Def } from "./types";
import { validateForPublish } from "./validate";

const T = { "nl-BE": "x", "fr-BE": "x", en: "x" };
const UUID = "00000000-0000-4000-8000-000000000001";

function minimal(over: Partial<Def> = {}): Def {
  return {
    title: T,
    settings: defaultSettings("lead", T),
    sections: [{ key: "s1", fieldKeys: ["email"] }],
    fields: { email: { key: "email", type: "email", label: T, required: true, sensitive: false, mapsTo: "person.email" } },
    logic: [],
    endings: [{ key: "done", kind: "thank_you", title: T, body: T, showScore: false, showDimensions: [], ctas: [] }],
    ...over,
  };
}

describe("FormDefinition schema (F1 to F5)", () => {
  it("parses a minimal definition and fills defaults", () => {
    const parsed = FormDefinition.parse({ title: T, settings: { submitLabel: T }, sections: [], fields: {} });
    expect(parsed.settings).toMatchObject({ resumeEnabled: false, resumeDays: 7, skipKnownFields: true, showProgress: true, sendResultEmail: false, createInboxThread: false, staffEntryAllowed: false });
    expect(parsed.logic).toEqual([]);
    expect(parsed.endings).toEqual([]);
  });

  it("F2: key regex", () => {
    for (const ok of ["a", "email", "sleep_hours", "a1", "x".repeat(40)]) expect(KEY_RE.test(ok)).toBe(true);
    for (const bad of ["", "1a", "Email", "sleep-hours", "_a", "x".repeat(41), "a b"]) expect(KEY_RE.test(bad)).toBe(false);
    const bad = FieldSchema.safeParse({ key: "Bad", type: "email", label: T });
    expect(bad.success).toBe(false);
  });

  it("F2: acknowledgement is always required", () => {
    const ack = { key: "ack", type: "acknowledgement", label: T, text: T };
    const parsed = FieldSchema.parse(ack) as Field;
    expect(parsed.required).toBe(true);
    expect(FieldSchema.safeParse({ ...ack, required: false }).success).toBe(false);
    const long = FieldSchema.safeParse({ ...ack, text: { ...T, en: "x".repeat(FORM_LIMITS.acknowledgementText + 1) } });
    expect(long.success).toBe(false);
  });

  it("F2: choice fields need 2 to 50 options with unique keys", () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `o${i}`, label: T }));
    const f = (options: unknown) => FieldSchema.safeParse({ key: "c", type: "single_choice", label: T, options });
    expect(f(opts(1)).success).toBe(false);
    expect(f(opts(2)).success).toBe(true);
    expect(f(opts(50)).success).toBe(true);
    expect(f(opts(51)).success).toBe(false);
    expect(f([{ key: "a", label: T }, { key: "a", label: T }]).success).toBe(false);
  });

  it("F2: type specific shapes", () => {
    expect(FieldSchema.safeParse({ key: "r", type: "rating", label: T, scale: 7 }).success).toBe(false);
    expect(FieldSchema.safeParse({ key: "r", type: "rating", label: T, scale: 10 }).success).toBe(true);
    expect(FieldSchema.safeParse({ key: "n", type: "number", label: T, min: 5, max: 1 }).success).toBe(false);
    expect(FieldSchema.safeParse({ key: "s", type: "short_text", label: T, maxLength: 256 }).success).toBe(false);
    expect(FieldSchema.safeParse({ key: "l", type: "long_text", label: T, maxLength: 5001 }).success).toBe(false);
    expect(FieldSchema.safeParse({ key: "c", type: "consent", label: T, purpose: "assessment_result", wording: T }).success).toBe(false);
    expect(FieldSchema.safeParse({ key: "h", type: "hidden", label: T, from: "query" }).success).toBe(false);
    expect(FieldSchema.safeParse({ key: "h", type: "hidden", label: T, from: "query", param: "ref" }).success).toBe(true);
    expect(FieldSchema.safeParse({ key: "u", type: "utm", label: T, param: "utm_campaign" }).success).toBe(true);
    expect(FieldSchema.safeParse({ key: "d", type: "date", label: T, min: "2026-1-1" }).success).toBe(false);
    expect(FieldSchema.safeParse({ key: "m", type: "multiple_choice", label: T, options: [{ key: "a", label: T }, { key: "b", label: T }], minSelected: 2, maxSelected: 1 }).success).toBe(false);
    expect(FieldSchema.safeParse({ key: "e", type: "email", label: T, extra: 1 }).success).toBe(false);
  });

  it("F4: condition depth 6 and 50 leaves", () => {
    const leaf: Condition = { field: "a", op: "answered" };
    let deep: Condition = leaf;
    for (let i = 0; i < 5; i++) deep = { not: deep };
    expect(ConditionSchema.safeParse(deep).success).toBe(true);
    expect(ConditionSchema.safeParse({ not: deep }).success).toBe(false);
    expect(ConditionSchema.safeParse({ any: Array.from({ length: 50 }, () => leaf) }).success).toBe(true);
    expect(ConditionSchema.safeParse({ any: Array.from({ length: 51 }, () => leaf) }).success).toBe(false);
    expect(ConditionSchema.safeParse({ field: "a", op: "between" }).success).toBe(false);
  });

  it("F5: CTAs max 4, https only, redirect URL https", () => {
    const cta = (i: number) => ({ key: `c${i}`, label: T, kind: "url", url: "https://example.com/x" });
    const ending = (ctas: unknown[], extra: object = {}) => FormDefinition.safeParse(minimal({ endings: [{ key: "r", kind: "result", title: T, body: T, showScore: true, showDimensions: [], ctas, ...extra } as never] }));
    expect(ending([1, 2, 3, 4].map(cta)).success).toBe(true);
    expect(ending([1, 2, 3, 4, 5].map(cta)).success).toBe(false);
    expect(ending([{ ...cta(1), url: "http://example.com" }]).success).toBe(false);
    expect(ending([{ key: "b", label: T, kind: "booking", sessionTemplateId: UUID }]).success).toBe(true);
    expect(ending([], { kind: "redirect", redirectUrl: "javascript:alert(1)" }).success).toBe(false);
  });

  it("F7: limits on sections, fields, logic rules, dimensions, outcomes and size", () => {
    const sections = Array.from({ length: 31 }, (_, i) => ({ key: `s${i}`, fieldKeys: [] }));
    expect(FormDefinition.safeParse(minimal({ sections })).success).toBe(false);
    expect(FormDefinition.safeParse(minimal({ sections: sections.slice(0, 30) })).success).toBe(true);
    const fields = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}`, { key: `f${i}`, type: "yes_no", label: T }]));
    expect(FormDefinition.safeParse(minimal({ fields: fields as never })).success).toBe(false);
    const logic = Array.from({ length: 101 }, (_, i) => ({ key: `r${i}`, afterSection: "s1", if: { field: "email", op: "answered" }, then: { end: "done" } }));
    expect(FormDefinition.safeParse(minimal({ logic: logic as never })).success).toBe(false);
    const dim = (i: number) => ({ key: `d${i}`, label: T, kind: "sum", ranges: [] });
    expect(FormScoring.safeParse({ dimensions: Array.from({ length: 20 }, (_, i) => dim(i)) }).success).toBe(true);
    expect(FormScoring.safeParse({ dimensions: Array.from({ length: 21 }, (_, i) => dim(i)) }).success).toBe(false);
    const outcome = (i: number) => ({ key: `o${i}`, label: T, priority: i, when: { score: "total", op: "gte", value: 0 }, endingKey: "done" });
    expect(FormScoring.safeParse({ outcomes: Array.from({ length: 51 }, (_, i) => outcome(i)) }).success).toBe(false);
    const big = minimal({ intro: { en: "x".repeat(FORM_LIMITS.bytes) } });
    expect(withinSizeLimit(big, {})).toBe(false);
    expect(withinSizeLimit(minimal(), {})).toBe(true);
    expect(validateForPublish("lead", big, { dimensions: [], outcomes: [] }, ["en"]).some((i) => i.code === "limit_exceeded")).toBe(true);
  });

  it("field record keys must match the field key", () => {
    const def = minimal({ fields: { other: { key: "email", type: "email", label: T, required: true, sensitive: false } } });
    expect(FormDefinition.safeParse(def).success).toBe(false);
  });

  it("FormScoring: `{}` means not scored; `total` is reserved", () => {
    const empty = FormScoring.parse({});
    expect(empty).toEqual({ dimensions: [], outcomes: [] });
    expect(isScored(empty)).toBe(false);
    expect(FormScoring.safeParse({ dimensions: [{ key: "total", label: T, kind: "sum" }] }).success).toBe(false);
    expect(isScored(FormScoring.parse({ dimensions: [{ key: "a", label: T, kind: "sum" }] }))).toBe(true);
  });

  it("ImportMapping (I2)", () => {
    const m = ImportMapping.parse({ email: "form_response.hidden.email", externalId: "event_id", answers: { sleep: "form_response.answers[field.ref=sleep].number" } });
    expect(m.sensitiveFieldKeys).toEqual([]);
    expect(ImportMapping.safeParse({ email: "a..b", externalId: "id", answers: {} }).success).toBe(false);
    expect(ImportMapping.safeParse({ email: "a.b[0].c", externalId: "id", answers: {}, consents: { newsletter: "consent" } }).success).toBe(true);
    expect(ImportMapping.safeParse({ email: "a", externalId: "id", answers: {}, consents: { assessment_result: "x" } }).success).toBe(false);
  });

  it("defaults by kind (F1, F6)", () => {
    expect(defaultSettings("assessment", T).sendResultEmail).toBe(true);
    expect(defaultSettings("lead", T).sendResultEmail).toBe(false);
    expect(defaultSettings("intake", T)).toMatchObject({ validityDays: 365, staffEntryAllowed: true });
    expect(defaultSettings("registration", T).staffEntryAllowed).toBe(true);
    expect(defaultSettings("survey", T).validityDays).toBeUndefined();
    expect(defaultSensitive("assessment", "long_text")).toBe(true);
    expect(defaultSensitive("intake", "long_text")).toBe(true);
    expect(defaultSensitive("lead", "long_text")).toBe(false);
    expect(defaultSensitive("assessment", "short_text")).toBe(false);
  });

  it("canonical hash ignores key order and changes with content", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
    const a = minimal();
    const b = JSON.parse(JSON.stringify(a, Object.keys(a).reverse())) as Def;
    const sc = { dimensions: [], outcomes: [] };
    expect(canonicalHash(a, sc)).toBe(canonicalHash({ ...b, ...a }, sc));
    expect(canonicalHash(a, sc)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalHash(minimal({ title: { en: "y" } }), sc)).not.toBe(canonicalHash(a, sc));
  });
});

describe("seeded definitions", () => {
  it("P13: the system slugs", () => {
    expect([...SYSTEM_FORM_SLUGS]).toEqual(["contact", "newsletter", "health-declaration"]);
    expect(Object.keys(seedDefinitions()).sort()).toEqual([...SYSTEM_FORM_SLUGS].sort());
  });

  it("every seedDefinitions() form parses and validates with zero errors and zero warnings", () => {
    for (const [slug, form] of Object.entries(seedDefinitions())) {
      expect(FormDefinition.safeParse(form.definition).success, slug).toBe(true);
      expect(FormScoring.safeParse(form.scoring).success, slug).toBe(true);
      expect(validateForPublish(form.kind, form.definition, form.scoring, form.locales), slug).toEqual([]);
      expect(form.locales).toEqual(["nl-BE", "fr-BE", "en"]);
    }
  });

  it("the demo recovery-check validates with zero errors, with ids and with url fallbacks", () => {
    for (const refs of [{ baseUrl: "https://beam.example.com", dayTemplateId: UUID, nightTemplateId: UUID, eventSessionId: UUID }, { baseUrl: "https://beam.example.com/" }]) {
      const form = recoveryCheckSeed(refs);
      expect(FormDefinition.safeParse(form.definition).success).toBe(true);
      expect(FormScoring.safeParse(form.scoring).success).toBe(true);
      expect(validateForPublish(form.kind, form.definition, form.scoring, form.locales).filter((i) => i.level === "error")).toEqual([]);
    }
  });

  it("recovery-check matches its brief: 3 sections, 12 fields, 3 dimensions, 4 outcomes, CTA kinds", () => {
    const form = recoveryCheckSeed({ baseUrl: "https://beam.example.com", dayTemplateId: UUID, nightTemplateId: UUID, eventSessionId: UUID });
    expect(form.kind).toBe("assessment");
    expect(form.definition.sections).toHaveLength(3);
    expect(Object.keys(form.definition.fields)).toHaveLength(12);
    expect(form.scoring.dimensions.map((d) => d.key)).toEqual(["sleep", "stress", "habits"]);
    expect(form.scoring.outcomes).toHaveLength(4);
    const kinds = new Set(form.definition.endings.flatMap((e) => e.ctas.map((c) => c.kind)));
    expect([...kinds].sort()).toEqual(["booking", "event", "experience"]);
    const fallback = recoveryCheckSeed({ baseUrl: "https://beam.example.com" });
    expect(fallback.definition.endings.flatMap((e) => e.ctas).every((c) => c.kind === "url" && c.url === "https://beam.example.com/nl")).toBe(true);
  });

  it("health-declaration brief: intake, 365 days, staff entry, eight sensitive yes/no health questions, no scoring", () => {
    const hd = seedDefinitions()["health-declaration"];
    expect(hd.kind).toBe("intake");
    expect(hd.definition.settings).toMatchObject({ validityDays: 365, staffEntryAllowed: true });
    const yesNo = Object.values(hd.definition.fields).filter((f) => f.type === "yes_no");
    expect(yesNo).toHaveLength(8);
    expect(yesNo.every((f) => f.sensitive && f.sensitiveKind === "health" && f.required)).toBe(true);
    expect(Object.values(hd.definition.fields).filter((f) => f.type === "long_text" && f.sensitive)).toHaveLength(1);
    expect(Object.values(hd.definition.fields).some((f) => f.type === "acknowledgement")).toBe(true);
    expect(isScored(hd.scoring)).toBe(false);
  });

  it("contact and newsletter: lead forms, inbox switch on contact, required newsletter consent only on newsletter", () => {
    const { contact, newsletter } = seedDefinitions();
    expect(contact.kind).toBe("lead");
    expect(contact.definition.settings.createInboxThread).toBe(true);
    expect(contact.definition.fields.message).toMatchObject({ type: "long_text", sensitive: false });
    expect(contact.definition.fields.newsletter).toMatchObject({ type: "consent", required: false });
    expect(newsletter.definition.fields.newsletter).toMatchObject({ type: "consent", purpose: "newsletter", required: true });
  });
});
