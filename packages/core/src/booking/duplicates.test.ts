import { describe, expect, it } from "vitest";
import { deriveIpSalt, duplicateSignals, hashIp, normaliseEmail, normalisePhone, type DupCandidate } from "./duplicates";

const T0 = new Date("2026-11-03T10:00:00Z");
const H = 3_600_000;
const cand = (p: Partial<DupCandidate> = {}): DupCandidate => ({
  id: "e-new",
  personId: "p-new",
  emailNormalised: null,
  phone: null,
  lastName: null,
  birthOn: null,
  joinIpHash: null,
  joinedAt: T0,
  queue: "lead",
  ...p,
});

describe("normaliseEmail (edge case 16)", () => {
  it("removes gmail dots and plus tags and lower-cases", () => {
    expect(normaliseEmail("J.Doe+beam@Gmail.com")).toBe("jdoe@gmail.com");
    expect(normaliseEmail("j.d.o.e@googlemail.com")).toBe("jdoe@gmail.com");
  });
  it("removes plus tags but keeps dots on other domains", () => {
    expect(normaliseEmail("  Jane.Doe+news@Example.com ")).toBe("jane.doe@example.com");
  });
  it("leaves malformed input lower-cased", () => {
    expect(normaliseEmail("NotAnEmail")).toBe("notanemail");
  });
});

describe("normalisePhone", () => {
  it("reads national, 00 and + forms the same", () => {
    expect(normalisePhone("0470 12 34 56")).toBe("+32470123456");
    expect(normalisePhone("0032 470/12.34.56")).toBe("+32470123456");
    expect(normalisePhone("+32 (470) 12-34-56")).toBe("+32470123456");
  });
});

describe("duplicateSignals (R48, edge case 15)", () => {
  it("is clean without matches and ignores the same person", () => {
    expect(duplicateSignals(cand({ emailNormalised: "a@example.com" }), [cand({ id: "e2", personId: "p2", emailNormalised: "b@example.com" })])).toEqual([]);
    expect(duplicateSignals(cand({ emailNormalised: "a@example.com" }), [cand({ id: "e2", emailNormalised: "a@example.com" })])).toEqual([]);
  });

  it("flags the same normalised email", () => {
    const signals = duplicateSignals(cand({ emailNormalised: normaliseEmail("j.doe+x@gmail.com") }), [cand({ id: "e2", personId: "p2", emailNormalised: normaliseEmail("jdoe@gmail.com") })]);
    expect(signals).toEqual(["same_normalised_email:e2"]);
  });

  it("flags the same phone in another notation", () => {
    expect(duplicateSignals(cand({ phone: "0470 12 34 56" }), [cand({ id: "e2", personId: "p2", phone: "+32470123456" })])).toEqual(["same_phone:e2"]);
  });

  it("flags the same last name and birth date only when both are present", () => {
    const others = [cand({ id: "e2", personId: "p2", lastName: "Peeters", birthOn: "1990-04-01" })];
    expect(duplicateSignals(cand({ lastName: " peeters ", birthOn: "1990-04-01" }), others)).toEqual(["same_name_birth:e2"]);
    expect(duplicateSignals(cand({ lastName: "Peeters", birthOn: null }), others)).toEqual([]);
    expect(duplicateSignals(cand({ lastName: "Peeters", birthOn: "1990-04-02" }), others)).toEqual([]);
  });

  it("flags the same IP hash within 24 h in the lead queue only", () => {
    const other = cand({ id: "e2", personId: "p2", joinIpHash: "abc", joinedAt: new Date(T0.getTime() - 23 * H) });
    expect(duplicateSignals(cand({ joinIpHash: "abc" }), [other])).toEqual(["same_ip:e2"]);
    expect(duplicateSignals(cand({ joinIpHash: "abc" }), [{ ...other, joinedAt: new Date(T0.getTime() - 25 * H) }])).toEqual([]);
    expect(duplicateSignals(cand({ joinIpHash: "abc", queue: "public" }), [{ ...other, queue: "public" }])).toEqual([]);
    expect(duplicateSignals(cand({ joinIpHash: null }), [other])).toEqual([]);
  });

  it("reports several signals and several others", () => {
    const signals = duplicateSignals(cand({ emailNormalised: "x@example.com", phone: "0470000000" }), [
      cand({ id: "e2", personId: "p2", emailNormalised: "x@example.com" }),
      cand({ id: "b3", personId: "p3", phone: "+32470000000" }),
    ]);
    expect(signals).toEqual(["same_normalised_email:e2", "same_phone:b3"]);
  });
});

describe("hashIp", () => {
  const salt = deriveIpSalt("test-auth-secret");
  it("is a stable sha256 hex, null without an IP", () => {
    expect(hashIp("203.0.113.7", salt)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIp("203.0.113.7", salt)).toBe(hashIp("203.0.113.7", salt));
    expect(hashIp("203.0.113.8", salt)).not.toBe(hashIp("203.0.113.7", salt));
    expect(hashIp("203.0.113.7", deriveIpSalt("other"))).not.toBe(hashIp("203.0.113.7", salt));
    expect(hashIp(null, salt)).toBeNull();
  });
});
