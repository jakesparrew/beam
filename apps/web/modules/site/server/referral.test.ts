/**
 * site-P9 `readReferralCode` (rule 63): the stored `beam_ref` code wins over a later `?ref=`,
 * malformed codes are ignored, and without a cookie the page view's `?ref=` is returned.
 */
import { describe, expect, it } from "vitest";
import { readReferralCode } from "./referral";
import { readReferralCode as fromApi } from "../api";

const jar = (values: Record<string, string>) => ({ get: (name: string) => (name in values ? { value: values[name]! } : undefined) });

describe("readReferralCode", () => {
  it("returns the code stored in beam_ref", () => {
    expect(readReferralCode(jar({ beam_ref: "ABCD2345" }))).toBe("ABCD2345");
    expect(readReferralCode(jar({ beam_ref: "abcd2345" }))).toBe("ABCD2345");
  });

  it("keeps the first code: the cookie wins over a later ?ref=", () => {
    expect(readReferralCode(jar({ beam_ref: "ABCD2345" }), new URLSearchParams("ref=WXYZ6789"))).toBe("ABCD2345");
  });

  it("falls back to the page view's ?ref= without a (valid) cookie", () => {
    expect(readReferralCode(jar({}), new URLSearchParams("ref=WXYZ6789"))).toBe("WXYZ6789");
    expect(readReferralCode(jar({ beam_ref: "not-a-code" }), new URLSearchParams("sku=X&ref=wxyz6789"))).toBe("WXYZ6789");
  });

  it("ignores malformed codes", () => {
    expect(readReferralCode(jar({ beam_ref: "ABCD1234" }), new URLSearchParams("ref=ABCDO345"))).toBeNull();
    expect(readReferralCode(jar({}), new URLSearchParams("ref=TOO-LONG-CODE"))).toBeNull();
    expect(readReferralCode(jar({}))).toBeNull();
  });

  it("a throwing cookie store reads as no cookie", () => {
    const broken = { get: () => { throw new Error("no request scope"); } };
    expect(readReferralCode(broken, new URLSearchParams("ref=ABCD2345"))).toBe("ABCD2345");
  });

  it("is the function site's api exposes", () => {
    expect(fromApi).toBe(readReferralCode);
  });
});
