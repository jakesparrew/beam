import { describe, expect, it } from "vitest";
import { allocateCredits, compareAllocationOrder, isGrantValidAt, type AllocGrant } from "./allocate";

const OWNER = "owner";
const GUEST = "guest";
const SHAREE = "sharee";
const at = (iso: string) => new Date(iso);
const validAt = at("2026-11-10T09:00:00Z");

function grant(id: string, over: Partial<AllocGrant> = {}): AllocGrant {
  return {
    id,
    ownerPersonId: OWNER,
    kind: "day",
    status: "active",
    startsAt: at("2026-01-01T00:00:00Z"),
    expiresAt: at("2026-12-31T22:59:59.999Z"),
    remaining: 5,
    sharing: { mode: "none", max_guest_uses_per_month: 0, allowed_person_ids: [] },
    guestUsesThisMonth: 0,
    ...over,
  };
}

const own = { payerPersonId: OWNER, beneficiaryPersonId: OWNER, validAt };
const asGuest = { payerPersonId: OWNER, beneficiaryPersonId: GUEST, validAt };
const guests = (max: number) => ({ mode: "guests" as const, max_guest_uses_per_month: max, allowed_person_ids: [] });

describe("allocateCredits: order", () => {
  it("takes the earliest expiry first", () => {
    const r = allocateCredits(
      [grant("b", { expiresAt: at("2026-12-01T00:00:00Z") }), grant("a", { expiresAt: at("2026-11-20T00:00:00Z") })],
      "day",
      1,
      own,
    );
    expect(r).toEqual({ ok: true, parts: [{ grantId: "a", units: 1 }] });
  });

  it("puts grants without expiry last", () => {
    const r = allocateCredits([grant("never", { expiresAt: null }), grant("soon")], "day", 1, own);
    expect(r).toEqual({ ok: true, parts: [{ grantId: "soon", units: 1 }] });
  });

  it("breaks ties by oldest start, then id", () => {
    const sameExpiry = { expiresAt: at("2026-12-01T00:00:00Z") };
    const list = [
      grant("c", { ...sameExpiry, startsAt: at("2026-03-01T00:00:00Z") }),
      grant("b", { ...sameExpiry, startsAt: at("2026-02-01T00:00:00Z") }),
      grant("a", { ...sameExpiry, startsAt: at("2026-03-01T00:00:00Z") }),
    ];
    expect([...list].sort(compareAllocationOrder).map((g) => g.id)).toEqual(["b", "a", "c"]);
    expect(compareAllocationOrder(grant("x", { expiresAt: null }), grant("x", { expiresAt: null }))).toBe(0);
  });

  it("splits across grants, one part per grant", () => {
    const r = allocateCredits(
      [grant("late", { remaining: 4, expiresAt: at("2026-12-20T00:00:00Z") }), grant("early", { remaining: 1, expiresAt: at("2026-11-30T00:00:00Z") })],
      "day",
      3,
      own,
    );
    expect(r).toEqual({ ok: true, parts: [{ grantId: "early", units: 1 }, { grantId: "late", units: 2 }] });
  });
});

describe("allocateCredits: eligibility", () => {
  it("skips a grant that starts after validAt (rule 5)", () => {
    const r = allocateCredits([grant("future", { startsAt: at("2026-12-01T00:00:00Z") })], "day", 1, own);
    expect(r).toEqual({ ok: false, reason: "insufficient", available: 0 });
  });

  it("uses a grant from its start instant", () => {
    expect(allocateCredits([grant("now", { startsAt: validAt })], "day", 1, own).ok).toBe(true);
  });

  it("skips a grant expired at validAt (edge case 4), even if active today", () => {
    const g = grant("exp", { expiresAt: at("2026-11-09T22:59:59.999Z") });
    expect(allocateCredits([g], "day", 1, own)).toEqual({ ok: false, reason: "insufficient", available: 0 });
    expect(isGrantValidAt(grant("edge", { expiresAt: validAt }), "day", validAt)).toBe(false);
  });

  it("skips other kinds, non-active statuses and empty grants", () => {
    const list = [
      grant("night", { kind: "night" }),
      grant("exhausted", { status: "exhausted" }),
      grant("revoked", { status: "revoked" }),
      grant("expired", { status: "expired" }),
      grant("empty", { remaining: 0 }),
    ];
    expect(allocateCredits(list, "day", 1, own)).toEqual({ ok: false, reason: "insufficient", available: 0 });
  });

  it("returns what is available when short, consuming nothing", () => {
    const r = allocateCredits([grant("a", { remaining: 2 }), grant("b", { remaining: 1 })], "day", 5, own);
    expect(r).toEqual({ ok: false, reason: "insufficient", available: 3 });
  });

  it("refuses a non-positive or fractional unit count", () => {
    expect(() => allocateCredits([grant("a")], "day", 0, own)).toThrow(RangeError);
    expect(() => allocateCredits([grant("a")], "day", 1.5, own)).toThrow(RangeError);
  });
});

describe("allocateCredits: guests (rule 17)", () => {
  it("guest on a grant with mode none -> not_shareable", () => {
    expect(allocateCredits([grant("a")], "day", 1, asGuest)).toEqual({ ok: false, reason: "not_shareable", available: 0 });
  });

  it("guest limit 0 forbids guests", () => {
    expect(allocateCredits([grant("a", { sharing: guests(0) })], "day", 1, asGuest)).toMatchObject({ ok: false, reason: "not_shareable" });
  });

  it("allows a guest while uses this month are below the limit", () => {
    const r = allocateCredits([grant("a", { sharing: guests(2), guestUsesThisMonth: 1 })], "day", 1, asGuest);
    expect(r).toEqual({ ok: true, parts: [{ grantId: "a", units: 1 }] });
  });

  it("monthly guest limit reached -> guest_limit", () => {
    const r = allocateCredits([grant("a", { sharing: guests(2), guestUsesThisMonth: 2 })], "day", 1, asGuest);
    expect(r).toEqual({ ok: false, reason: "guest_limit", available: 0 });
  });

  it("named mode also admits the owner's guests", () => {
    const named = { mode: "named" as const, max_guest_uses_per_month: 1, allowed_person_ids: [] };
    expect(allocateCredits([grant("a", { sharing: named })], "day", 1, asGuest).ok).toBe(true);
  });

  it("skips a non-shareable grant for a guest and uses a shareable one", () => {
    const r = allocateCredits(
      [grant("private", { expiresAt: at("2026-11-20T00:00:00Z") }), grant("shared", { sharing: guests(2) })],
      "day",
      1,
      asGuest,
    );
    expect(r).toEqual({ ok: true, parts: [{ grantId: "shared", units: 1 }] });
  });

  it("reports insufficient when even the excluded units would not cover the booking", () => {
    expect(allocateCredits([grant("a", { remaining: 1 })], "day", 2, asGuest)).toEqual({ ok: false, reason: "insufficient", available: 0 });
  });

  it("names the sharing rule that excluded the most units", () => {
    const r = allocateCredits(
      [grant("limit", { sharing: guests(1), guestUsesThisMonth: 1, remaining: 1 }), grant("none", { remaining: 3 })],
      "day",
      2,
      asGuest,
    );
    expect(r).toEqual({ ok: false, reason: "not_shareable", available: 0 });
  });
});

describe("allocateCredits: named shares (rule 18, R2)", () => {
  const asSharee = { payerPersonId: SHAREE, beneficiaryPersonId: SHAREE, validAt };
  const named = { mode: "named" as const, max_guest_uses_per_month: 0, allowed_person_ids: [SHAREE] };

  it("uses a grant shared with the beneficiary", () => {
    const r = allocateCredits([grant("s", { sharing: named, share: { maxUnits: null, usedByBeneficiary: 0 } })], "day", 2, asSharee);
    expect(r).toEqual({ ok: true, parts: [{ grantId: "s", units: 2 }] });
  });

  it("ignores someone else's grant without a share", () => {
    expect(allocateCredits([grant("s", { sharing: named })], "day", 1, asSharee)).toEqual({ ok: false, reason: "insufficient", available: 0 });
  });

  it("enforces max_units -> share_limit", () => {
    const g = grant("s", { sharing: named, share: { maxUnits: 3, usedByBeneficiary: 2 } });
    expect(allocateCredits([g], "day", 1, asSharee)).toEqual({ ok: true, parts: [{ grantId: "s", units: 1 }] });
    expect(allocateCredits([g], "day", 2, asSharee)).toEqual({ ok: false, reason: "share_limit", available: 1 });
    const used = grant("s", { sharing: named, share: { maxUnits: 3, usedByBeneficiary: 5 } });
    expect(allocateCredits([used], "day", 1, asSharee)).toEqual({ ok: false, reason: "share_limit", available: 0 });
  });

  it("uses own grants before shared grants, whatever the expiry", () => {
    const r = allocateCredits(
      [
        grant("shared", { sharing: named, expiresAt: at("2026-11-15T00:00:00Z"), share: { maxUnits: null, usedByBeneficiary: 0 } }),
        grant("mine", { ownerPersonId: SHAREE, remaining: 1, expiresAt: null }),
      ],
      "day",
      2,
      asSharee,
    );
    expect(r).toEqual({ ok: true, parts: [{ grantId: "mine", units: 1 }, { grantId: "shared", units: 1 }] });
  });

  it("does not let a payer spend a third party's shared grant on someone else", () => {
    const g = grant("s", { sharing: named, share: { maxUnits: null, usedByBeneficiary: 0 } });
    expect(allocateCredits([g], "day", 1, { payerPersonId: SHAREE, beneficiaryPersonId: GUEST, validAt })).toMatchObject({
      ok: false,
      reason: "insufficient",
    });
  });
});

describe("allocateCredits: euro for an order (rule 20)", () => {
  it("spends cents earliest expiry first, splitting across grants", () => {
    const now = at("2026-11-10T12:00:00Z");
    const euro = (id: string, remaining: number, expiresAt: Date | null) => grant(id, { kind: "euro", remaining, expiresAt });
    const r = allocateCredits(
      [euro("store", 5000, null), euro("voucher", 2500, at("2027-06-30T21:59:59.999Z")), euro("old", 1000, at("2026-12-31T22:59:59.999Z"))],
      "euro",
      4000,
      { payerPersonId: OWNER, beneficiaryPersonId: OWNER, validAt: now },
    );
    expect(r).toEqual({
      ok: true,
      parts: [
        { grantId: "old", units: 1000 },
        { grantId: "voucher", units: 2500 },
        { grantId: "store", units: 500 },
      ],
    });
  });

  it("never spends day units for a euro order", () => {
    expect(allocateCredits([grant("day")], "euro", 100, own)).toEqual({ ok: false, reason: "insufficient", available: 0 });
  });
});
