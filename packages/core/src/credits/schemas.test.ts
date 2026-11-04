import { describe, expect, it } from "vitest";
import {
  AdjustGrantInput,
  BulkExtendInput,
  CancelMembershipInput,
  CreateGrantInput,
  CREDITS_SETTINGS_DEFAULTS,
  CreditsSettings,
  defaultSharingFor,
  ExtendGrantInput,
  ExtendMembershipPeriodInput,
  GrantCreditsInputSchema,
  GrantSharingSchema,
  PlanBenefitInput,
  PlanInclusionInput,
  RemovePlanBenefitInput,
  ResumeMembershipInput,
  RevokeGrantInput,
  TransferCreditsInput,
  UpdateGrantNoteInput,
  UpdateMembershipNotesInput,
} from "./schemas";

const id = () => globalThis.crypto.randomUUID();
const label = { "nl-BE": "Geschenk", "fr-BE": "Cadeau", en: "Gift" };

describe("CreditsSettings", () => {
  it("defaults to the rule 6a values", () => {
    expect(CreditsSettings.parse({})).toEqual(CREDITS_SETTINGS_DEFAULTS);
    expect(CREDITS_SETTINGS_DEFAULTS.threshold_pcts).toEqual([50, 75, 80, 90]);
    expect(CREDITS_SETTINGS_DEFAULTS.failed_renewals_alert_per_day).toBe(3);
  });

  it("accepts custom values and refuses inconsistent ones", () => {
    expect(CreditsSettings.parse({ threshold_pcts: [60] }).threshold_pcts).toEqual([60]);
    expect(CreditsSettings.safeParse({ threshold_pcts: [0] }).success).toBe(false);
    expect(CreditsSettings.safeParse({ dunning_retry_days: [7, 3] }).success).toBe(false);
    expect(CreditsSettings.safeParse({ dunning_retry_days: [3, 7], dunning_expire_day: 7 }).success).toBe(false);
    expect(CreditsSettings.safeParse({ max_extension_years: 0 }).success).toBe(false);
  });
});

describe("GrantSharingSchema and defaults (rule 2)", () => {
  it("validates the column shape", () => {
    expect(GrantSharingSchema.safeParse({ mode: "guests", max_guest_uses_per_month: 2, allowed_person_ids: [] }).success).toBe(true);
    expect(GrantSharingSchema.safeParse({ mode: "guests", max_guest_uses_per_month: 32, allowed_person_ids: [] }).success).toBe(false);
    expect(GrantSharingSchema.safeParse({ mode: "all", max_guest_uses_per_month: 1, allowed_person_ids: [] }).success).toBe(false);
    expect(GrantSharingSchema.safeParse({ mode: "named", max_guest_uses_per_month: 0, allowed_person_ids: ["x"] }).success).toBe(false);
  });

  it("copies product sharing for purchases only", () => {
    expect(defaultSharingFor({ kind: "day", source: "purchase", isSharingAllowed: true, maxGuestUsesPerMonth: 4 })).toEqual({
      mode: "guests",
      max_guest_uses_per_month: 4,
      allowed_person_ids: [],
    });
    expect(defaultSharingFor({ kind: "day", source: "purchase", isSharingAllowed: true }).max_guest_uses_per_month).toBe(2);
    expect(defaultSharingFor({ kind: "day", source: "purchase", isSharingAllowed: false }).mode).toBe("none");
    expect(defaultSharingFor({ kind: "euro", source: "purchase", isSharingAllowed: true }).mode).toBe("none");
    expect(defaultSharingFor({ kind: "day", source: "membership", isSharingAllowed: true }).mode).toBe("none");
  });
});

describe("GrantCreditsInputSchema", () => {
  const purchase = () => ({
    personId: id(),
    kind: "day" as const,
    units: 10,
    source: "purchase" as const,
    productId: id(),
    orderLineId: id(),
    lineUnitIndex: 1,
    unitValueCents: 1850,
    vatRatePct: 6,
    startsAt: new Date("2026-11-01T10:00:00Z"),
    expiresAt: new Date("2027-05-01T21:59:59.999Z"),
    key: "grant:order_line:x:1",
  });

  it("accepts a purchase, a voucher, a refund restore and an import", () => {
    expect(GrantCreditsInputSchema.safeParse(purchase()).success).toBe(true);
    const voucher = { personId: id(), kind: "euro", units: 5000, source: "voucher", orderLineId: id(), voucherId: id(), unitValueCents: 1, expiresAt: null, key: "grant:voucher:v" };
    expect(GrantCreditsInputSchema.safeParse(voucher).success).toBe(true);
    const restore = { personId: id(), kind: "euro", units: 1200, source: "manual", refundId: id(), vatRatePct: null, expiresAt: null, reason: "partial_refund", key: "grant:refund:r" };
    expect(GrantCreditsInputSchema.safeParse(restore).success).toBe(true);
    const imp = { personId: id(), kind: "day", units: 4, source: "import", expiresAt: null, key: "grant:import:i:row:2", data: { original_units: 10, import_id: id() } };
    expect(GrantCreditsInputSchema.safeParse(imp).success).toBe(true);
  });

  it("refuses inconsistent inputs", () => {
    const bad = (over: Record<string, unknown>) => GrantCreditsInputSchema.safeParse({ ...purchase(), ...over }).success;
    expect(bad({ orderLineId: undefined })).toBe(false);
    expect(bad({ lineUnitIndex: undefined })).toBe(false);
    expect(bad({ kind: "euro", unitValueCents: 1 })).toBe(false);
    expect(bad({ expiresAt: new Date("2026-10-01T00:00:00Z") })).toBe(false);
    expect(bad({ vatRatePct: 9 })).toBe(false);
    expect(bad({ units: 0 })).toBe(false);
    expect(bad({ key: "consume:x" })).toBe(false);
    expect(bad({ refundId: id() })).toBe(false);
    expect(bad({ source: "voucher" })).toBe(false);
    expect(bad({ kind: "euro", source: "voucher", voucherId: id(), unitValueCents: 2 })).toBe(false);
    expect(bad({ kind: "euro", source: "voucher", voucherId: id(), unitValueCents: 1, sharing: { mode: "guests", max_guest_uses_per_month: 1, allowed_person_ids: [] } })).toBe(false);
    expect(bad({ data: { original_units: 5 } })).toBe(false);
    expect(bad({ data: { unknown: 1 } })).toBe(false);
  });
});

describe("staff grant inputs", () => {
  const create = (over: Record<string, unknown> = {}) =>
    CreateGrantInput.safeParse({ personId: id(), kind: "day", units: 2, source: "bonus", label, validityDays: 90, reason: "goodwill", clientKey: id(), ...over });

  it("createGrant: one validity of three, euro alone without expiry, unit caps, complete label", () => {
    expect(create().success).toBe(true);
    expect(create({ validityDays: undefined, expiresAt: "2027-01-01T00:00:00Z" }).success).toBe(true);
    expect(create({ kind: "euro", units: 100_000, validityDays: undefined, noExpiry: true }).success).toBe(true);
    expect(create({ validityDays: undefined, noExpiry: true }).success).toBe(false);
    expect(create({ validityDays: undefined }).success).toBe(false);
    expect(create({ expiresAt: "2027-01-01T00:00:00Z" }).success).toBe(false);
    expect(create({ units: 101 }).success).toBe(false);
    expect(create({ kind: "euro", units: 100_001 }).success).toBe(false);
    expect(create({ validityDays: 1826 }).success).toBe(false);
    expect(create({ label: { en: "Gift" } }).success).toBe(false);
    expect(create({ reason: "ok" }).success).toBe(false);
    expect(create({ source: "purchase" }).success).toBe(false);
    expect(create({ kind: "euro", sharingMode: "guests" }).success).toBe(false);
    expect(create({ sharingMode: "guests" }).success).toBe(true);
  });

  it("adjust, extend, revoke, transfer and note", () => {
    const grantId = id();
    const clientKey = id();
    expect(AdjustGrantInput.safeParse({ grantId, quantity: -2, reason: "correction", clientKey }).success).toBe(true);
    expect(AdjustGrantInput.safeParse({ grantId, quantity: 0, reason: "correction", clientKey }).success).toBe(false);
    expect(AdjustGrantInput.safeParse({ grantId, quantity: 1, reason: "x".repeat(501), clientKey }).success).toBe(false);
    expect(ExtendGrantInput.parse({ grantId, newExpiresAt: "2027-03-01T00:00:00Z", reason: "closure", clientKey }).newExpiresAt).toBeInstanceOf(Date);
    expect(RevokeGrantInput.safeParse({ grantId, reason: "  ", clientKey }).success).toBe(false);
    expect(TransferCreditsInput.safeParse({ grantId, toPersonId: id(), units: 3, reason: "gift to partner", clientKey }).success).toBe(true);
    expect(TransferCreditsInput.safeParse({ grantId, toPersonId: "nope", units: 3, reason: "gift", clientKey }).success).toBe(false);
    expect(UpdateGrantNoteInput.safeParse({ grantId, note: "x".repeat(1001) }).success).toBe(false);
  });

  it("bulk extension defaults and checks (rule 32a)", () => {
    const v = BulkExtendInput.parse({ days: 14, reason: "summer works", expiresFromOn: "2026-07-01", expiresToOn: "2026-08-31", clientKey: id() });
    expect(v.kinds).toEqual(["day", "night"]);
    expect(v.sources).toEqual(["purchase", "import", "voucher", "bonus", "manual"]);
    const base = { days: 14, reason: "summer works", expiresFromOn: "2026-07-01", expiresToOn: "2026-08-31", clientKey: id() };
    expect(BulkExtendInput.safeParse({ ...base, sources: ["membership"] }).success).toBe(false);
    expect(BulkExtendInput.safeParse({ ...base, kinds: [] }).success).toBe(false);
    expect(BulkExtendInput.safeParse({ ...base, days: 91 }).success).toBe(false);
    expect(BulkExtendInput.safeParse({ ...base, expiresToOn: "2026-06-30" }).success).toBe(false);
    expect(BulkExtendInput.safeParse({ ...base, expiresFromOn: "1 July" }).success).toBe(false);
  });
});

describe("membership and plan inputs", () => {
  it("cancel, resume, extend period and notes", () => {
    const membershipId = id();
    expect(CancelMembershipInput.safeParse({ membershipId, mode: "now", reason: "moved abroad", version: 3 }).success).toBe(true);
    expect(CancelMembershipInput.safeParse({ membershipId, mode: "later", reason: "moved abroad", version: 3 }).success).toBe(false);
    expect(CancelMembershipInput.safeParse({ membershipId, mode: "now", reason: "moved abroad", version: 0 }).success).toBe(false);
    expect(ResumeMembershipInput.safeParse({ membershipId, version: 1 }).success).toBe(true);
    const ext = ExtendMembershipPeriodInput.parse({ membershipId, days: 30, reason: "injury", clientKey: id(), version: 2 });
    expect(ext.alsoExtendInclusions).toBe(false);
    expect(ExtendMembershipPeriodInput.safeParse({ membershipId, days: 0, reason: "injury", clientKey: id(), version: 2 }).success).toBe(false);
    expect(UpdateMembershipNotesInput.safeParse({ membershipId, notes: "x".repeat(2001), version: 1 }).success).toBe(false);
  });

  it("plan benefits and inclusions", () => {
    const productId = id();
    const b = PlanBenefitInput.parse({ productId, kind: "event_access", text: label });
    expect(b).toMatchObject({ sortOrder: 0, isActive: true });
    expect(PlanBenefitInput.safeParse({ productId, kind: "event_access", text: { en: "Events" } }).success).toBe(false);
    expect(PlanBenefitInput.safeParse({ productId, kind: "free_coffee", text: label }).success).toBe(false);
    expect(PlanBenefitInput.safeParse({ productId, kind: "other", text: label, sortOrder: 100 }).success).toBe(false);
    expect(RemovePlanBenefitInput.safeParse({ benefitId: id() }).success).toBe(true);
    expect(PlanInclusionInput.safeParse({ productId, kind: "night", unitsPerPeriod: 2 }).success).toBe(true);
    expect(PlanInclusionInput.safeParse({ productId, kind: "euro", unitsPerPeriod: 2 }).success).toBe(false);
    expect(PlanInclusionInput.safeParse({ productId, kind: "day", unitsPerPeriod: 63 }).success).toBe(false);
  });
});
