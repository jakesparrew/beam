import { describe, expect, it } from "vitest";
import { MERGE_STRATEGIES, mergeStrategyFor, pickMergedFields, planConsentCopy, type MergePerson } from "./merge-plan";
import type { ConsentRecordLike } from "./types";

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

const person = (over: Partial<MergePerson>): MergePerson => ({
  email: null,
  phone: null,
  firstName: null,
  lastName: null,
  locale: "nl-BE",
  address: null,
  birthOn: null,
  preferredChannel: null,
  linkedinUrl: null,
  emergencyContact: null,
  acquisition: { source: "manual" },
  statusOverride: null,
  statusOverrideReason: null,
  statusOverrideByUserId: null,
  statusOverrideAt: null,
  isTester: false,
  externalIds: {},
  processingRestrictedAt: null,
  createdAt: at("2026-01-01T00:00:00Z"),
  ...over,
});

describe("consent on merge (rule 3.33)", () => {
  it("3.33 a newer withdrawal of the loser is copied to the winner with its original fields", () => {
    const winner = [rec({ status: "granted", recordedAt: at("2026-01-01T00:00:00Z") })];
    const loserWithdrawal = rec({ status: "withdrawn", method: "unsubscribe_link", source: "one_click:abc", wordingVersion: "unsubscribe", recordedAt: at("2026-03-01T00:00:00Z") });
    const copies = planConsentCopy(winner, [loserWithdrawal]);
    expect(copies).toEqual([
      {
        copiedFromRecordId: loserWithdrawal.id,
        purpose: "newsletter",
        status: "withdrawn",
        method: "unsubscribe_link",
        source: "one_click:abc",
        wordingVersion: "unsubscribe",
        recordedAt: loserWithdrawal.recordedAt,
      },
    ]);
  });

  it("3.33 nothing is copied when the winner's record is the latest", () => {
    const winner = [rec({ status: "withdrawn", wordingVersion: "unsubscribe", recordedAt: at("2026-04-01T00:00:00Z") })];
    const loser = [rec({ status: "granted", recordedAt: at("2026-03-01T00:00:00Z") })];
    expect(planConsentCopy(winner, loser)).toEqual([]);
  });

  it("3.33 a purpose only the loser has is copied; each purpose is decided on its own", () => {
    const winner = [rec({ purpose: "newsletter", recordedAt: at("2026-05-01T00:00:00Z") })];
    const loser = [rec({ purpose: "newsletter", recordedAt: at("2026-01-01T00:00:00Z") }), rec({ purpose: "events", wordingVersion: "events@1" })];
    const copies = planConsentCopy(winner, loser);
    expect(copies.map((c) => c.purpose)).toEqual(["events"]);
  });
});

describe("field choices (rules 3.30 and 3.34)", () => {
  const winner = person({
    email: "winner@example.com",
    firstName: "Win",
    lastName: "Ner",
    acquisition: { source: "website" },
    createdAt: at("2026-05-01T00:00:00Z"),
    externalIds: { simplybook: "1", mailchimp: "w" },
  });
  const loser = person({
    email: "loser@example.com",
    firstName: "Lou",
    phone: "0470 12 34 56",
    acquisition: { source: "import", campaign: "legacy" },
    createdAt: at("2025-01-01T00:00:00Z"),
    externalIds: { mailchimp: "l", sheet: "9" },
    statusOverride: "customer",
    statusOverrideReason: "legacy customer",
    isTester: true,
    processingRestrictedAt: at("2026-02-01T00:00:00Z"),
  });

  it("3.30 each field comes from the side staff chose, the winner by default", () => {
    const patch = pickMergedFields(winner, loser, { firstName: "loser", phone: "loser" });
    expect(patch.firstName).toBe("Lou");
    expect(patch.phone).toBe("0470 12 34 56");
    expect(patch.email).toBe("winner@example.com");
    expect(patch.lastName).toBe("Ner");
  });

  it("3.34 keeps the oldest acquisition, the winner's override else the loser's, tester if either", () => {
    const patch = pickMergedFields(winner, loser, {});
    expect(patch.acquisition).toEqual({ source: "import", campaign: "legacy" });
    expect(patch.statusOverride).toBe("customer");
    expect(patch.statusOverrideReason).toBe("legacy customer");
    expect(patch.isTester).toBe(true);
    const own = pickMergedFields(person({ ...winner, statusOverride: "lead", statusOverrideReason: "manual" }), loser, {});
    expect(own.statusOverride).toBe("lead");
    expect(own.statusOverrideReason).toBe("manual");
  });

  it("3.34 unions external ids with the winner's value on a clash", () => {
    expect(pickMergedFields(winner, loser, {}).externalIds).toEqual({ simplybook: "1", mailchimp: "w", sheet: "9" });
  });

  it("3.31 a merge never lifts a processing restriction", () => {
    expect(pickMergedFields(winner, loser, {}).processingRestrictedAt).toEqual(at("2026-02-01T00:00:00Z"));
    expect(pickMergedFields(winner, person({}), {}).processingRestrictedAt).toBeNull();
  });
});

describe("merge strategies (rules 3.31 and 3.32)", () => {
  it("3.31 unique-key tables keep the winner; owner-hook tables are skipped", () => {
    for (const t of ["person_tags", "segment_members", "company_contacts", "person_sensitive_fields", "campaign_recipients"]) expect(mergeStrategyFor(t, "person_id")).toBe("keep_winner");
    for (const [t, c] of [["webinar_registrations", "person_id"], ["credit_grants", "person_id"], ["memberships", "person_id"], ["package_shares", "shared_with_person_id"], ["users", "person_id"], ["referral_attributions", "referrer_person_id"]]) {
      expect(mergeStrategyFor(t!, c!)).toBe("skip");
    }
  });

  it("3.32 append-only tables are never rewritten; unknown tables are repointed", () => {
    for (const t of ["activity_events", "consent_records", "person_declarations", "credit_entries", "automation_runs", "audit_log", "watch_segments", "webinar_interactions", "email_events"]) {
      expect(mergeStrategyFor(t, "person_id")).toBe("skip");
    }
    expect(mergeStrategyFor("orders", "person_id")).toBe("repoint");
    expect(mergeStrategyFor("tasks", "person_id")).toBe("repoint");
  });

  it("every strategy value is one of the four", () => {
    for (const v of Object.values(MERGE_STRATEGIES)) expect(["repoint", "keep_winner", "refuse_if_both", "skip"]).toContain(v);
  });
});
