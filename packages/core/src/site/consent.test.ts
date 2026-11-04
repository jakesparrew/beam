import { describe, expect, it } from "vitest";
import {
  choicesFor,
  consentAllows,
  CONSENT_MAX_AGE_DAYS,
  CONSENT_MAX_AGE_SECONDS,
  COOKIE_INVENTORY,
  cookiesToClearOnWithdraw,
  decodeConsentCookie,
  encodeConsentCookie,
  needsConsentPrompt,
  type ConsentCookie,
} from "./consent";

const key = "8c6a8f9e-2d4b-4f1a-9b3c-5e6d7f8a9b0c";
const now = new Date("2026-11-03T12:00:00Z");
const t = Math.floor(now.getTime() / 1000);
const cookie: ConsentCookie = { k: key, v: 2, a: true, m: false, t };

describe("consent cookie", () => {
  it("encodes and decodes {k, v, a, m, t}", () => {
    const value = encodeConsentCookie(cookie);
    expect(value).toBe(`${key}.2.1.0.${t}`);
    expect(decodeConsentCookie(value)).toEqual(cookie);
    expect(decodeConsentCookie(encodeURIComponent(value))).toEqual(cookie);
  });

  it("rejects malformed values", () => {
    for (const bad of [null, "", "x", `${key}.2.1.0`, `not-a-uuid.2.1.0.${t}`, `${key}.2.yes.0.${t}`, `${key}.-1.1.0.${t}`]) {
      expect(decodeConsentCookie(bad), String(bad)).toBeNull();
    }
  });

  it("lives 182 days", () => {
    expect(CONSENT_MAX_AGE_DAYS).toBe(182);
    expect(CONSENT_MAX_AGE_SECONDS).toBe(15724800);
    const at = (days: number) => new Date(now.getTime() + days * 86_400_000);
    expect(needsConsentPrompt(cookie, { now: at(181), latestMaterialOrdinal: null })).toBe(false);
    expect(needsConsentPrompt(cookie, { now: at(183), latestMaterialOrdinal: null })).toBe(true);
  });

  it("re-prompts when no cookie exists or a newer material cookie notice is published", () => {
    expect(needsConsentPrompt(null, { now, latestMaterialOrdinal: null })).toBe(true);
    expect(needsConsentPrompt(cookie, { now, latestMaterialOrdinal: 2 })).toBe(false);
    expect(needsConsentPrompt(cookie, { now, latestMaterialOrdinal: 3 })).toBe(true);
    expect(needsConsentPrompt(cookie, { now, latestMaterialOrdinal: 1 })).toBe(false);
  });

  it("maps actions to choices and gates categories", () => {
    expect(choicesFor("accept_all")).toEqual({ analytics: true, marketing: true });
    expect(choicesFor("reject_all")).toEqual({ analytics: false, marketing: false });
    expect(choicesFor("custom", { analytics: true, marketing: false })).toEqual({ analytics: true, marketing: false });
    expect(consentAllows(cookie, "analytics")).toBe(true);
    expect(consentAllows(cookie, "marketing")).toBe(false);
    expect(consentAllows(null, "necessary")).toBe(true);
    expect(consentAllows(null, "analytics")).toBe(false);
  });

  it("withdrawing analytics clears the _ga cookies", () => {
    expect(cookiesToClearOnWithdraw(["_ga", "_ga_ABC123", "NEXT_LOCALE", "beam_consent"], { analytics: false, marketing: false })).toEqual(["_ga", "_ga_ABC123"]);
  });

  it("the inventory lists every cookie of privacy section 9 with a category", () => {
    const names = COOKIE_INVENTORY.map((c) => c.name);
    for (const n of ["beam_consent", "NEXT_LOCALE", "_ga", "_ga_<id>", "beam_ref", "_gcl_au", "_fbp"]) expect(names).toContain(n);
    expect(COOKIE_INVENTORY.find((c) => c.name === "beam_consent")).toMatchObject({ category: "necessary", maxAgeDays: 182 });
    expect(COOKIE_INVENTORY.find((c) => c.name === "beam_ref")).toMatchObject({ category: "marketing", maxAgeDays: 30 });
    expect(new Set(names).size).toBe(names.length);
  });
});
