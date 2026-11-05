/**
 * crm-P10 sensitive screen (rule 3.51, edge case 29): keywords per locale, whole-word matching,
 * prefixes, accents, hyphens and case.
 */
import { describe, expect, it } from "vitest";
import { LOCALES } from "../i18n";
import { normaliseForScreen, screenSensitive, screenSensitiveAll, SENSITIVE_KEYWORDS } from "./sensitive-screen";

describe("SENSITIVE_KEYWORDS", () => {
  it.each(LOCALES)("%s has keywords, each matching itself", (locale) => {
    expect(SENSITIVE_KEYWORDS[locale].length).toBeGreaterThan(10);
    for (const keyword of SENSITIVE_KEYWORDS[locale]) {
      expect(screenSensitive(`Hallo, ${keyword.replace(/\*$/, "")} hier.`, locale), keyword).toMatchObject({ blocked: true, matched: [keyword] });
    }
  });

  it("has no duplicate keyword in a locale", () => {
    for (const locale of LOCALES) {
      const normalised = SENSITIVE_KEYWORDS[locale].map(normaliseForScreen);
      expect(new Set(normalised).size, locale).toBe(normalised.length);
    }
  });
});

describe("screenSensitive", () => {
  it("blocks burn-out in each locale (edge case 29)", () => {
    expect(screenSensitive("Ik zit thuis met een burn-out en wil mijn abonnement pauzeren.", "nl-BE")).toEqual({ blocked: true, matched: ["burn-out"] });
    expect(screenSensitive("Je suis en burn-out depuis un mois.", "fr-BE").blocked).toBe(true);
    expect(screenSensitive("I am off work with burnout.", "en")).toEqual({ blocked: true, matched: ["burnout"] });
  });

  it("matches nl-BE health topics", () => {
    expect(screenSensitive("Mijn dokter zegt dat ik zwanger ben.", "nl-BE").matched).toEqual(["zwanger*"]);
    expect(screenSensitive("Tijdens mijn zwangerschap wil ik rustiger trainen.", "nl-BE").matched).toEqual(["zwanger*"]);
    expect(screenSensitive("Ik neem medicatie voor mijn depressie.", "nl-BE").matched.sort()).toEqual(["depressie", "medicatie"]);
  });

  it("matches fr-BE with or without accents", () => {
    expect(screenSensitive("Je suis enceinte de trois mois.", "fr-BE").matched).toEqual(["enceinte"]);
    expect(screenSensitive("J'ai été opéré du genou et je prends des médicaments.", "fr-BE").matched.sort()).toEqual(["medicament*", "opere"]);
    expect(screenSensitive("Après ma DÉPRESSION, je reprends le sport.", "fr-BE").matched).toEqual(["depression"]);
    expect(screenSensitive("Une crise d'angoisse hier soir.", "fr-BE").matched).toEqual(["crise d angoisse"]);
  });

  it("matches en phrases across hyphens, case and white space", () => {
    expect(screenSensitive("I had a HEART   ATTACK last year.", "en").matched).toEqual(["heart attack"]);
    expect(screenSensitive("History of self harm.", "en").matched).toEqual(["self-harm"]);
    expect(screenSensitive("She was hospitalised in May.", "en").matched).toEqual(["hospital*"]);
  });

  it("matches whole words only", () => {
    // "cancer" inside a longer word, "stroke" inside "strokes"... a prefix keyword does match.
    expect(screenSensitive("Cancerous? No: I want to cancel my booking.", "en").blocked).toBe(false);
    expect(screenSensitive("Two backstrokes in the pool.", "en").blocked).toBe(false);
    expect(screenSensitive("De tumoren", "nl-BE").blocked).toBe(false);
    expect(screenSensitive("The hivemind", "en").blocked).toBe(false);
    expect(screenSensitive("cancer.", "en").blocked).toBe(true);
    expect(screenSensitive("(cancer)", "en").blocked).toBe(true);
  });

  it("does not block routine questions", () => {
    expect(screenSensitive("Kan ik mijn sessie van zaterdag verplaatsen naar maandag?", "nl-BE")).toEqual({ blocked: false, matched: [] });
    expect(screenSensitive("Quels sont vos horaires d'ouverture le dimanche ?", "fr-BE")).toEqual({ blocked: false, matched: [] });
    expect(screenSensitive("What should I bring to the sauna?", "en")).toEqual({ blocked: false, matched: [] });
    expect(screenSensitive("", "en")).toEqual({ blocked: false, matched: [] });
  });

  it("uses only the given locale's keywords", () => {
    expect(screenSensitive("Ik ben zwanger.", "en").blocked).toBe(false);
    expect(screenSensitive("Ik ben zwanger.", "nl-BE").blocked).toBe(true);
  });
});

describe("screenSensitiveAll", () => {
  it("unions the matches of every locale", () => {
    const r = screenSensitiveAll("Ik ben zwanger, I have diabetes.", LOCALES);
    expect(r.blocked).toBe(true);
    expect(r.matched.sort()).toEqual(["diabetes", "zwanger*"]);
    expect(screenSensitiveAll("Opening hours?", LOCALES)).toEqual({ blocked: false, matched: [] });
  });
});
