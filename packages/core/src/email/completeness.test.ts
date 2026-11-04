import { describe, expect, it } from "vitest";
import type { BlockDocument } from "./blocks";
import { completeLocales, completenessIssues, isTemplateComplete, templateCompleteness } from "./completeness";

const full = { "nl-BE": "Hallo", "fr-BE": "Bonjour", en: "Hello" };

const doc = (enHeading: string): BlockDocument => ({
  schemaVersion: 1,
  locales: {
    "nl-BE": [{ id: "hdg0000001", type: "heading", level: 1, text: "Welkom" }],
    "fr-BE": [{ id: "hdg0000001", type: "heading", level: 1, text: "Bienvenue" }],
    en: [
      { id: "hdg0000001", type: "heading", level: 1, text: enHeading },
      { id: "img0000001", type: "image", fileId: "7f1c1c1e-4a1b-4d4e-9c1a-0b8e2f3a4b5c", alt: "" },
      {
        id: "col0000001",
        type: "columns",
        stackOnMobile: true,
        columns: [
          { width: 50, blocks: [{ id: "btn0000001", type: "button", label: "", href: "https://beam.be/en", style: "primary" }] },
          { width: 50, blocks: [] },
        ],
      },
    ],
  },
});

describe("templateCompleteness", () => {
  it("lists a missing subject and preheader per locale", () => {
    const result = templateCompleteness({ subject: { "nl-BE": "Hallo", en: "  " }, preheader: full, copy: null, document: null });
    expect(result).toEqual([
      { locale: "nl-BE", missing: [] },
      { locale: "fr-BE", missing: ["subject"] },
      { locale: "en", missing: ["subject"] },
    ]);
    expect(completenessIssues(result)).toEqual(["fr-BE:subject", "en:subject"]);
    expect(completeLocales(result)).toEqual(["nl-BE"]);
  });

  it("lists missing block texts by block id, nested blocks included; an empty alt is decorative", () => {
    const result = templateCompleteness({ subject: full, preheader: full, document: doc("") });
    expect(result.find((r) => r.locale === "en")?.missing).toEqual(["blocks.hdg0000001.text", "blocks.btn0000001.label"]);
    expect(result.find((r) => r.locale === "nl-BE")?.missing).toEqual([]);
  });

  it("marks a locale without blocks as missing its document", () => {
    const d = doc("Welcome");
    delete d.locales["fr-BE"];
    const result = templateCompleteness({ subject: full, preheader: full, document: { ...d, locales: { ...d.locales, "nl-BE": [] } } });
    expect(completenessIssues(result)).toEqual(["nl-BE:document", "fr-BE:document", "en:blocks.btn0000001.label"]);
  });

  it("checks transactional copy slots, including declared slots absent from copy", () => {
    const version = { subject: full, preheader: full, copy: { intro: full, cta: { "nl-BE": "Boek", en: "Book" } } };
    expect(completenessIssues(templateCompleteness(version))).toEqual(["fr-BE:copy.cta"]);
    expect(completenessIssues(templateCompleteness(version, ["nl-BE", "fr-BE", "en"], { slots: ["intro", "outro"] }))).toEqual([
      "nl-BE:copy.outro",
      "fr-BE:copy.cta",
      "fr-BE:copy.outro",
      "en:copy.outro",
    ]);
  });

  it("checks only the requested locales, in the platform order", () => {
    const version = { subject: { en: "Hi" }, preheader: { en: "Hi" }, copy: { intro: { en: "Hi" } } };
    expect(templateCompleteness(version, ["en"])).toEqual([{ locale: "en", missing: [] }]);
    expect(isTemplateComplete(version, ["en"])).toBe(true);
    expect(isTemplateComplete(version)).toBe(false);
    expect(templateCompleteness(version, ["en", "nl-BE"]).map((r) => r.locale)).toEqual(["nl-BE", "en"]);
  });
});
