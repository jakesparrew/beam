import { describe, expect, it } from "vitest";
import { generateTotp, generateTotpSecret, totpCounter, totpUri, verifyTotp } from "./totp";

const now = new Date("2026-11-03T20:00:15Z");

describe("totp", () => {
  it("generates a base32 secret of 32 characters", () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  it("accepts the current code and codes one step before or after", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, generateTotp(secret, now), now)).toBe(totpCounter(now));
    expect(verifyTotp(secret, generateTotp(secret, new Date(now.getTime() - 30_000)), now)).toBe(totpCounter(now) - 1);
    expect(verifyTotp(secret, generateTotp(secret, new Date(now.getTime() + 30_000)), now)).toBe(totpCounter(now) + 1);
  });

  it("refuses codes two steps away, malformed codes and wrong secrets", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, generateTotp(secret, new Date(now.getTime() - 60_000)), now)).toBeNull();
    expect(verifyTotp(secret, generateTotp(secret, new Date(now.getTime() + 61_000)), now)).toBeNull();
    expect(verifyTotp(secret, "12345", now)).toBeNull();
    expect(verifyTotp(secret, "abcdef", now)).toBeNull();
    expect(verifyTotp(generateTotpSecret(), generateTotp(secret, now), now)).toBeNull();
  });

  it("rejects a replay of the same code in the same step", () => {
    const secret = generateTotpSecret();
    const code = generateTotp(secret, now);
    const used = verifyTotp(secret, code, now);
    expect(used).not.toBeNull();
    expect(verifyTotp(secret, code, new Date(now.getTime() + 5_000), { afterCounter: used })).toBeNull();
    const next = new Date(now.getTime() + 30_000);
    expect(verifyTotp(secret, generateTotp(secret, next), next, { afterCounter: used })).toBe(used! + 1);
  });

  it("builds an otpauth URI with issuer BEAM", () => {
    const uri = totpUri(generateTotpSecret(), "owner@demo.beam.be");
    expect(uri).toMatch(/^otpauth:\/\/totp\/BEAM:owner%40demo\.beam\.be\?/);
    expect(uri).toContain("issuer=BEAM");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
