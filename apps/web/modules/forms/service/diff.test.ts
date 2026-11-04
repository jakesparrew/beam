/** forms-P5 `diffVersions`: added, removed and changed fields, logic and outcomes, by key. */
import { describe, expect, it } from "vitest";
import { recoveryCheckSeed, seedDefinitions, type FormDefinition, type FormScoring } from "@beam/core/forms";
import { diffVersions, type FormVersionRow } from "./diff";

const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x)) as X;
const T = (en: string) => ({ "nl-BE": `${en} (nl)`, "fr-BE": `${en} (fr)`, en });

function row(version: number, definition: FormDefinition, scoring: FormScoring, locales = ["nl-BE", "fr-BE", "en"]): FormVersionRow {
  return { id: `v${version}`, version, definition: definition as never, scoring: scoring as never, locales };
}

const base = () => {
  const s = recoveryCheckSeed({ baseUrl: "https://www.example.com" });
  return { definition: clone(s.definition), scoring: clone(s.scoring) };
};

describe("diffVersions", () => {
  it("reports nothing for identical versions", () => {
    const a = base();
    const d = diffVersions(row(1, a.definition, a.scoring), row(2, clone(a.definition), clone(a.scoring)));
    expect(d.same).toBe(true);
    expect(d.from).toEqual({ id: "v1", version: 1 });
    expect(d.to).toEqual({ id: "v2", version: 2 });
  });

  it("finds an added, a removed and a changed field", () => {
    const a = base();
    const b = clone(a);
    const [first, second] = Object.keys(b.definition.fields).filter((k) => b.definition.fields[k]!.type !== "email");
    b.definition.fields.extra_note = { key: "extra_note", type: "short_text", label: T("Note"), required: false, sensitive: false };
    b.definition.sections[0]!.fieldKeys.push("extra_note");
    delete b.definition.fields[second!];
    for (const s of b.definition.sections) s.fieldKeys = s.fieldKeys.filter((k) => k !== second);
    b.definition.fields[first!] = { ...b.definition.fields[first!]!, label: T("Changed label"), required: !b.definition.fields[first!]!.required };

    const d = diffVersions(row(1, a.definition, a.scoring), row(2, b.definition, b.scoring));
    expect(d.same).toBe(false);
    expect(d.fields.added).toEqual(["extra_note"]);
    expect(d.fields.removed).toEqual([second]);
    expect(d.fields.changed).toEqual([{ key: first, props: ["label", "required"] }]);
    expect(d.sections.changed.map((c) => c.key).length).toBeGreaterThan(0);
  });

  it("finds added, removed and changed logic rules", () => {
    const c = clone(seedDefinitions().contact);
    const a = clone(c.definition);
    a.sections.push({ key: "s2", fieldKeys: [] }, { key: "s3", fieldKeys: [] });
    const email = Object.values(a.fields).find((f) => f.type === "email")!.key;
    a.logic = [
      { key: "r1", afterSection: a.sections[0]!.key, if: { field: email, op: "answered" }, then: { goto: "s3" } },
      { key: "r2", afterSection: a.sections[0]!.key, if: { field: email, op: "not_answered" }, then: { goto: "s2" } },
    ];
    const b = clone(a);
    b.logic = [
      { ...b.logic[0]!, then: { goto: "s2" } },
      { key: "r3", afterSection: "s2", if: { field: email, op: "answered" }, then: { end: b.endings[0]!.key } },
    ];
    const d = diffVersions(row(1, a, c.scoring), row(2, b, c.scoring));
    expect(d.logic).toEqual({ added: ["r3"], removed: ["r2"], changed: [{ key: "r1", props: ["then"] }] });
  });

  it("finds added, removed and changed outcomes and dimensions", () => {
    const a = base();
    const b = clone(a);
    const [o1, o2] = b.scoring.outcomes;
    expect(o1 && o2).toBeTruthy();
    b.scoring.outcomes = [
      { ...o1!, label: T("Renamed"), priority: o1!.priority + 10 },
      { ...o2!, key: "new_outcome" },
      ...b.scoring.outcomes.slice(2),
    ];
    if (b.scoring.defaultOutcomeKey === o2!.key) b.scoring.defaultOutcomeKey = "new_outcome";
    const dim = b.scoring.dimensions[0]!;
    b.scoring.dimensions[0] = { ...dim, label: T("Dim renamed") };

    const d = diffVersions(row(1, a.definition, a.scoring), row(2, b.definition, b.scoring));
    expect(d.scoring.outcomes.added).toEqual(["new_outcome"]);
    expect(d.scoring.outcomes.removed).toEqual([o2!.key]);
    expect(d.scoring.outcomes.changed).toEqual([{ key: o1!.key, props: ["label", "priority"] }]);
    expect(d.scoring.dimensions.changed).toEqual([{ key: dim.key, props: ["label"] }]);
  });

  it("reports form texts, settings, locales and moved sections", () => {
    const c = clone(seedDefinitions().contact);
    const a = clone(c.definition);
    a.sections.push({ key: "s2", fieldKeys: [] }, { key: "s3", fieldKeys: [] });
    const b = clone(a);
    b.title = T("New title");
    b.settings.showProgress = !b.settings.showProgress;
    b.sections = [b.sections[0]!, b.sections[2]!, b.sections[1]!];
    const d = diffVersions(row(1, a, c.scoring, ["nl-BE", "fr-BE"]), row(2, b, c.scoring, ["nl-BE", "en"]));
    expect(d.form).toEqual(["title", "settings.showProgress"]);
    expect(d.locales).toEqual({ added: ["en"], removed: ["fr-BE"] });
    expect(d.sections.moved).toEqual(["s2", "s3"]);
    expect(d.same).toBe(false);
  });
});
