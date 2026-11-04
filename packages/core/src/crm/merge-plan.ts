/**
 * The pure part of a person merge (crm rules 3.30 to 3.34): which fields the winner ends up
 * with, which consent records are copied, and how each `persons.id` reference is handled.
 * crm-P4's `executeMerge` applies the plan inside the merge transaction.
 */
import { compareConsentRecords } from "./consent";
import type { Acquisition, ConsentPurpose, ConsentRecordLike, EmergencyContact, PersonStatus, PostalAddress } from "./types";

export type MergeStrategy = "repoint" | "keep_winner" | "refuse_if_both" | "skip";

/**
 * How the generic repoint treats each `<table>.<column>` that references `persons.id`
 * (rule 3.31, 3.32); `<table>.*` covers every column of the table. Anything not listed is
 * `repoint`. `keep_winner`: the loser's row is deleted (after being described in `repointed`)
 * when the winner already has a row with the same unique key, else it is repointed.
 * `refuse_if_both`: a conflicting row on both sides refuses the merge. `skip`: never touched
 * (append-only tables, tables an owner hook or platform handles, crm's own bookkeeping).
 */
export const MERGE_STRATEGIES: Record<string, MergeStrategy> = {
  // unique keys that include the person: the winner's row is kept
  "person_tags.person_id": "keep_winner",
  "segment_members.person_id": "keep_winner",
  "company_contacts.person_id": "keep_winner",
  "person_sensitive_fields.person_id": "keep_winner",
  "campaign_recipients.person_id": "keep_winner",
  "person_stats.person_id": "keep_winner",
  "processing_restrictions.person_id": "keep_winner",
  // both persons on the same session or waitlist: refused
  "bookings.person_id": "refuse_if_both",
  "waitlist_entries.person_id": "refuse_if_both",
  // owner hooks (webinar.mergePersons, credits.onPersonsMerged) and platform's reassignCustomerAccount
  "webinar_registrations.person_id": "skip",
  "credit_grants.person_id": "skip",
  "memberships.person_id": "skip",
  "package_shares.shared_with_person_id": "skip",
  "referral_codes.person_id": "skip",
  "referral_attributions.*": "skip",
  "users.person_id": "skip",
  // append-only tables: never rewritten, reads resolve the merge (rule 3.32)
  "activity_events.*": "skip",
  "consent_records.*": "skip",
  "person_declarations.*": "skip",
  "suppressions.*": "skip",
  "credit_entries.*": "skip",
  "automation_runs.*": "skip",
  "audit_log.*": "skip",
  "watch_segments.*": "skip",
  "webinar_interactions.*": "skip",
  "email_events.*": "skip",
  // the merge's own bookkeeping
  "persons.merged_into_person_id": "skip",
  "person_merges.*": "skip",
  "person_duplicate_candidates.*": "skip",
};

/** The strategy for one referencing column (exact entry, then `<table>.*`, else `repoint`). */
export function mergeStrategyFor(table: string, column: string): MergeStrategy {
  return MERGE_STRATEGIES[`${table}.${column}`] ?? MERGE_STRATEGIES[`${table}.*`] ?? "repoint";
}

// ---------------------------------------------------------------------------
// Consent copy (rule 3.33)
// ---------------------------------------------------------------------------

export type ConsentCopy = {
  copiedFromRecordId: string;
  purpose: ConsentPurpose;
  status: "granted" | "withdrawn";
  method: ConsentRecordLike["method"];
  source: string;
  wordingVersion: string;
  lawfulBasis?: ConsentRecordLike["lawfulBasis"];
  recordedAt: Date;
};

/**
 * Per purpose, the latest record across both persons wins; when it is the loser's, a copy is
 * appended to the winner with the original `recorded_at`, `wording_version`, `method` and
 * `source`. A newer withdrawal on either side therefore survives.
 */
export function planConsentCopy(winnerRecords: readonly ConsentRecordLike[], loserRecords: readonly ConsentRecordLike[]): ConsentCopy[] {
  const tagged = [...winnerRecords.map((r) => ({ r, side: "winner" as const })), ...loserRecords.map((r) => ({ r, side: "loser" as const }))];
  const purposes = [...new Set(tagged.map((t) => t.r.purpose))].sort();
  const out: ConsentCopy[] = [];
  for (const purpose of purposes) {
    const latest = tagged.filter((t) => t.r.purpose === purpose).sort((a, b) => compareConsentRecords(a.r, b.r))[0];
    if (!latest || latest.side !== "loser") continue;
    const r = latest.r;
    out.push({
      copiedFromRecordId: r.id,
      purpose,
      status: r.status,
      method: r.method,
      source: r.source,
      wordingVersion: r.wordingVersion,
      ...(r.lawfulBasis ? { lawfulBasis: r.lawfulBasis } : {}),
      recordedAt: r.recordedAt,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field choices (rules 3.30, 3.34)
// ---------------------------------------------------------------------------

/** The person fields staff choose per field in the merge compare screen. */
export const MERGE_FIELDS = [
  "email",
  "phone",
  "firstName",
  "lastName",
  "locale",
  "address",
  "birthOn",
  "preferredChannel",
  "linkedinUrl",
  "emergencyContact",
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

export type MergePerson = {
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  locale: string;
  address: PostalAddress | null;
  birthOn: string | null;
  preferredChannel: "email" | "phone" | "whatsapp" | null;
  linkedinUrl: string | null;
  emergencyContact: EmergencyContact | null;
  acquisition: Partial<Acquisition> | Record<string, unknown>;
  statusOverride: PersonStatus | null;
  statusOverrideReason: string | null;
  statusOverrideByUserId: string | null;
  statusOverrideAt: Date | null;
  isTester: boolean;
  externalIds: Record<string, string>;
  processingRestrictedAt: Date | null;
  createdAt: Date;
};

export type PersonPatch = Partial<Omit<MergePerson, "createdAt">>;

/**
 * The winner's new values: each chosen field from the side staff picked (default winner);
 * the oldest `acquisition` by `created_at`; the winner's override, else the loser's; tester if
 * either is; the union of `external_ids` with the winner's value on a clash; and the earliest
 * processing restriction, so a merge never lifts one (rule 3.31).
 */
export function pickMergedFields(winner: MergePerson, loser: MergePerson, choices: Partial<Record<MergeField, "winner" | "loser">>): PersonPatch {
  const patch: PersonPatch = {};
  const set = <K extends keyof PersonPatch>(k: K, v: PersonPatch[K]) => {
    patch[k] = v;
  };
  for (const field of MERGE_FIELDS) set(field, (choices[field] === "loser" ? loser : winner)[field] as never);

  set("acquisition", (loser.createdAt.getTime() < winner.createdAt.getTime() ? loser : winner).acquisition);

  const overrideFrom = winner.statusOverride ? winner : loser.statusOverride ? loser : winner;
  set("statusOverride", overrideFrom.statusOverride);
  set("statusOverrideReason", overrideFrom.statusOverrideReason);
  set("statusOverrideByUserId", overrideFrom.statusOverrideByUserId);
  set("statusOverrideAt", overrideFrom.statusOverrideAt);

  set("isTester", winner.isTester || loser.isTester);
  set("externalIds", { ...loser.externalIds, ...winner.externalIds });

  const restricted = [winner.processingRestrictedAt, loser.processingRestrictedAt].filter((d): d is Date => !!d);
  set("processingRestrictedAt", restricted.length ? new Date(Math.min(...restricted.map((d) => d.getTime()))) : null);
  return patch;
}
