import { describe, expect, it } from "vitest";
import {
  choicesFor,
  consentAllows,
  CONSENT_MAX_AGE_DAYS,
  CONSENT_MAX_AGE_SECONDS,
  COOKIE_INVENTORY,
  cookieNamesOf,
  cookiesToClearOnWithdraw,
  isReferralTarget,
  marketingTagIds,
  normaliseReferralCode,
  REFERRAL_MAX_AGE_SECONDS,
  referralCaptureAction,
  referralSetCookie,
  withReferralCode,
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

describe("marketing tags (R3)", () => {
  it("no marketing tag without marketing consent, and none outside production", () => {
    const off = { k: key, v: 1, a: true, m: false, t };
    expect(consentAllows(off, "marketing")).toBe(false);
    expect(consentAllows(null, "marketing")).toBe(false);
    expect(consentAllows({ ...off, m: true }, "marketing")).toBe(true);
    expect(marketingTagIds({ isProduction: false, googleAdsConversionId: "AW-1234567", metaPixelId: "1234567890" })).toEqual({ googleAdsId: null, metaPixelId: null });
  });

  it("loads only valid Google Ads and Meta Pixel ids", () => {
    expect(marketingTagIds({ isProduction: true, googleAdsConversionId: " AW-1234567 ", metaPixelId: "123456789012345" })).toEqual({ googleAdsId: "AW-1234567", metaPixelId: "123456789012345" });
    expect(marketingTagIds({ isProduction: true, googleAdsConversionId: "G-ABC123", metaPixelId: "12ab" })).toEqual({ googleAdsId: null, metaPixelId: null });
    expect(marketingTagIds({ isProduction: true, googleAdsConversionId: null, metaPixelId: undefined })).toEqual({ googleAdsId: null, metaPixelId: null });
  });

  it("withdrawing marketing clears the ad cookies and beam_ref", () => {
    expect(cookiesToClearOnWithdraw(["_ga", "_gcl_au", "_fbp", "beam_ref", "beam_consent"], { analytics: true, marketing: false })).toEqual(["_gcl_au", "_fbp", "beam_ref"]);
    expect(cookieNamesOf("marketing")).toEqual(expect.arrayContaining(["beam_ref", "_gcl_au", "_fbp"]));
    expect(cookieNamesOf("necessary")).not.toContain("beam_ref");
  });
});

describe("referral links (rule 63)", () => {
  const origin = "https://www.beam.be";

  it("accepts 8 characters of A-HJ-NP-Z2-9 and ignores malformed codes", () => {
    expect(normaliseReferralCode("ABCD2345")).toBe("ABCD2345");
    expect(normaliseReferralCode(" abcd2345 ")).toBe("ABCD2345");
    for (const bad of [null, undefined, "", "ABCD234", "ABCD23456", "ABCD2341", "ABCDO345", "ABCDI345", "ABCD-345", "%E0%A4%A", "<script>"]) {
      expect(normaliseReferralCode(bad), String(bad)).toBeNull();
    }
  });

  it("no beam_ref cookie without marketing consent; the first code wins while the cookie lives", () => {
    expect(referralCaptureAction({ code: "ABCD2345", stored: null, marketing: false })).toBe("links");
    expect(referralCaptureAction({ code: "ABCD2345", stored: null, marketing: true })).toBe("set");
    expect(referralCaptureAction({ code: "WXYZ6789", stored: "ABCD2345", marketing: true })).toBe("none");
    expect(referralCaptureAction({ code: "WXYZ6789", stored: "garbage", marketing: true })).toBe("set");
    expect(referralCaptureAction({ code: "bad", stored: null, marketing: true })).toBe("none");
    expect(referralCaptureAction({ code: "bad", stored: null, marketing: false })).toBe("none");
  });

  it("the cookie lives 30 days, Secure, SameSite=Lax, Path=/", () => {
    expect(REFERRAL_MAX_AGE_SECONDS).toBe(2_592_000);
    expect(referralSetCookie("ABCD2345")).toBe("beam_ref=ABCD2345; Path=/; Max-Age=2592000; SameSite=Lax; Secure");
  });

  it("without consent the code rides only on portal, checkout and form links", () => {
    expect(withReferralCode("/nl/account/sign-in", "ABCD2345", origin)).toBe("/nl/account/sign-in?ref=ABCD2345");
    expect(withReferralCode("/nl/account", "ABCD2345", origin)).toBe("/nl/account?ref=ABCD2345");
    expect(withReferralCode("/fr/checkout?sku=DAY&from=%2Ffr%2Fprix", "ABCD2345", origin)).toBe("/fr/checkout?sku=DAY&from=%2Ffr%2Fprix&ref=ABCD2345");
    expect(withReferralCode("/en/f/contact#top", "ABCD2345", origin)).toBe("/en/f/contact?ref=ABCD2345#top");
    expect(withReferralCode("https://www.beam.be/nl/gift", "ABCD2345", origin)).toBe("https://www.beam.be/nl/gift?ref=ABCD2345");
    for (const other of ["/nl/prijzen", "/nl/accounting", "/nl/blog/f", "https://example.com/nl/checkout", "mailto:info@example.com", "/admin/site"]) {
      expect(withReferralCode(other, "ABCD2345", origin), other).toBe(other);
    }
    expect(withReferralCode("/nl/checkout?ref=WXYZ6789", "ABCD2345", origin)).toBe("/nl/checkout?ref=WXYZ6789");
    expect(withReferralCode("/nl/checkout", "bad", origin)).toBe("/nl/checkout");
    expect(isReferralTarget("javascript:alert(1)", origin)).toBe(false);
  });
});
