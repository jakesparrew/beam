import { describe, expect, it } from "vitest";
import {
  assertAttributionTransition,
  assertCommissionTransition,
  ATTRIBUTION_TRANSITIONS,
  brusselsMonthStart,
  brusselsYear,
  canTransitionAttribution,
  canTransitionCommission,
  commissionBase,
  commissionFor,
  commissionUntilFor,
  generateReferralCode,
  isSelfReferral,
  isValidReferralCode,
  normalizePhone,
  normalizeReferralCode,
  qualifiesAtFor,
  REFERRAL_ATTRIBUTION_STATUSES,
  REFERRAL_CODE_ALPHABET,
  referralKeys,
  referralShareUrl,
  REFERRALS_SETTINGS_DEFAULTS,
  ReferralsSettings,
  refundCommissionBase,
} from "./referrals";

/** A deterministic PRNG (mulberry32). */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("referral codes (rule 60)", () => {
  it("are 8 characters of A-HJ-NP-Z2-9 and match the table check", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateReferralCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect(isValidReferralCode(code)).toBe(true);
    }
    expect(REFERRAL_CODE_ALPHABET).not.toMatch(/[IO01]/);
    expect(REFERRAL_CODE_ALPHABET).toHaveLength(32);
  });

  it("are practically unique and reproducible from a seeded source", () => {
    const rand = prng(20261103);
    const codes = new Set(Array.from({ length: 5000 }, () => generateReferralCode(rand)));
    expect(codes.size).toBe(5000);
    expect(generateReferralCode(prng(7))).toBe(generateReferralCode(prng(7)));
    expect(generateReferralCode(() => 0.999999999)).toBe("99999999");
    expect(generateReferralCode(() => 0)).toBe("AAAAAAAA");
  });

  it("normalise to upper case; the format check is 6 to 12 of A-Z0-9", () => {
    expect(normalizeReferralCode("  beam2026 ")).toBe("BEAM2026");
    expect(isValidReferralCode("ABCDE")).toBe(false);
    expect(isValidReferralCode("ABCDEF")).toBe(true);
    expect(isValidReferralCode("ABCDEFGHIJKL")).toBe(true);
    expect(isValidReferralCode("ABCDEFGHIJKLM")).toBe(false);
    expect(isValidReferralCode("abcdef")).toBe(false);
    expect(isValidReferralCode("ABC-DEF")).toBe(false);
  });
});

describe("self-referral (rule 61)", () => {
  const a = { personId: "a", email: "Anna@Example.com", phone: "+32 470 12 34 56" };
  it("is the same person, the same lower-case email or the same phone", () => {
    expect(isSelfReferral(a, { personId: "a" })).toBe(true);
    expect(isSelfReferral(a, { personId: "b", email: "anna@example.com " })).toBe(true);
    expect(isSelfReferral(a, { personId: "b", phone: "0470123456" })).toBe(true);
    expect(isSelfReferral(a, { personId: "b", phone: "0032 470 12 34 56" })).toBe(true);
    expect(isSelfReferral(a, { personId: "b", email: "bert@example.com", phone: "0470999999" })).toBe(false);
  });
  it("never matches on missing values", () => {
    expect(isSelfReferral({ personId: "a", email: null, phone: null }, { personId: "b", email: null, phone: "" })).toBe(false);
    expect(normalizePhone("12")).toBe("");
  });
});

describe("commission (rule 63)", () => {
  it("is round_half_up(base * pct / 100), symmetric for refunds", () => {
    expect(commissionFor({ baseCents: 10000, pct: "10.00" })).toBe(1000);
    expect(commissionFor({ baseCents: 8264, pct: "12.50" })).toBe(1033);
    expect(commissionFor({ baseCents: 5, pct: "10.00" })).toBe(1); // 0.5 rounds up
    expect(commissionFor({ baseCents: 4, pct: "10.00" })).toBe(0);
    expect(commissionFor({ baseCents: -8264, pct: "12.50" })).toBe(-1033);
    expect(commissionFor({ baseCents: 10000, pct: 0 })).toBe(0);
    expect(() => commissionFor({ baseCents: 1, pct: "101" })).toThrow();
    expect(() => commissionFor({ baseCents: 1.5, pct: "10" })).toThrow();
  });
  it("uses the order total excluding VAT; a refund takes its share of it", () => {
    expect(commissionBase({ totalCents: 12100, vatCents: 2100 })).toBe(10000);
    expect(refundCommissionBase({ refundCents: 12100, orderTotalCents: 12100, orderVatCents: 2100 })).toBe(-10000);
    expect(refundCommissionBase({ refundCents: 6050, orderTotalCents: 12100, orderVatCents: 2100 })).toBe(-5000);
    expect(refundCommissionBase({ refundCents: 99999, orderTotalCents: 12100, orderVatCents: 2100 })).toBe(-10000);
    expect(refundCommissionBase({ refundCents: 100, orderTotalCents: 0, orderVatCents: 0 })).toBe(0);
  });
});

describe("windows and months", () => {
  it("qualifies 14 days after the first payment; commission runs 12 months", () => {
    const paid = new Date("2026-03-01T10:00:00Z");
    expect(qualifiesAtFor(paid).toISOString()).toBe("2026-03-15T10:00:00.000Z");
    expect(qualifiesAtFor(paid, 0).toISOString()).toBe(paid.toISOString());
    expect(commissionUntilFor(new Date("2026-01-31T12:00:00Z")).toISOString()).toBe("2027-01-31T12:00:00.000Z");
  });
  it("puts a payment in its Brussels month and year", () => {
    expect(brusselsMonthStart(new Date("2026-01-31T23:30:00Z"))).toBe("2026-02-01");
    expect(brusselsMonthStart(new Date("2026-01-31T22:30:00Z"))).toBe("2026-01-01");
    expect(brusselsYear(new Date("2026-12-31T23:30:00Z"))).toBe(2027);
  });
});

describe("the referrals setting", () => {
  it("defaults to one day for the referrer, nothing for the referee, cap 10, 14 days, 12 months", () => {
    expect(ReferralsSettings.parse(REFERRALS_SETTINGS_DEFAULTS)).toEqual({
      referrer: { credit_kind: "day", units: 1, validity_days: 180 },
      referee: null,
      yearly_cap: 10,
      qualification_days: 14,
      commission_months: 12,
    });
    expect(ReferralsSettings.safeParse({ ...REFERRALS_SETTINGS_DEFAULTS, referrer: { credit_kind: "euro", units: 1, validity_days: 1 } }).success).toBe(false);
  });
});

describe("status machines (section 2, R3)", () => {
  it("allows exactly the attribution transitions of the spec", () => {
    const allowed = new Set(ATTRIBUTION_TRANSITIONS.map((t) => `${t.from}->${t.to}`));
    expect([...allowed].sort()).toEqual(["pending->qualified", "pending->rejected", "qualified->pending", "qualified->rejected", "qualified->rewarded"]);
    for (const from of REFERRAL_ATTRIBUTION_STATUSES) {
      for (const to of REFERRAL_ATTRIBUTION_STATUSES) {
        expect(canTransitionAttribution(from, to)).toBe(allowed.has(`${from}->${to}`));
      }
    }
    expect(() => assertAttributionTransition("rewarded", "pending")).toThrow(/attribution_transition/);
    expect(() => assertAttributionTransition("rejected", "qualified")).toThrow();
    expect(() => assertAttributionTransition("pending", "qualified")).not.toThrow();
  });

  it("allows accrued -> approved -> paid and void before paid; paid and void are terminal", () => {
    expect(canTransitionCommission("accrued", "approved")).toBe(true);
    expect(canTransitionCommission("approved", "paid")).toBe(true);
    expect(canTransitionCommission("accrued", "void")).toBe(true);
    expect(canTransitionCommission("approved", "void")).toBe(true);
    expect(canTransitionCommission("accrued", "paid")).toBe(false);
    for (const to of ["accrued", "approved", "paid", "void"] as const) {
      expect(canTransitionCommission("paid", to)).toBe(false);
      expect(canTransitionCommission("void", to)).toBe(false);
    }
    expect(() => assertCommissionTransition("paid", "void")).toThrow(/commission_transition/);
  });
});

describe("keys and links", () => {
  it("follow the spec's idempotency keys", () => {
    expect(referralKeys.referrerReward("x")).toBe("grant:referral:x:referrer");
    expect(referralKeys.refereeReward("x")).toBe("grant:referral:x:referee");
    expect(referralKeys.commission("o")).toBe("commission:o");
    expect(referralKeys.commissionRefund("r")).toBe("commission:refund:r");
  });
  it("builds the share link with the code as ?ref=", () => {
    expect(referralShareUrl("https://beam.be/", "nl", "ABCDEFGH")).toBe("https://beam.be/nl?ref=ABCDEFGH");
  });
});
