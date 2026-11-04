import { describe, expect, it } from "vitest";
import { cleanLandingPath, cleanReferrer, cleanValue, deriveFunnel, deriveSource, hostOf, readUtm } from "./attribution";

const base = { utm: {}, embedHostIsBeam: true as boolean | null };

describe("A2: deriveSource, first match wins", () => {
  it("(1) an explicit src wins over the link", () => {
    expect(deriveSource({ ...base, src: "webinar", linkChannel: "qr" }).source).toBe("webinar");
    expect(deriveSource({ ...base, src: " Walk_In " }).source).toBe("walk_in");
    expect(deriveSource({ ...base, src: "manual", utm: { medium: "cpc", source: "ig" } }).source).toBe("manual");
  });
  it("an unknown or guest src is ignored", () => {
    expect(deriveSource({ ...base, src: "tiktok", linkChannel: "qr" }).source).toBe("qr_code");
    expect(deriveSource({ ...base, src: "guest" }).source).toBe("website");
  });
  it("(2) link channel: qr and print -> qr_code, partner, referral, b2b", () => {
    expect(deriveSource({ ...base, linkChannel: "qr" }).source).toBe("qr_code");
    expect(deriveSource({ ...base, linkChannel: "print" }).source).toBe("qr_code");
    expect(deriveSource({ ...base, linkChannel: "partner" }).source).toBe("partner");
    expect(deriveSource({ ...base, linkChannel: "referral" }).source).toBe("referral");
    expect(deriveSource({ ...base, linkChannel: "b2b" }).source).toBe("b2b_campaign");
    expect(deriveSource({ ...base, linkChannel: "link", utm: { medium: "social" } }).source).toBe("social_media");
    expect(deriveSource({ ...base, linkChannel: "print", utm: { medium: "cpc", source: "ig" } }).source).toBe("qr_code");
  });
  it("(3) paid media: ig + cpc -> paid_meta, google -> paid_google, other -> paid_other", () => {
    expect(deriveSource({ ...base, utm: { source: "ig", medium: "cpc" } }).source).toBe("paid_meta");
    expect(deriveSource({ ...base, utm: { source: "Facebook", medium: "Paid_Social" } }).source).toBe("paid_meta");
    expect(deriveSource({ ...base, utm: { source: "youtube", medium: "ppc" } }).source).toBe("paid_google");
    expect(deriveSource({ ...base, utm: { source: "linkedin", medium: "paid" } }).source).toBe("paid_other");
    expect(deriveSource({ ...base, utm: { medium: "cpc" } }).source).toBe("paid_other");
  });
  it("(4) social, (5) b2b media", () => {
    expect(deriveSource({ ...base, utm: { medium: "organic_social", source: "ig" } }).source).toBe("social_media");
    expect(deriveSource({ ...base, utm: { medium: "b2b" } }).source).toBe("b2b_campaign");
  });
  it("(6) organic medium or a search referrer", () => {
    expect(deriveSource({ ...base, utm: { medium: "seo" } }).source).toBe("organic_search");
    expect(deriveSource({ ...base, referrerHost: "www.google.be" }).source).toBe("organic_search");
    expect(deriveSource({ ...base, referrerHost: "duckduckgo.com" }).source).toBe("organic_search");
    expect(deriveSource({ ...base, referrerHost: "search.ecosia.org" }).source).toBe("organic_search");
    expect(deriveSource({ ...base, referrerHost: "example.com" }).source).toBe("website");
  });
  it("(7) a landing page or a foreign embed -> landing_page", () => {
    expect(deriveSource({ ...base, landingPathKind: "landing" }).source).toBe("landing_page");
    expect(deriveSource({ ...base, embedHostIsBeam: false }).source).toBe("landing_page");
    expect(deriveSource({ ...base, embedHostIsBeam: null, landingPathKind: "other" }).source).toBe("website");
  });
  it("(8) utm_medium=email -> website with medium email", () => {
    expect(deriveSource({ ...base, utm: { medium: "Email", campaign: "Spring" } })).toEqual({ source: "website", campaign: "Spring", medium: "email" });
    expect(deriveSource(base)).toEqual({ source: "website", campaign: null, medium: null });
  });
  it("campaign = utm_campaign or the link name", () => {
    expect(deriveSource({ ...base, linkChannel: "qr", linkName: "Flyer Ghent station" }).campaign).toBe("Flyer Ghent station");
    expect(deriveSource({ ...base, linkName: "Flyer", utm: { campaign: "spring-26" } }).campaign).toBe("spring-26");
  });
});

describe("A1 and A6 helpers", () => {
  it("cleanValue trims to 100 characters and lower-cases on request", () => {
    expect(cleanValue(`  ${"A".repeat(120)} `)).toBe("A".repeat(100));
    expect(cleanValue(" IG ", true)).toBe("ig");
    expect(cleanValue("   ")).toBeUndefined();
    expect(cleanValue(undefined)).toBeUndefined();
  });
  it("readUtm: URL values first, link defaults fill only missing values", () => {
    const params = new URLSearchParams("utm_source=IG&utm_medium=CPC&utm_campaign=Spring&utm_term=");
    expect(readUtm(params, { campaign: "default", content: "flyer", term: "t" })).toEqual({ source: "ig", medium: "cpc", campaign: "Spring", term: "t", content: "flyer" });
    expect(readUtm({ utm_content: "x" })).toEqual({ content: "x" });
  });
  it("deriveFunnel", () => {
    expect(deriveFunnel(undefined, "recovery-check")).toBe("form:recovery-check");
    expect(deriveFunnel("recovery-assessment", "recovery-check")).toBe("recovery-assessment");
  });
  it("hostOf, cleanReferrer and cleanLandingPath", () => {
    expect(hostOf("https://WWW.Google.be/search?q=x")).toBe("www.google.be");
    expect(hostOf("partner.example.com")).toBe("partner.example.com");
    expect(hostOf("")).toBeNull();
    expect(hostOf("http://")).toBeNull();
    expect(cleanReferrer("https://example.com/a/b?email=x@example.com#top")).toBe("https://example.com/a/b");
    expect(cleanReferrer("javascript:alert(1)")).toBeNull();
    expect(cleanReferrer("not a url")).toBeNull();
    expect(cleanReferrer(null)).toBeNull();
    expect(cleanReferrer(`https://example.com/${"a".repeat(600)}`)).toHaveLength(500);
    expect(cleanLandingPath("/nl/sleep?utm_source=x#a")).toBe("/nl/sleep");
    expect(cleanLandingPath("https://example.com/en/page?x=1")).toBe("/en/page");
    expect(cleanLandingPath("nl/page")).toBe("/nl/page");
    expect(cleanLandingPath("https://")).toBeNull();
    expect(cleanLandingPath("")).toBeNull();
    expect(cleanLandingPath(`/${"a".repeat(400)}`)).toHaveLength(300);
  });
});
