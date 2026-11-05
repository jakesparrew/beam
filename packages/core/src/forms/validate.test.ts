import { describe, expect, it } from "vitest";
import { recoveryCheckSeed, seedDefinitions, type SeedForm } from "./seed-definitions";
import type { Field, FormDefinition, FormScoring, PublishIssue, PublishIssueCode } from "./types";
import { ctaHasTarget, isPublishable, validateForPublish } from "./validate";

const T = { "nl-BE": "x", "fr-BE": "x", en: "x" };
const UUID = "00000000-0000-4000-8000-000000000001";
const clone = <X>(x: X): X => structuredClone(x);
const recovery = (): SeedForm => recoveryCheckSeed({ baseUrl: "https://beam.example.com", dayTemplateId: UUID, nightTemplateId: UUID, eventSessionId: UUID });

function issues(f: SeedForm): PublishIssue[] {
  return validateForPublish(f.kind, f.definition, f.scoring, f.locales);
}
function codes(f: SeedForm, level: PublishIssue["level"] = "error"): PublishIssueCode[] {
  return issues(f).filter((i) => i.level === level).map((i) => i.code);
}
function edit(base: SeedForm, fn: (d: FormDefinition, s: FormScoring) => void): SeedForm {
  const f = clone(base);
  fn(f.definition, f.scoring);
  return f;
}
const add = (d: FormDefinition, section: number, f: Field) => {
  d.fields[f.key] = f;
  d.sections[section]!.fieldKeys.push(f.key);
};

describe("P1", () => {
  it("valid forms have no errors and isPublishable", () => {
    expect(codes(recovery())).toEqual([]);
    expect(isPublishable(issues(recovery()))).toBe(true);
    expect(isPublishable([{ level: "warning", code: "result_without_cta", path: "", message: "" }])).toBe(true);
    expect(isPublishable([{ level: "error", code: "no_ending", path: "", message: "" }])).toBe(false);
  });
  it("errors are listed before warnings, and all of them are returned", () => {
    const f = edit(recovery(), (d) => {
      d.endings[0]!.ctas = [];
      d.title = { en: "only" };
    });
    const list = issues(f);
    expect(list.map((i) => i.level)).toEqual([...list.filter((i) => i.level === "error").map(() => "error"), ...list.filter((i) => i.level === "warning").map(() => "warning")]);
    expect(list.some((i) => i.code === "incomplete_text")).toBe(true);
    expect(list.some((i) => i.code === "result_without_cta")).toBe(true);
  });
  it("a definition with the wrong shape reports invalid_shape and acknowledgement_not_required", () => {
    const f = edit(recovery(), (d) => {
      d.fields.ack = { key: "ack", type: "acknowledgement", label: T, text: T, required: false, sensitive: false };
      d.sections[0]!.fieldKeys.push("ack");
      (d.fields.email as { label: unknown }).label = 4;
    });
    expect(codes(f)).toEqual(expect.arrayContaining(["acknowledgement_not_required", "invalid_shape"]));
  });
});

describe("P2: completeness", () => {
  it("missing fr-BE label path", () => {
    const f = edit(recovery(), (d) => {
      delete d.fields.sleep_hours!.label["fr-BE"];
    });
    const i = issues(f).find((x) => x.code === "incomplete_text")!;
    expect(i).toMatchObject({ level: "error", path: "fields.sleep_hours.label", message: "fields.sleep_hours.label: fr-BE missing", locales: ["fr-BE"] });
  });
  it("missing acknowledgement text", () => {
    const hd = seedDefinitions()["health-declaration"];
    const f = edit(hd, (d) => {
      (d.fields.contraindications as { text: Record<string, string> }).text.en = "  ";
    });
    expect(issues(f).find((x) => x.code === "incomplete_text")?.path).toBe("fields.contraindications.text");
  });
  it("only the form's locales are checked", () => {
    const f = edit(recovery(), (d) => {
      delete d.fields.sleep_hours!.label["fr-BE"];
    });
    f.locales = ["nl-BE", "en"];
    expect(codes(f)).toEqual([]);
  });
  it("covers options, consent wording, endings, CTAs, email texts, settings and scoring texts", () => {
    const f = edit(recovery(), (d, s) => {
      delete (d.fields.movement as { options: { label: Record<string, string> }[] }).options[0]!.label.en;
      delete (d.fields.newsletter as { wording: Record<string, string> }).wording.en;
      delete d.endings[0]!.body.en;
      delete d.endings[0]!.ctas[0]!.label.en;
      delete d.endings[0]!.email!.subject.en;
      delete d.settings.submitLabel.en;
      delete d.sections[0]!.title!.en;
      delete s.dimensions[2]!.label.en;
      delete s.dimensions[2]!.ranges[0]!.explanation!.en;
      delete s.outcomes[0]!.recommendation!.en;
      delete s.total!.ranges[0]!.label.en;
    });
    expect(issues(f).filter((i) => i.code === "incomplete_text").map((i) => i.path)).toEqual([
      "settings.submitLabel",
      "sections.about.title",
      "fields.newsletter.wording",
      "fields.movement.options.rarely.label",
      "endings.result_reset.body",
      "endings.result_reset.ctas.experience.label",
      "endings.result_reset.email.subject",
      "scoring.dimensions.habits.label",
      "scoring.dimensions.habits.ranges.low.explanation",
      "scoring.total.ranges.low.label",
      "scoring.outcomes.reset_now.recommendation",
    ]);
  });
});

describe("P3: structure", () => {
  it("unique keys, every field in exactly one section, unknown fields in sections", () => {
    const f = edit(recovery(), (d) => {
      d.sections.push({ key: "about", fieldKeys: [] });
      d.sections[1]!.fieldKeys.push("email", "ghost");
      d.fields.orphan = { key: "orphan", type: "short_text", label: T, required: false, sensitive: false };
    });
    expect(codes(f)).toEqual(expect.arrayContaining(["duplicate_key", "field_in_two_sections", "unknown_field", "field_not_in_section"]));
  });
  it("hidden and UTM fields belong to the first section", () => {
    const f = edit(recovery(), (d) => add(d, 2, { key: "src", type: "utm", param: "utm_source", label: T, required: false, sensitive: false }));
    expect(codes(f)).toEqual(["hidden_field_not_first"]);
  });
  it("no section, no ending", () => {
    const f = edit(recovery(), (d, s) => {
      d.sections = [];
      d.endings = [];
      s.outcomes = [];
      delete s.defaultOutcomeKey;
    });
    expect(codes(f)).toEqual(expect.arrayContaining(["no_section", "no_ending"]));
  });
  it("logic references and forward-only goto (L3)", () => {
    const f = edit(recovery(), (d) => {
      d.logic = [
        { key: "a", afterSection: "nowhere", if: { field: "email", op: "answered" }, then: { goto: "habits" } },
        { key: "b", afterSection: "habits", if: { field: "movement", op: "answered" }, then: { goto: "about" } },
        { key: "c", afterSection: "about", if: { field: "email", op: "answered" }, then: { goto: "nowhere" } },
        { key: "d", afterSection: "about", if: { field: "email", op: "answered" }, then: { end: "nowhere" } },
      ];
    });
    expect(codes(f)).toEqual(["unknown_section", "goto_not_forward", "unknown_section", "unknown_ending"]);
  });
  it("L4: a condition may only use earlier answers", () => {
    const f = edit(recovery(), (d) => {
      d.fields.email = { ...d.fields.email!, visibleIf: { field: "movement", op: "answered" } };
      d.sections[1] = { ...d.sections[1]!, visibleIf: { field: "sleep_hours", op: "answered" } };
      d.fields.first_name = { ...d.fields.first_name!, visibleIf: { score: "habits", op: "gt", value: 1 } };
    });
    expect(codes(f).filter((c) => c === "condition_forward_reference")).toHaveLength(3);
    const ok = edit(recovery(), (d) => {
      d.fields.cold_exposure = { ...d.fields.cold_exposure!, visibleIf: { field: "movement", op: "eq", value: "daily" } };
      d.logic = [{ key: "r", afterSection: "habits", if: { field: "movement", op: "eq", value: "daily" }, then: { end: "result_pro" } }];
    });
    expect(codes(ok)).toEqual([]);
  });
  it("unknown dimensions and ranges in conditions, showDimensions and formulas", () => {
    const f = edit(recovery(), (d, s) => {
      s.outcomes[0]!.when = { all: [{ range: { dimension: "habits", key: "nope" } }, { score: "ghost", op: "gt", value: 1 }] };
      d.endings[0]!.showDimensions = ["ghost"];
      s.dimensions.push({ key: "f", label: T, kind: "formula", formula: "dim.ghost + answer.ghost", ranges: [] });
    });
    expect(codes(f)).toEqual(expect.arrayContaining(["unknown_dimension", "unknown_field", "unknown_range"]));
  });
  it("formulas parse; a formula dimension needs a formula and may not read the total", () => {
    const f = edit(recovery(), (d, s) => {
      s.dimensions.push({ key: "f1", label: T, kind: "formula", formula: "1 +", ranges: [] });
      s.dimensions.push({ key: "f2", label: T, kind: "formula", ranges: [] });
      s.dimensions.push({ key: "f3", label: T, kind: "formula", formula: "total * 2", ranges: [] });
      s.total = { kind: "formula", formula: "dim.(", ranges: [] };
    });
    expect(codes(f).filter((c) => c === "formula_invalid")).toHaveLength(4);
  });
  it("cycle -> error", () => {
    const f = edit(recovery(), (_d, s) => {
      s.dimensions.push({ key: "a", label: T, kind: "formula", formula: "dim.b", ranges: [] }, { key: "b", label: T, kind: "formula", formula: "dim.a", ranges: [] });
    });
    expect(codes(f)).toEqual(["dimension_cycle", "dimension_cycle"]);
  });
  it("ranges must not overlap and must end after they start", () => {
    const f = edit(recovery(), (_d, s) => {
      s.dimensions[2]!.ranges[1]!.from = 9;
      s.dimensions[0]!.ranges[0]!.to = 0;
    });
    expect(codes(f)).toEqual(expect.arrayContaining(["range_overlap", "range_invalid"]));
  });
  it("outcome endings, default outcome required, unknown default", () => {
    const f = edit(recovery(), (_d, s) => {
      s.outcomes[0]!.endingKey = "ghost";
      delete s.defaultOutcomeKey;
    });
    expect(codes(f)).toEqual(["unknown_ending", "default_outcome_missing"]);
    const g = edit(recovery(), (_d, s) => {
      s.defaultOutcomeKey = "ghost";
    });
    expect(codes(g)).toEqual(["unknown_outcome"]);
  });
  it("CTA targets and redirect URL", () => {
    const f = edit(recovery(), (d) => {
      d.endings[0]!.ctas[0] = { key: "x", label: T, kind: "product" };
      d.endings.push({ key: "go", kind: "redirect", title: T, body: {}, showScore: false, showDimensions: [], ctas: [] });
    });
    expect(codes(f)).toEqual(["cta_target_missing", "redirect_url_missing"]);
    expect(ctaHasTarget({ key: "w", label: T, kind: "webinar", webinarId: UUID })).toBe(true);
    expect(ctaHasTarget({ key: "w", label: T, kind: "webinar" })).toBe(false);
    expect(ctaHasTarget({ key: "e", label: T, kind: "event" })).toBe(false);
    expect(ctaHasTarget({ key: "u", label: T, kind: "url" })).toBe(false);
  });
  it("L6: goto or outcome on a sensitive field -> sensitive_in_logic", () => {
    const goto = edit(recovery(), (d) => {
      d.logic = [{ key: "r", afterSection: "sleep_stress", if: { field: "stress_level", op: "gte", value: 8 }, then: { goto: "habits" } }];
    });
    expect(codes(goto)).toEqual(["sensitive_in_logic"]);
    const outcome = edit(recovery(), (_d, s) => {
      s.outcomes[0]!.when = { range: { dimension: "sleep", key: "low" } };
    });
    expect(codes(outcome)).toEqual(["sensitive_in_logic"]);
    const showHide = edit(recovery(), (d) => add(d, 2, { key: "goal_note", type: "short_text", label: T, required: false, sensitive: false, visibleIf: { score: "stress", op: "gt", value: 2 } }));
    expect(codes(showHide)).toEqual([]);
  });
  it("field shown by a sensitive condition is derived sensitive (logic on it is refused)", () => {
    const f = edit(recovery(), (d) => {
      d.fields.movement = { ...d.fields.movement!, visibleIf: { field: "stress_level", op: "gte", value: 5 } };
      d.logic = [{ key: "r", afterSection: "habits", if: { field: "movement", op: "eq", value: "daily" }, then: { end: "result_pro" } }];
    });
    expect(codes(f)).toEqual(expect.arrayContaining(["sensitive_in_logic"]));
  });
});

describe("P4: identity", () => {
  it("every kind except survey needs a required email mapped to person.email", () => {
    const f = edit(seedDefinitions().contact, (d) => {
      d.fields.email = { ...d.fields.email!, required: false };
    });
    expect(codes(f)).toEqual(["email_field_missing"]);
    const survey = { ...f, kind: "survey" as const };
    expect(codes(survey)).toEqual([]);
  });
  it("survey with a sensitive field and no email -> error", () => {
    const f = edit(seedDefinitions().contact, (d) => {
      delete d.fields.email;
      d.sections[0]!.fieldKeys = d.sections[0]!.fieldKeys.filter((k) => k !== "email");
      d.fields.message = { ...d.fields.message!, sensitive: true };
      add(d, 0, { key: "ok", type: "consent", purpose: "sensitive_processing", wording: T, label: T, required: true, sensitive: false });
    });
    expect(codes({ ...f, kind: "survey" })).toEqual(["email_field_missing"]);
  });
  it("sendResultEmail needs an email block on every result ending", () => {
    const f = edit(recovery(), (d) => {
      delete d.endings[1]!.email;
    });
    expect(codes(f)).toEqual(["result_email_missing"]);
  });
});

describe("P5 and P6: consents", () => {
  it("sensitive field without consent -> error", () => {
    const f = edit(recovery(), (d) => {
      d.fields.sensitive_consent = { ...d.fields.sensitive_consent!, required: false };
    });
    expect(codes(f)).toEqual(["sensitive_consent_missing"]);
  });
  it("the sensitive consent comes before or with the first sensitive section", () => {
    const f = edit(recovery(), (d) => {
      d.sections[0]!.fieldKeys = d.sections[0]!.fieldKeys.filter((k) => k !== "sensitive_consent");
      d.sections[2]!.fieldKeys.push("sensitive_consent");
    });
    expect(codes(f)).toEqual(["sensitive_consent_late"]);
  });
  it("newsletter consent required -> error, except on a pure sign-up form", () => {
    expect(codes(seedDefinitions().newsletter)).toEqual([]);
    const f = edit(seedDefinitions().contact, (d) => {
      d.fields.newsletter = { ...d.fields.newsletter!, required: true };
    });
    expect(codes(f)).toEqual(["consent_must_be_optional"]);
    const two = edit(seedDefinitions().newsletter, (d) => add(d, 0, { key: "events", type: "consent", purpose: "events", wording: T, label: T, required: false, sensitive: false }));
    expect(codes(two)).toEqual(["consent_must_be_optional"]);
    const ai = edit(seedDefinitions().newsletter, (d) => {
      d.fields.newsletter = { ...d.fields.newsletter!, purpose: "ai_processing" } as Field;
    });
    expect(codes(ai)).toEqual(["consent_must_be_optional"]);
  });
  it("a consent purpose outside the form list is refused", () => {
    const f = edit(seedDefinitions().contact, (d) => {
      (d.fields.newsletter as { purpose: string }).purpose = "assessment_result";
    });
    expect(codes(f)).toEqual(expect.arrayContaining(["invalid_shape"]));
  });
});

describe("P8: warnings", () => {
  it("unreachable section and ending", () => {
    const f = edit(recovery(), (d) => {
      d.sections[2] = { ...d.sections[2]!, visibleIf: { field: "email", op: "eq", value: "x" } };
      d.sections[2] = { ...d.sections[2], visibleIf: { all: [{ field: "screen_time", op: "eq", value: "never" }] } };
      d.endings.push({ key: "lost", kind: "thank_you", title: T, body: T, showScore: false, showDimensions: [], ctas: [] });
    });
    const w = codes(f, "warning");
    expect(w).toEqual(expect.arrayContaining(["unreachable_section", "unreachable_ending"]));
  });
  it("outcome never selectable by its ranges", () => {
    const f = edit(recovery(), (_d, s) => {
      s.outcomes[1]!.when = { score: "habits", op: "gt", value: 31 };
    });
    expect(codes(f, "warning")).toEqual(["outcome_unselectable"]);
  });
  it("long text unmarked sensitive on an assessment", () => {
    const f = edit(recovery(), (d) => add(d, 2, { key: "notes", type: "long_text", label: T, required: false, sensitive: false }));
    expect(codes(f, "warning")).toEqual(["long_text_not_sensitive"]);
  });
  it("result ending without CTA", () => {
    const f = edit(recovery(), (d) => {
      d.endings[2]!.ctas = [];
    });
    expect(codes(f, "warning")).toEqual(["result_without_cta"]);
  });
});

describe("forms-P8: webinar CTAs (R2)", () => {
  it("F5: a webinar CTA with its webinarId publishes; without it -> cta_target_missing", () => {
    const ok = edit(recovery(), (d) => {
      d.endings[0]!.ctas.push({ key: "webinar", label: T, kind: "webinar", webinarId: UUID });
    });
    expect(codes(ok)).toEqual([]);
    expect(issues(ok).some((i) => i.path.includes("ctas.webinar"))).toBe(false);
    const missing = edit(recovery(), (d) => {
      d.endings[0]!.ctas.push({ key: "webinar", label: T, kind: "webinar" });
    });
    const errors = issues(missing).filter((i) => i.level === "error");
    expect(errors.map((i) => [i.code, i.path])).toEqual([["cta_target_missing", `endings.${missing.definition.endings[0]!.key}.ctas.webinar`]]);
  });
  it("a webinar CTA label must be complete in every locale like any other CTA", () => {
    const f = edit(recovery(), (d) => {
      d.endings[0]!.ctas.push({ key: "webinar", label: { en: "Join" }, kind: "webinar", webinarId: UUID });
    });
    expect(codes(f)).toContain("incomplete_text");
  });
});
