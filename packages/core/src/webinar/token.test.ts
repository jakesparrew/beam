import { afterEach, describe, expect, it, vi } from "vitest";
import { hmacSha256, toBase64Url } from "../booking/claim-token";
import {
  constantTimeEqual,
  deriveAccessKey,
  deriveCtaKey,
  hashAccessToken,
  isCurrentToken,
  signAccessToken,
  signCtaClick,
  tokenInternals,
  verifyAccessToken,
  verifyCtaClick,
} from "./token";

const SECRET = "test-auth-secret-of-at-least-32-characters";
const key = deriveAccessKey(SECRET);
const REG = "3f2b8c1e-7a4d-4e9b-9c2a-5d6e7f8a9b0c";

afterEach(() => vi.restoreAllMocks());

describe("access token (rule 19)", () => {
  it("round trips the registration id and version", () => {
    const token = signAccessToken(key, REG, 3);
    expect(token).toMatch(/^[0-9a-f-]{36}\.3\.[A-Za-z0-9_-]{32}$/);
    expect(verifyAccessToken(key, token)).toEqual({ registrationId: REG, version: 3 });
  });

  it("the MAC is base64url(HMAC-SHA256(k, id.version)) cut to 32 characters", () => {
    const mac = toBase64Url(hmacSha256(key, `${REG}.1`)).slice(0, 32);
    expect(signAccessToken(key, REG, 1)).toBe(`${REG}.1.${mac}`);
  });

  it("derives distinct keys for access and CTA signatures", () => {
    expect(deriveAccessKey(SECRET)).toEqual(key);
    expect(Buffer.from(deriveCtaKey(SECRET)).equals(Buffer.from(key))).toBe(false);
    expect(Buffer.from(deriveAccessKey("another-secret")).equals(Buffer.from(key))).toBe(false);
  });

  it("rejects a tampered MAC, id or version", () => {
    const token = signAccessToken(key, REG, 1);
    const [id, , mac] = token.split(".") as [string, string, string];
    const flipped = (mac[0] === "A" ? "B" : "A") + mac.slice(1);
    expect(verifyAccessToken(key, `${id}.1.${flipped}`)).toBeNull();
    expect(verifyAccessToken(key, `${id}.2.${mac}`)).toBeNull();
    expect(verifyAccessToken(key, `${REG.replace("3f2b", "3f2c")}.1.${mac}`)).toBeNull();
    expect(verifyAccessToken(deriveAccessKey("another-secret"), token)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    for (const bad of ["", "abc", `${REG}.1`, `${REG}.0.${"a".repeat(32)}`, `${REG}.x.${"a".repeat(32)}`, `not-a-uuid.1.${"a".repeat(32)}`, `${REG}.1.${"a".repeat(32)}.extra`]) {
      expect(verifyAccessToken(key, bad), bad).toBeNull();
    }
  });

  it("an old version verifies but is no longer the current link", () => {
    const old = signAccessToken(key, REG, 1);
    const current = signAccessToken(key, REG, 2);
    const row = { tokenVersion: 2, accessTokenHash: hashAccessToken(current) };
    const verifiedOld = verifyAccessToken(key, old)!;
    expect(verifiedOld.version).toBe(1);
    expect(isCurrentToken(verifiedOld, row, old)).toBe(false);
    expect(isCurrentToken(verifyAccessToken(key, current)!, row, current)).toBe(true);
  });

  it("stores sha256 hex of the token", () => {
    expect(hashAccessToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("verification uses the constant-time compare", () => {
    const spy = vi.spyOn(tokenInternals, "equal");
    const token = signAccessToken(key, REG, 1);
    verifyAccessToken(key, token);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe(token.split(".")[2]);
  });

  it("constantTimeEqual compares every character, lengths included", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("refuses to sign a bad id or version", () => {
    expect(() => signAccessToken(key, "x", 1)).toThrow();
    expect(() => signAccessToken(key, REG, 0)).toThrow();
  });
});

describe("CTA click signature (rule 36)", () => {
  const ctaKey = deriveCtaKey(SECRET);
  const CTA = "8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

  it("is 22 base64url characters and verifies only for the same parameters", () => {
    const sig = signCtaClick(ctaKey, REG, CTA, "live");
    expect(sig).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(verifyCtaClick(ctaKey, REG, CTA, "live", sig)).toBe(true);
    expect(verifyCtaClick(ctaKey, REG, CTA, "replay", sig)).toBe(false);
    expect(verifyCtaClick(key, REG, CTA, "live", sig)).toBe(false);
    expect(verifyCtaClick(ctaKey, REG, CTA, "live", sig.slice(1))).toBe(false);
  });
});
