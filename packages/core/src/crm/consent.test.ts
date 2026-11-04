import { describe, expect, it } from "vitest";
import {
  canEditPreferences,
  currentConsents,
  formGrantNeedsConfirmation,
  importGrantDecision,
  isSuppressedFor,
  latestConsent,
  latestConsentRecord,
  purposesToWithdraw,
  suppressionBlocks,
  validateConsentInput,
} from "./consent";
import type { ConsentRecordLike, ConsentState, SuppressionLike } from "./types";

const at = (iso: string) => new Date(iso);
let n = 0;
const rec = (over: Partial<ConsentRecordLike>): ConsentRecordLike => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  purpose: "newsletter",
  status: "granted",
  method: "form",
  source: "form:intake",
  wordingVersion: "newsletter@1",
  recordedAt: at("2026-01-01T10:00:00Z"),
  createdAt: at("2026-01-01T10:00:00Z"),
  ...over,
});
const granted = (method: ConsentState["method"], iso: string): ConsentState => ({ status: "granted", method, source: "x", wordingVersion: "newsletter@1", recordedAt: at(iso) });
const supp = (over: Partial<SuppressionLike>): SuppressionLike => ({ scope: "newsletter", reason: "unsubscribe", createdAt: at("2026-03-01T00:00:00Z"), ...over });

describe("latest consent (rule 3.13)", () => {
  it("3.13 the latest record by recorded_at wins", () => {
    const records = [rec({ status: "granted" }), rec({ status: "withdrawn", method: "unsubscribe_link", wordingVersion: "unsubscribe", recordedAt: at("2026-02-01T00:00:00Z") })];
    expect(latestConsent(records)?.status).toBe("withdrawn");
    expect(latestConsent([])).toBeNull();
  });

  it("3.13 ties on recorded_at fall back to created_at, then id", () => {
    const t = at("2026-02-01T00:00:00Z");
    const a = rec({ status: "granted", recordedAt: t, createdAt: at("2026-02-01T00:00:01Z") });
    const b = rec({ status: "withdrawn", recordedAt: t, createdAt: at("2026-02-01T00:00:02Z") });
    expect(latestConsentRecord([a, b])?.id).toBe(b.id);
    const c = rec({ id: "00000000-0000-4000-8000-00000000000a", status: "granted", recordedAt: t, createdAt: t });
    const d = rec({ id: "00000000-0000-4000-8000-00000000000b", status: "withdrawn", recordedAt: t, createdAt: t });
    expect(latestConsentRecord([d, c])?.id).toBe(d.id);
    expect(latestConsentRecord([c, d])?.id).toBe(d.id);
  });

  it("3.13 current state is per purpose", () => {
    const state = currentConsents([rec({ purpose: "newsletter" }), rec({ purpose: "events", status: "withdrawn", wordingVersion: "unsubscribe" })]);
    expect(state.newsletter?.status).toBe("granted");
    expect(state.events?.status).toBe("withdrawn");
    expect(state.b2b).toBeUndefined();
  });
});

describe("wording versions (rule 3.14)", () => {
  it("3.14 portal and preference-centre grants need <purpose>@<version> of the same purpose", () => {
    expect(validateConsentInput({ purpose: "newsletter", status: "granted", method: "portal", wordingVersion: "newsletter@2" })).toEqual({ ok: true });
    expect(validateConsentInput({ purpose: "newsletter", status: "granted", method: "preference_centre", wordingVersion: "events@2" }).ok).toBe(false);
    expect(validateConsentInput({ purpose: "newsletter", status: "granted", method: "portal", wordingVersion: "form:intake:v1:newsletter" }).ok).toBe(false);
  });

  it("3.14 form grants accept a wording version or form:<slug>:v<n>:<field>; anything else is refused", () => {
    expect(validateConsentInput({ purpose: "events", status: "granted", method: "form", wordingVersion: "form:sleep-check:v3:consent_events" }).ok).toBe(true);
    expect(validateConsentInput({ purpose: "events", status: "granted", method: "form", wordingVersion: "events@1" }).ok).toBe(true);
    expect(validateConsentInput({ purpose: "events", status: "granted", method: "form", wordingVersion: "I agree" }).ok).toBe(false);
    expect(validateConsentInput({ purpose: "events", status: "granted", method: "form", wordingVersion: "form:sleep-check:3:x" }).ok).toBe(false);
  });

  it("3.14 imports may store legacy-import; staff grants are b2b with legitimate interest only", () => {
    expect(validateConsentInput({ purpose: "newsletter", status: "granted", method: "import", wordingVersion: "legacy-import" }).ok).toBe(true);
    expect(validateConsentInput({ purpose: "b2b", status: "granted", method: "staff", wordingVersion: "b2b@1", lawfulBasis: "legitimate_interest" }).ok).toBe(true);
    expect(validateConsentInput({ purpose: "newsletter", status: "granted", method: "staff", wordingVersion: "newsletter@1", lawfulBasis: "legitimate_interest" }).ok).toBe(false);
    expect(validateConsentInput({ purpose: "b2b", status: "granted", method: "staff", wordingVersion: "b2b@1" }).ok).toBe(false);
    // staff-assisted form entry (forms ID10): a form wording version with lawful basis consent, any purpose
    expect(validateConsentInput({ purpose: "newsletter", status: "granted", method: "staff", wordingVersion: "form:intake:v2:newsletter" }).ok).toBe(true);
    expect(validateConsentInput({ purpose: "sensitive_processing", status: "granted", method: "staff", wordingVersion: "form:intake:v2:sensitive", lawfulBasis: "consent" }).ok).toBe(true);
    expect(validateConsentInput({ purpose: "b2b", status: "granted", method: "staff", wordingVersion: "form:intake:v2:b2b", lawfulBasis: "legitimate_interest" }).ok).toBe(false);
    expect(validateConsentInput({ purpose: "newsletter", status: "granted", method: "unsubscribe_link", wordingVersion: "newsletter@1" }).ok).toBe(false);
  });

  it("3.16 withdrawals carry unsubscribe, complaint or restriction", () => {
    for (const w of ["unsubscribe", "complaint", "restriction"]) {
      expect(validateConsentInput({ purpose: "newsletter", status: "withdrawn", method: "unsubscribe_link", wordingVersion: w }).ok).toBe(true);
    }
    expect(validateConsentInput({ purpose: "newsletter", status: "withdrawn", method: "portal", wordingVersion: "whatever" }).ok).toBe(false);
  });
});

describe("suppressions (rules 3.17, 3.19, 3.21)", () => {
  it("3.19 scope all and the forever reasons always block", () => {
    const later = granted("portal", "2026-06-01T00:00:00Z");
    expect(suppressionBlocks({ suppression: supp({ scope: "all" }), currentConsent: later })).toBe(true);
    for (const reason of ["hard_bounce", "complaint", "manual", "erased"] as const) {
      expect(suppressionBlocks({ suppression: supp({ reason }), currentConsent: later })).toBe(true);
    }
  });

  it("3.19 a scoped unsubscribe is lifted only by a newer form, portal or preference-centre grant", () => {
    const s = supp({});
    expect(suppressionBlocks({ suppression: s, currentConsent: null })).toBe(true);
    expect(suppressionBlocks({ suppression: s, currentConsent: granted("portal", "2026-06-01T00:00:00Z") })).toBe(false);
    expect(suppressionBlocks({ suppression: s, currentConsent: granted("preference_centre", "2026-06-01T00:00:00Z") })).toBe(false);
    expect(suppressionBlocks({ suppression: s, currentConsent: granted("form", "2026-06-01T00:00:00Z") })).toBe(false);
    expect(suppressionBlocks({ suppression: s, currentConsent: granted("import", "2026-06-01T00:00:00Z") })).toBe(true);
    expect(suppressionBlocks({ suppression: s, currentConsent: granted("portal", "2026-02-01T00:00:00Z") })).toBe(true);
    expect(suppressionBlocks({ suppression: s, currentConsent: { ...granted("portal", "2026-06-01T00:00:00Z"), status: "withdrawn" } })).toBe(true);
  });

  it("3.19 isSuppressedFor only looks at the purpose's scope and all", () => {
    expect(isSuppressedFor({ purpose: "events", suppressions: [supp({ scope: "newsletter" })], currentConsent: null })).toBe(false);
    expect(isSuppressedFor({ purpose: "events", suppressions: [supp({ scope: "all", reason: "hard_bounce" })], currentConsent: null })).toBe(true);
  });

  it("3.21 a form grant blocked by a scoped unsubscribe needs confirmation", () => {
    expect(formGrantNeedsConfirmation({ purpose: "newsletter", suppressions: [supp({})], currentConsent: null })).toBe(true);
    expect(formGrantNeedsConfirmation({ purpose: "newsletter", suppressions: [supp({ scope: "all", reason: "complaint" })], currentConsent: null })).toBe(false);
    expect(formGrantNeedsConfirmation({ purpose: "newsletter", suppressions: [], currentConsent: null })).toBe(false);
  });

  it("3.17 unsubscribe from everything withdraws every granted marketing purpose", () => {
    expect(purposesToWithdraw({ newsletter: granted("form", "2026-01-01T00:00:00Z"), b2b: granted("staff", "2026-01-01T00:00:00Z"), events: { ...granted("form", "2026-01-01T00:00:00Z"), status: "withdrawn" }, ai_processing: granted("portal", "2026-01-01T00:00:00Z") })).toEqual(["newsletter", "b2b"]);
  });
});

describe("import decisions (rule 3.20)", () => {
  it("3.20 an imported grant is recorded when nothing blocks it", () => {
    expect(importGrantDecision({ existingRecords: [], suppressions: [], purpose: "newsletter" })).toBe("record");
    expect(importGrantDecision({ existingRecords: [rec({ purpose: "events", status: "withdrawn" })], suppressions: [{ scope: "events" }], purpose: "newsletter" })).toBe("record");
  });

  it("3.20 an imported grant is skipped when the address is suppressed for that scope or all", () => {
    expect(importGrantDecision({ existingRecords: [], suppressions: [{ scope: "newsletter" }], purpose: "newsletter" })).toBe("skip");
    expect(importGrantDecision({ existingRecords: [], suppressions: [{ scope: "all" }], purpose: "b2b" })).toBe("skip");
  });

  it("3.20 an imported grant is skipped when the person ever withdrew that purpose", () => {
    const records = [rec({ status: "withdrawn", recordedAt: at("2025-01-01T00:00:00Z") }), rec({ status: "granted", recordedAt: at("2026-01-01T00:00:00Z") })];
    expect(importGrantDecision({ existingRecords: records, suppressions: [], purpose: "newsletter" })).toBe("skip");
  });
});

describe("preference window", () => {
  it("allows changes for 365 days after sending", () => {
    const sent = at("2025-11-03T10:00:00Z");
    expect(canEditPreferences(sent, at("2026-11-03T10:00:00Z"))).toBe(true);
    expect(canEditPreferences(sent, at("2026-11-03T10:00:01Z"))).toBe(false);
  });
});
