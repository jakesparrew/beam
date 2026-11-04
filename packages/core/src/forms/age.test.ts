import { describe, expect, it } from "vitest";
import { ageOn, brusselsDay, isUnder, MARKETING_CONSENT_AGE, SENSITIVE_CONSENT_AGE } from "./age";
import { FORM_RESULT_LINK_SAMPLE, FORM_RESULT_SAMPLE, FormResultLinkProps, FormResultProps } from "./email-props";

describe("C5: ageOn", () => {
  it("birthday today counts the new year", () => {
    expect(ageOn("2000-11-04", "2026-11-04")).toBe(26);
    expect(ageOn("2000-11-04", "2026-11-03")).toBe(25);
    expect(ageOn("2000-11-04", "2026-11-05")).toBe(26);
  });

  it("29 February: the birthday is 1 March in a common year", () => {
    expect(ageOn("2008-02-29", "2021-02-28")).toBe(12);
    expect(ageOn("2008-02-29", "2021-03-01")).toBe(13);
    expect(ageOn("2008-02-29", "2024-02-29")).toBe(16);
    expect(ageOn("2008-02-29", "2024-02-28")).toBe(15);
  });

  it("under 13 on the boundary days", () => {
    expect(isUnder("2013-11-05", "2026-11-04", MARKETING_CONSENT_AGE)).toBe(true);
    expect(isUnder("2013-11-04", "2026-11-04", MARKETING_CONSENT_AGE)).toBe(false);
    expect(isUnder("2013-11-03", "2026-11-04", MARKETING_CONSENT_AGE)).toBe(false);
  });

  it("under 16 on the boundary days", () => {
    expect(isUnder("2010-11-05", "2026-11-04", SENSITIVE_CONSENT_AGE)).toBe(true);
    expect(isUnder("2010-11-04", "2026-11-04", SENSITIVE_CONSENT_AGE)).toBe(false);
    expect(ageOn("2010-11-05", "2026-11-04")).toBe(15);
  });

  it("rejects non-ISO input", () => {
    expect(() => ageOn("04/11/2000", "2026-11-04")).toThrow(RangeError);
  });

  it("brusselsDay uses the Brussels calendar day", () => {
    expect(brusselsDay(new Date("2026-11-03T23:30:00Z"))).toBe("2026-11-04");
    expect(brusselsDay(new Date("2026-07-01T21:59:00Z"))).toBe("2026-07-01");
    expect(brusselsDay(new Date("2026-07-01T22:00:00Z"))).toBe("2026-07-02");
  });
});

describe("email props schemas", () => {
  it("the samples parse", () => {
    expect(FormResultProps.parse(FORM_RESULT_SAMPLE)).toEqual(FORM_RESULT_SAMPLE);
    expect(FormResultLinkProps.parse(FORM_RESULT_LINK_SAMPLE)).toEqual(FORM_RESULT_LINK_SAMPLE);
  });
  it("at most four CTAs, no unknown keys, URLs only", () => {
    const cta = { label: "Go", url: "https://beam.example.com/x" };
    expect(FormResultProps.safeParse({ ...FORM_RESULT_SAMPLE, ctas: [cta, cta, cta, cta, cta] }).success).toBe(false);
    expect(FormResultProps.safeParse({ ...FORM_RESULT_SAMPLE, answers: { sleep: 3 } }).success).toBe(false);
    expect(FormResultProps.safeParse({ ...FORM_RESULT_SAMPLE, resultUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(FormResultLinkProps.safeParse({ ...FORM_RESULT_LINK_SAMPLE, formTitle: "" }).success).toBe(false);
  });
});
