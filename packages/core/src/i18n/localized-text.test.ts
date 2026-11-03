import { describe, expect, it } from "vitest";
import { MissingTranslationError, PermanentError } from "../errors";
import {
  assertComplete,
  completeLocalizedText,
  isComplete,
  LocalizedTextSchema,
  missingLocales,
  pick,
} from "./localized-text";

describe("LocalizedText", () => {
  it("treats a whitespace-only value as missing", () => {
    const text = { "nl-BE": "Yoga", "fr-BE": "   ", en: "\n\t" };
    expect(missingLocales(text)).toEqual(["fr-BE", "en"]);
    expect(isComplete(text)).toBe(false);
  });

  it("an empty string and an absent key are missing too", () => {
    expect(missingLocales({ "nl-BE": "", en: "Yoga" })).toEqual(["nl-BE", "fr-BE"]);
    expect(missingLocales(null)).toEqual(["nl-BE", "fr-BE", "en"]);
  });

  it("checks only the requested locales", () => {
    expect(isComplete({ "nl-BE": "Yoga" }, ["nl-BE"])).toBe(true);
    expect(missingLocales({ "nl-BE": "Yoga" }, ["en", "nl-BE"])).toEqual(["en"]);
  });

  it("assertComplete throws MissingTranslationError with the missing locales", () => {
    let caught: unknown;
    try {
      assertComplete({ "nl-BE": "Yoga", "fr-BE": " ", en: "Yoga" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingTranslationError);
    expect(caught).toBeInstanceOf(PermanentError);
    expect((caught as MissingTranslationError).missing).toEqual(["fr-BE"]);
    expect(() => assertComplete({ "nl-BE": "a", "fr-BE": "b", en: "c" })).not.toThrow();
  });

  it("pick never falls back to another locale", () => {
    expect(pick({ en: "Hello" }, "en")).toBe("Hello");
    expect(() => pick({ en: "Hello" }, "nl-BE")).toThrow(MissingTranslationError);
  });

  it("the schema rejects unknown locales and the complete schema rejects blanks", () => {
    expect(LocalizedTextSchema.safeParse({ de: "Hallo" }).success).toBe(false);
    expect(LocalizedTextSchema.safeParse({ "nl-BE": "" }).success).toBe(true);
    const complete = completeLocalizedText();
    expect(complete.safeParse({ "nl-BE": "a", "fr-BE": " ", en: "c" }).success).toBe(false);
    expect(complete.safeParse({ "nl-BE": "a", "fr-BE": "b", en: "c" }).success).toBe(true);
  });
});
