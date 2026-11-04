import { describe, expect, it } from "vitest";
import { claimToken, deriveClaimKey, hashToken, hkdfSha256, hmacSha256, sha256, toBase64Url, toHex } from "./claim-token";

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));

describe("primitives match the published vectors", () => {
  it("sha256 (FIPS 180-4)", () => {
    expect(toHex(sha256(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(toHex(sha256("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(toHex(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(toHex(sha256("a".repeat(1000)))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  });

  it("hmac-sha256 (RFC 4231 cases 1, 2 and 6)", () => {
    expect(toHex(hmacSha256(new Uint8Array(20).fill(0x0b), "Hi There"))).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
    expect(toHex(hmacSha256("Jefe", "what do ya want for nothing?"))).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    expect(toHex(hmacSha256(new Uint8Array(131).fill(0xaa), "Test Using Larger Than Block-Size Key - Hash Key First"))).toBe(
      "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
    );
  });

  it("hkdf-sha256 (RFC 5869 case 1)", () => {
    const okm = hkdfSha256(new Uint8Array(22).fill(0x0b), hex("000102030405060708090a0b0c"), hex("f0f1f2f3f4f5f6f7f8f9"), 42);
    expect(toHex(okm)).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
  });

  it("base64url without padding", () => {
    expect(toBase64Url(new TextEncoder().encode("f"))).toBe("Zg");
    expect(toBase64Url(new TextEncoder().encode("fo"))).toBe("Zm8");
    expect(toBase64Url(new TextEncoder().encode("foo"))).toBe("Zm9v");
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });
});

describe("claimToken and hashToken (R43)", () => {
  const key = deriveClaimKey("test-auth-secret");
  const entryId = "0b8f9c1e-6f7a-4c2d-9e3b-1a2b3c4d5e6f";

  it("is deterministic for the same entry and offer", () => {
    expect(claimToken(key, entryId, 1)).toBe(claimToken(key, entryId, 1));
    expect(claimToken(key, entryId, 1)).toBe(toBase64Url(hmacSha256(key, `claim:${entryId}:1`)));
  });

  it("differs per offers_count, per entry and per key", () => {
    expect(claimToken(key, entryId, 1)).not.toBe(claimToken(key, entryId, 2));
    expect(claimToken(key, entryId, 1)).not.toBe(claimToken(key, "another-entry", 1));
    expect(claimToken(deriveClaimKey("other-secret"), entryId, 1)).not.toBe(claimToken(key, entryId, 1));
  });

  it("is URL-safe; the stored hash is 64 hex characters", () => {
    const token = claimToken(key, entryId, 3);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(toHex(sha256(token)));
    expect(hashToken(token)).not.toBe(hashToken(claimToken(key, entryId, 4)));
  });

  it("derives a 32-byte key", () => {
    expect(key).toHaveLength(32);
  });
});
