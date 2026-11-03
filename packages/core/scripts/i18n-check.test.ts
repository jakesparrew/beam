import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCatalogues, DEFAULT_DIR, formatProblem } from "./i18n-check";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__/i18n");
const run = (name: string) => checkCatalogues(path.join(fixtures, name));

describe("i18n-check", () => {
  it("passes a complete fixture tree", () => {
    expect(run("ok")).toEqual([]);
  });

  it("reports a key that nl-BE lacks", () => {
    expect(run("missing")).toEqual([{ kind: "missing_key", locale: "nl-BE", file: "crm.json", key: "crm.list.count" }]);
  });

  it("reports a key that en does not have", () => {
    expect(run("extra")).toEqual([{ kind: "extra_key", locale: "fr-BE", file: "crm.json", key: "crm.list.subtitle" }]);
  });

  it("reports a value that is empty after trimming", () => {
    expect(run("empty")).toEqual([{ kind: "empty_value", locale: "nl-BE", file: "crm.json", key: "crm.list.title" }]);
  });

  it("reports keys that do not start with their file's module name", () => {
    const problems = run("prefix");
    expect(problems.map((p) => p.kind)).toEqual(Array(6).fill("wrong_prefix"));
    expect(new Set(problems.map((p) => p.locale))).toEqual(new Set(["en", "nl-BE", "fr-BE"]));
    expect(problems[0]?.key).toMatch(/^booking\./);
  });

  it("reports an ICU syntax error", () => {
    const problems = run("icu");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: "icu_syntax", locale: "nl-BE", key: "crm.list.count" });
    expect(formatProblem(problems[0]!)).toContain("nl-BE/crm.json: icu_syntax crm.list.count");
  });

  it("the real catalogues are complete", () => {
    expect(checkCatalogues(DEFAULT_DIR).map(formatProblem)).toEqual([]);
  });
});
