import { hash } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import { checkPasswordPolicy, hashPassword, needsRehash, verifyPassword } from "./password";

describe("password hashing (PL-2)", () => {
  it("hashes with argon2id and the OWASP parameters, and verifies", async () => {
    const phc = await hashPassword("correct horse battery staple");
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword("correct horse battery staple", phc)).toBe(true);
    expect(await verifyPassword("wrong horse battery staple", phc)).toBe(false);
    expect(needsRehash(phc)).toBe(false);
  });

  it("flags a hash made with weaker parameters for rehash", async () => {
    const weak = await hash("correct horse battery staple", { memoryCost: 4096, timeCost: 1, parallelism: 1 });
    expect(await verifyPassword("correct horse battery staple", weak)).toBe(true);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash("$2b$10$abcdefghijklmnopqrstuv")).toBe(true);
  });

  it("treats a missing or malformed hash as a mismatch", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
  });
});

describe("password policy (PL-1, PL-13)", () => {
  it("accepts a long, strong staff password", async () => {
    expect(await checkPasswordPolicy("Velvet-Lantern-Orbit-93!", { audience: "staff", email: "owner@demo.beam.be" })).toEqual({ ok: true, reasons: [] });
  });

  it("refuses an 11-character staff password", async () => {
    const result = await checkPasswordPolicy("Kq7#mZ2!pXw", { audience: "staff", email: "owner@demo.beam.be" });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("too_short");
  });

  it("refuses a staff password with a zxcvbn score of 2", async () => {
    // Long enough, but a dictionary word plus digits: zxcvbn scores it 2 or lower.
    const result = await checkPasswordPolicy("password12345", { audience: "staff", email: "owner@demo.beam.be" });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("too_weak");
  });

  it("refuses a password equal to the email", async () => {
    const result = await checkPasswordPolicy("lotte.peeters@example.com", { audience: "customer", email: "Lotte.Peeters@example.com" });
    expect(result.reasons).toContain("same_as_email");
  });

  it("applies the customer policy: 10 characters and score 2", async () => {
    expect((await checkPasswordPolicy("Kq7#mZ2!pX", { audience: "customer", email: "a@example.com" })).ok).toBe(true);
    expect((await checkPasswordPolicy("Kq7#mZ2!p", { audience: "customer", email: "a@example.com" })).reasons).toContain("too_short");
    expect((await checkPasswordPolicy("aaaaaaaaaa", { audience: "customer", email: "a@example.com" })).reasons).toContain("too_weak");
    // A 10-character password is fine for a customer but too short for staff.
    expect((await checkPasswordPolicy("Kq7#mZ2!pX", { audience: "staff", email: "a@example.com" })).reasons).toContain("too_short");
  });
});
