import { describe, expect, it } from "vitest";
import { buildPageMetadata, isNoindex, type MetadataPage } from "./metadata";

const origin = "https://www.beam.be";
const seo = { title: "Day sessions at BEAM", description: "Sauna, pools and rest on a day session in the centre of Brussels." };

function base(overrides: Partial<MetadataPage> = {}): MetadataPage {
  return { kind: "standard", title: "Day sessions", seo, routes: { "nl-BE": "dagsessies", "fr-BE": "seances-de-jour", en: "day-sessions" }, ...overrides };
}

describe("buildPageMetadata", () => {
  it("sets title, description and the canonical URL of the locale", () => {
    const m = buildPageMetadata(base(), "fr-BE", { origin, isProduction: true });
    expect(m.title).toBe(seo.title);
    expect(m.description).toBe(seo.description);
    expect(m.alternates?.canonical).toBe("https://www.beam.be/fr/seances-de-jour");
    expect(m.robots).toEqual({ index: true, follow: true });
    expect((m.openGraph as { locale?: string }).locale).toBe("fr_BE");
  });

  it("lists hreflang only for live locales, with x-default nl-BE", () => {
    const m = buildPageMetadata(base(), "en", { origin, isProduction: true });
    expect(m.alternates?.languages).toEqual({
      "nl-BE": "https://www.beam.be/nl/dagsessies",
      "fr-BE": "https://www.beam.be/fr/seances-de-jour",
      en: "https://www.beam.be/en/day-sessions",
      "x-default": "https://www.beam.be/nl/dagsessies",
    });
    const partial = buildPageMetadata(base({ routes: { "fr-BE": "seances-de-jour", en: "day-sessions" } }), "en", { origin, isProduction: true });
    expect(partial.alternates?.languages).toEqual({
      "fr-BE": "https://www.beam.be/fr/seances-de-jour",
      en: "https://www.beam.be/en/day-sessions",
      "x-default": "https://www.beam.be/fr/seances-de-jour",
    });
  });

  it("uses the bare prefix for home", () => {
    const m = buildPageMetadata(base({ kind: "home", routes: { "nl-BE": "", en: "" } }), "nl-BE", { origin, isProduction: true });
    expect(m.alternates?.canonical).toBe("https://www.beam.be/nl");
    expect(m.alternates?.languages).toMatchObject({ en: "https://www.beam.be/en", "x-default": "https://www.beam.be/nl" });
  });

  it("falls back to the page title without SEO texts", () => {
    const m = buildPageMetadata(base({ seo: null, excerpt: "Short excerpt" }), "nl-BE", { origin, isProduction: true });
    expect(m.title).toBe("Day sessions");
    expect(m.description).toBe("Short excerpt");
  });
});

describe("noindex", () => {
  const now = new Date("2026-06-30T12:00:00Z");
  const event = (endsAt: string, status = "open") => ({ endsAt, status });

  it("marks every page noindex outside production", () => {
    expect(buildPageMetadata(base(), "nl-BE", { origin, isProduction: false }).robots).toEqual({ index: false, follow: false });
    expect(isNoindex(base(), { isProduction: true })).toBe(false);
  });

  it("marks a past event noindex only 30 days after it ended", () => {
    const page = base({ kind: "event" });
    expect(isNoindex(page, { isProduction: true, now, event: event("2026-06-01T12:00:01Z") })).toBe(false);
    expect(isNoindex(page, { isProduction: true, now, event: event("2026-05-31T11:59:59Z") })).toBe(true);
    expect(buildPageMetadata(page, "nl-BE", { origin, isProduction: true, now, event: event("2026-05-01T00:00:00Z") }).robots).toEqual({ index: false, follow: false });
  });

  it("marks cancelled events, seo.noindex pages, the guardian consent page and previews noindex", () => {
    expect(isNoindex(base({ kind: "event" }), { isProduction: true, now, event: event("2026-07-30T00:00:00Z", "cancelled") })).toBe(true);
    expect(isNoindex(base({ seo: { ...seo, noindex: true } }), { isProduction: true })).toBe(true);
    expect(isNoindex(base({ kind: "legal", legalKey: "guardian_consent" }), { isProduction: true })).toBe(true);
    expect(isNoindex(base({ kind: "legal", legalKey: "terms" }), { isProduction: true })).toBe(false);
    expect(isNoindex(base({ isPreview: true }), { isProduction: true })).toBe(true);
  });
});
