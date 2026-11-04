import { describe, expect, it } from "vitest";
import { isOrderReference, newOrderReference } from "./references";
import {
  CROCKFORD_ALPHABET,
  crockfordBits,
  derivePayToken,
  deriveVoucherCode,
  hashVoucherCode,
  isVoucherCodeFormat,
  normaliseVoucherCode,
  sha256Hex,
  timingSafeEqualString,
  voucherCodeLast4,
} from "./vouchers";

const SECRET = "test-voucher-secret-not-real";
const VOUCHER_ID = "7f1d3c1e-5d2a-4b8e-9c1f-2a3b4c5d6e7f";

describe("deriveVoucherCode", () => {
  it("is stable for the same secret and voucher", async () => {
    const a = await deriveVoucherCode(SECRET, VOUCHER_ID);
    const b = await deriveVoucherCode(SECRET, VOUCHER_ID);
    expect(a).toBe(b);
  });

  it("differs per voucher and per secret", async () => {
    const a = await deriveVoucherCode(SECRET, VOUCHER_ID);
    expect(await deriveVoucherCode(SECRET, "11111111-2222-4333-8444-555555555555")).not.toBe(a);
    expect(await deriveVoucherCode("another-secret", VOUCHER_ID)).not.toBe(a);
  });

  it("has the format BEAM-XXXX-XXXX-XXXX in Crockford base32", async () => {
    const code = await deriveVoucherCode(SECRET, VOUCHER_ID);
    expect(code).toMatch(/^BEAM-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(isVoucherCodeFormat(code)).toBe(true);
  });

  it("refuses an empty secret", async () => {
    await expect(deriveVoucherCode("", VOUCHER_ID)).rejects.toThrow();
  });

  it("encodes 60 bits of the HMAC (12 characters, 5 bits each)", () => {
    expect(crockfordBits(new Uint8Array(8), 12)).toBe("000000000000");
    expect(crockfordBits(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 12)).toBe("ZZZZZZZZZZZZ");
    // 0b00001 00010 00011 ... first bytes 0x08 0x86 -> 00001 00010 000110
    expect(crockfordBits(new Uint8Array([0x08, 0x86, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), 3)).toBe("123");
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
  });
});

describe("normaliseVoucherCode", () => {
  it("upper-cases and strips spaces, dashes and the BEAM prefix", () => {
    expect(normaliseVoucherCode("beam-abcd-efgh-jkmn")).toBe("ABCDEFGHJKMN");
    expect(normaliseVoucherCode(" abcd efgh jkmn ")).toBe("ABCDEFGHJKMN");
  });

  it("reads O as 0 and I and L as 1", () => {
    expect(normaliseVoucherCode("BEAM-OOII-LLoo-ilil")).toBe("001111001111");
  });

  it("makes a mistyped code hash to the same value", async () => {
    const code = await deriveVoucherCode(SECRET, VOUCHER_ID);
    const typed = code.toLowerCase().replace(/0/g, "o").replace(/1/g, "l").replace(/-/g, " ");
    expect(await hashVoucherCode(typed)).toBe(await hashVoucherCode(code));
    expect(await hashVoucherCode(code)).toBe(await sha256Hex(normaliseVoucherCode(code)));
    expect(voucherCodeLast4(code)).toBe(code.slice(-4));
  });

  it("rejects inputs that cannot be codes", () => {
    expect(isVoucherCodeFormat("BEAM-1234")).toBe(false);
    expect(isVoucherCodeFormat("BEAM-UUUU-UUUU-UUUU")).toBe(false);
  });
});

describe("timingSafeEqualString", () => {
  it("compares strings", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
    expect(timingSafeEqualString("abc", "ab")).toBe(false);
  });
});

describe("derivePayToken (rule 41)", () => {
  it("is the same for the same order and expiry and changes with the expiry", async () => {
    const at = new Date("2026-11-17T10:00:00.000Z");
    const a = await derivePayToken(SECRET, VOUCHER_ID, at);
    expect(await derivePayToken(SECRET, VOUCHER_ID, new Date(at.getTime() + 400))).toBe(a); // epoch seconds
    expect(await derivePayToken(SECRET, VOUCHER_ID, new Date(at.getTime() + 1000))).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(a).not.toBe(await deriveVoucherCode(SECRET, VOUCHER_ID));
  });
});

describe("newOrderReference", () => {
  it("is BO- plus 8 Crockford characters", () => {
    for (let i = 0; i < 20; i++) expect(isOrderReference(newOrderReference())).toBe(true);
  });

  it("is deterministic for a seeded random source", () => {
    const seq = [0, 0.99, 0.5, 0.25, 0.031, 0.999999, 0.1, 0.75];
    let i = 0;
    expect(newOrderReference(() => seq[i++ % seq.length]!)).toBe("BO-0ZG80Z3R");
  });
});
