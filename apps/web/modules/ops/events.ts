/**
 * ops timeline facts (ops spec 4.6, data model 4.6). Facade read by `pnpm gen:indexes`: every
 * `kind` is a literal. Written once by ops-P1. All have subject `person` and carry no personal
 * data; erasure writes no event (the timeline is deleted). `ops.history_imported` is a fact
 * about the past and never an automation trigger (rule 47b).
 */
import { z } from "zod";
import { B2C_STAGES, IMPORTED_HISTORY_KINDS, IMPORT_SOURCES, INACTIVITY_THRESHOLDS, PRIVACY_KINDS } from "@beam/core/ops";
import { defineEvent } from "@/lib/events";

/** An instant: a `Date` or an ISO string, stored as ISO text. */
const instant = z.union([z.date(), z.iso.datetime({ offset: true })]).transform((v) => (typeof v === "string" ? v : v.toISOString()));

/** Rule 16: `dedupe_key = person:<id>:inactive:<days>:<anchor date>`. */
export const InactiveDaysData = z.object({
  days: z.literal(INACTIVITY_THRESHOLDS),
  anchor_at: instant,
  has_future_booking: z.boolean(),
});
/** Rule 14: `dedupe_key = stage:<person_id>:<to>:<YYYY-MM-DD>`. */
export const StageChangedData = z.object({ from: z.enum(B2C_STAGES), to: z.enum(B2C_STAGES) });
/** Rule 50: `occurred_at` is the original time, `dedupe_key = import:<source>:<kind>:<external_id>`. */
export const HistoryImportedData = z.object({
  kind: z.enum(IMPORTED_HISTORY_KINDS),
  source: z.enum(IMPORT_SOURCES),
  amount_cents: z.number().int().optional(),
});
export const PrivacyKindData = z.object({ kind: z.enum(PRIVACY_KINDS) });
export const EmptyData = z.object({}).strict();

export const events = [
  defineEvent({ kind: "person.inactive_days", data: InactiveDaysData, subject: "person" }),
  defineEvent({ kind: "ops.stage_changed", data: StageChangedData, subject: "person" }),
  defineEvent({ kind: "ops.history_imported", data: HistoryImportedData, subject: "person" }),
  defineEvent({ kind: "privacy.requested", data: PrivacyKindData, subject: "person" }),
  defineEvent({ kind: "privacy.verified", data: PrivacyKindData, subject: "person" }),
  defineEvent({ kind: "privacy.cancelled", data: PrivacyKindData, subject: "person" }),
  defineEvent({ kind: "privacy.restricted", data: EmptyData, subject: "person" }),
  defineEvent({ kind: "privacy.restriction_lifted", data: EmptyData, subject: "person" }),
  defineEvent({ kind: "privacy.objected", data: EmptyData, subject: "person" }),
  defineEvent({ kind: "privacy.exported", data: EmptyData, subject: "person" }),
];
