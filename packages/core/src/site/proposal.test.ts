import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkProposal, ProposalOutput, proposalToVersionContent } from "./proposal";
import { paragraphDoc } from "./rich-text";
import { DEFAULT_SITE_SETTINGS, parseSiteSettings, SiteSettings } from "./settings";

const id = (): string => globalThis.crypto.randomUUID();
const output = (locales: ("nl-BE" | "en")[]) => ({
  title: Object.fromEntries(locales.map((l) => [l, `Titel ${l}`])),
  paths: Object.fromEntries(locales.map((l) => [l, "over-ons"])),
  blocks: Object.fromEntries(locales.map((l) => [l, [{ id: id(), type: "rich_text", doc: paragraphDoc("Tekst") }]])),
  seo: {},
  changeSummary: "Korter gemaakt",
});

describe("ProposalOutput", () => {
  it("parses a valid proposal and converts it to version content", () => {
    const r = checkProposal(output(["nl-BE", "en"]), { locales: ["nl-BE", "en"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(proposalToVersionContent(r.output, { locales: ["nl-BE", "en"] }).locales).toEqual(["nl-BE", "en"]);
  });

  it("refuses a proposal that drops a base locale (rule 44) or has invalid blocks", () => {
    const dropped = checkProposal(output(["nl-BE"]), { locales: ["nl-BE", "en"] });
    expect(dropped).toEqual({ ok: false, problems: [expect.objectContaining({ code: "locale_removed", locale: "en" })] });
    const bad = { ...output(["nl-BE"]), blocks: { "nl-BE": [{ id: id(), type: "iframe" }] } };
    expect(checkProposal(bad, { locales: ["nl-BE"] })).toMatchObject({ ok: false, problems: [expect.objectContaining({ code: "invalid_output" })] });
    expect(checkProposal({ ...output(["nl-BE"]), changeSummary: "x".repeat(501) }, { locales: ["nl-BE"] }).ok).toBe(false);
  });

  it("converts to a JSON schema for structured output", () => {
    // callClaude converts the output schema with the default options (lib/ai.ts).
    expect(() => z.toJSONSchema(ProposalOutput)).not.toThrow();
  });
});

describe("SiteSettings", () => {
  it("the defaults pass the schema and partial stored values fall back field by field", () => {
    expect(SiteSettings.safeParse(DEFAULT_SITE_SETTINGS).success).toBe(true);
    expect(parseSiteSettings({ analytics_enabled: true, ga_measurement_id: "G-ABC123" })).toMatchObject({ analytics_enabled: true, ga_measurement_id: "G-ABC123", canonical_origin: "https://www.beam.be" });
    expect(parseSiteSettings({ ga_measurement_id: "UA-1" })).toEqual(DEFAULT_SITE_SETTINGS);
    expect(parseSiteSettings(null)).toEqual(DEFAULT_SITE_SETTINGS);
  });
});
