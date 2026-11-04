import { describe, expect, it } from "vitest";
import { emailHash, gmailCanonical, normaliseEmail, normalisePhone, normaliseVat, sha256Hex } from "./normalise";

describe("normaliseEmail (rule 3.1)", () => {
  it("3.1 trims and lower-cases; empty and malformed become null", () => {
    expect(normaliseEmail("  Ann.Peeters@Example.COM ")).toBe("ann.peeters@example.com");
    expect(normaliseEmail("")).toBeNull();
    expect(normaliseEmail("   ")).toBeNull();
    expect(normaliseEmail("not-an-email")).toBeNull();
    expect(normaliseEmail("a@b")).toBeNull();
    expect(normaliseEmail(null)).toBeNull();
  });
});

describe("emailHash", () => {
  it("is the sha256 hex of the normalised address", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("a".repeat(1000))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
    expect(emailHash(" Ann@Example.com ")).toBe(emailHash("ann@example.com"));
    expect(emailHash("ann@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("gmailCanonical (rule 3.28)", () => {
  it("3.28 removes dots and +tag for gmail.com and googlemail.com", () => {
    expect(gmailCanonical("Ann.Peeters+beam@gmail.com")).toBe("annpeeters@gmail.com");
    expect(gmailCanonical("a.n.n@googlemail.com")).toBe("ann@gmail.com");
    expect(gmailCanonical("ann+x@googlemail.com")).toBe(gmailCanonical("ANN@gmail.com"));
  });

  it("3.28 leaves other domains unchanged apart from case", () => {
    expect(gmailCanonical("Ann.Peeters+beam@example.com")).toBe("ann.peeters+beam@example.com");
  });
});

describe("normalisePhone (rule 3.7)", () => {
  it("3.7 reads Belgian national formats", () => {
    expect(normalisePhone("0470 12 34 56")).toBe("+32470123456");
    expect(normalisePhone("0470/12.34.56")).toBe("+32470123456");
    expect(normalisePhone("02 123 45 67")).toBe("+3221234567");
    expect(normalisePhone("09-123-45-67")).toBe("+3291234567");
    expect(normalisePhone("470 12 34 56")).toBe("+32470123456");
  });

  it("3.7 reads 0032 and +32, with or without the trunk zero", () => {
    expect(normalisePhone("0032 470 12 34 56")).toBe("+32470123456");
    expect(normalisePhone("+32 470 12 34 56")).toBe("+32470123456");
    expect(normalisePhone("+32 (0)470 12 34 56")).toBe("+32470123456");
    expect(normalisePhone("+320470123456")).toBe("+32470123456");
  });

  it("3.7 reads foreign international numbers and other default countries", () => {
    expect(normalisePhone("+31 6 12345678")).toBe("+31612345678");
    expect(normalisePhone("06 12345678", "NL")).toBe("+31612345678");
    expect(normalisePhone("+33 6 12 34 56 78")).toBe("+33612345678");
  });

  it("3.7 returns null for unparseable values", () => {
    expect(normalisePhone("call me")).toBeNull();
    expect(normalisePhone("0470 12")).toBeNull();
    expect(normalisePhone("")).toBeNull();
    expect(normalisePhone(null)).toBeNull();
    expect(normalisePhone("12345")).toBeNull();
    expect(normalisePhone("+32 470 12 34 56 78 90")).toBeNull();
    expect(normalisePhone("0470 12 34 56", "ZZ")).toBeNull();
  });
});

describe("normaliseVat (rule 3.45)", () => {
  it("3.45 normalises Belgian forms to BE0123456789", () => {
    expect(normaliseVat("BE 0123.456.789")).toBe("BE0123456789");
    expect(normaliseVat("be0123456789")).toBe("BE0123456789");
    expect(normaliseVat("0123.456.789")).toBe("BE0123456789");
    expect(normaliseVat("123456789")).toBe("BE0123456789");
    expect(normaliseVat("BE123456789")).toBe("BE0123456789");
    expect(normaliseVat("BE 1234-567-890")).toBe("BE1234567890");
  });

  it("3.45 keeps other EU numbers and refuses junk", () => {
    expect(normaliseVat("nl 8536.12.345.B01")).toBe("NL853612345B01");
    expect(normaliseVat("FR12345678901")).toBe("FR12345678901");
    expect(normaliseVat("BE2123456789")).toBeNull();
    expect(normaliseVat("12")).toBeNull();
    expect(normaliseVat("")).toBeNull();
    expect(normaliseVat("hello world")).toBeNull();
  });
});
