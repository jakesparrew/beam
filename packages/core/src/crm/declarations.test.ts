import { describe, expect, it } from "vitest";
import { ageOn, declarationIsValid, guardian_consent, isMarketingConsentAllowed, isMinor } from "./declarations";

const now = new Date("2026-11-03T10:00:00Z");
const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";

describe("age of consent (rule 3.53)", () => {
  it("3.53 counts full years on the Brussels calendar date", () => {
    expect(ageOn("2013-11-03", now)).toBe(13);
    expect(ageOn("2013-11-04", now)).toBe(12);
    // 23:30 UTC on 3 November is already 4 November in Brussels.
    expect(ageOn("2013-11-04", new Date("2026-11-03T23:30:00Z"))).toBe(13);
    expect(() => ageOn("03/11/2013", now)).toThrow();
  });

  it("3.53 a 12-year-old may not give marketing consent", () => {
    expect(isMarketingConsentAllowed({ birthOn: "2014-01-15", at: now })).toBe(false);
    expect(isMarketingConsentAllowed({ birthOn: "2013-11-04", at: now })).toBe(false);
  });

  it("3.53 a 13-year-old may", () => {
    expect(isMarketingConsentAllowed({ birthOn: "2013-11-03", at: now })).toBe(true);
    expect(isMarketingConsentAllowed({ birthOn: "1980-05-01", at: now })).toBe(true);
  });

  it("3.53 without a birth date the person is treated as an adult", () => {
    expect(isMarketingConsentAllowed({ birthOn: null, at: now })).toBe(true);
    expect(isMarketingConsentAllowed({ birthOn: undefined, at: now })).toBe(true);
    expect(isMinor(null, now)).toBe(false);
    expect(isMinor("2010-01-01", now)).toBe(true);
    expect(isMinor("2008-11-03", now)).toBe(false);
  });
});

describe("guardian consent (rule 3.54)", () => {
  it("3.54 the only declaration kind is guardian_consent", () => {
    expect(guardian_consent).toBe("guardian_consent");
  });

  const accepted = (documentVersionId: string, expiresAt: Date | null = null) => ({ status: "accepted" as const, documentVersionId, expiresAt });

  it("3.54 an acceptance of the current version is valid", () => {
    expect(declarationIsValid({ latest: accepted(V2), currentVersionId: V2, requiresReacceptance: true, now })).toBe(true);
    expect(declarationIsValid({ latest: accepted(V2), currentVersionId: V2, requiresReacceptance: false, now })).toBe(true);
  });

  it("3.54 an older version stays valid when the new one needs no re-acceptance", () => {
    expect(declarationIsValid({ latest: accepted(V1), currentVersionId: V2, requiresReacceptance: false, now })).toBe(true);
  });

  it("3.54 a new version that requires re-acceptance invalidates older acceptances", () => {
    expect(declarationIsValid({ latest: accepted(V1), currentVersionId: V2, requiresReacceptance: true, now })).toBe(false);
  });

  it("3.54 a revoked consent is invalid, also for the current version", () => {
    expect(declarationIsValid({ latest: { status: "revoked", documentVersionId: V2, expiresAt: null }, currentVersionId: V2, requiresReacceptance: false, now })).toBe(false);
  });

  it("3.54 no declaration, no published version or an expired one is invalid", () => {
    expect(declarationIsValid({ latest: null, currentVersionId: V2, requiresReacceptance: false, now })).toBe(false);
    expect(declarationIsValid({ latest: accepted(V2), currentVersionId: null, requiresReacceptance: false, now })).toBe(false);
    expect(declarationIsValid({ latest: accepted(V2, new Date("2026-11-01T00:00:00Z")), currentVersionId: V2, requiresReacceptance: false, now })).toBe(false);
    expect(declarationIsValid({ latest: accepted(V2, new Date("2026-12-01T00:00:00Z")), currentVersionId: V2, requiresReacceptance: false, now })).toBe(true);
  });
});
