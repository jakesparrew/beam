/**
 * credits timeline events (`defineEvent`, credits spec section 4 "Activity events"). Facade read
 * by `pnpm gen:indexes`. credits-P3 declares the `credits.*` kinds; the `membership.*` kinds come
 * with credits-P4 and the `referral.*` kinds with credits-P9. Every `credits.*` event carries
 * `data.credit_kind` (never `data.kind`), ids-only snake_case `data` (cross-module D27) and
 * `ref = { type: 'credit_grant', id }`; dedupe keys are `grant:<id>:<event suffix>`.
 */
import { z } from "zod";
import { GRANT_SOURCES } from "@beam/core/credits";
import { defineEvent } from "@/lib/events";

const uuid = z.uuid();
const creditKind = z.enum(["day", "night", "euro"]);
const source = z.enum(GRANT_SOURCES);
const units = z.number().int().positive();
const remaining = z.number().int().min(0);
const refType = z.enum(["booking", "order"]);
const releaseReason = z.enum([
  "cancelled_in_policy",
  "late_cancel_released",
  "no_show_released",
  "rescheduled",
  "session_cancelled",
  "staff_override",
  "order_expired",
  "refund",
]);
const isoDate = z.iso.datetime({ offset: true });

export const events = [
  defineEvent({
    kind: "credits.granted",
    subject: "person",
    data: z.object({ grant_id: uuid, credit_kind: creditKind, units, source, product_id: uuid.nullable() }),
  }),
  defineEvent({
    kind: "credits.consumed",
    subject: "person",
    data: z.object({
      grant_id: uuid,
      credit_kind: creditKind,
      units,
      ref_type: refType,
      ref_id: uuid,
      beneficiary_person_id: uuid,
      remaining_units: remaining,
    }),
  }),
  defineEvent({
    kind: "credits.guest_used",
    subject: "person",
    data: z.object({ grant_id: uuid, credit_kind: creditKind, units, owner_person_id: uuid, ref_type: refType, ref_id: uuid }),
  }),
  defineEvent({
    kind: "credits.released",
    subject: "person",
    data: z.object({ grant_id: uuid, credit_kind: creditKind, units, reason: releaseReason, ref_type: refType, ref_id: uuid }),
  }),
  defineEvent({
    kind: "credits.threshold_reached",
    subject: "person",
    data: z.object({
      grant_id: uuid,
      credit_kind: creditKind,
      pct: z.union([z.number().int().min(1).max(100), z.literal("last_unit")]),
      remaining_units: remaining,
    }),
  }),
  defineEvent({
    kind: "credits.grant_exhausted",
    subject: "person",
    data: z.object({ grant_id: uuid, credit_kind: creditKind, source, product_id: uuid.nullable() }),
  }),
  defineEvent({
    kind: "credits.expiry_approaching",
    subject: "person",
    data: z.object({ grant_id: uuid, credit_kind: creditKind, days: z.number().int().positive(), remaining_units: remaining }),
  }),
  defineEvent({
    kind: "credits.grant_expired",
    subject: "person",
    data: z.object({ grant_id: uuid, credit_kind: creditKind, units: remaining, source }),
  }),
  defineEvent({
    kind: "credits.extended",
    subject: "person",
    data: z.object({ grant_id: uuid, credit_kind: creditKind, old_expires_at: isoDate, new_expires_at: isoDate, reinstated_units: remaining }),
  }),
  defineEvent({
    kind: "credits.adjusted",
    subject: "person",
    data: z.object({ grant_id: uuid, credit_kind: creditKind, quantity: z.number().int(), remaining_units: remaining }),
  }),
  defineEvent({
    kind: "credits.revoked",
    subject: "person",
    data: z.object({ grant_id: uuid, credit_kind: creditKind, units }),
  }),
  defineEvent({
    kind: "credits.transferred_out",
    subject: "person",
    data: z.object({ grant_id: uuid, credit_kind: creditKind, units, to_grant_id: uuid }),
  }),
  defineEvent({
    kind: "credits.transferred_in",
    subject: "person",
    data: z.object({ grant_id: uuid, credit_kind: creditKind, units, from_grant_id: uuid }),
  }),
  // R2 (credits-P8 writes them; declared here with the other `credits.*` kinds).
  defineEvent({
    kind: "credits.share_added",
    subject: "person",
    data: z.object({ grant_id: uuid, credit_kind: creditKind, share_id: uuid, owner_person_id: uuid, shared_with_person_id: uuid }),
  }),
  defineEvent({
    kind: "credits.share_revoked",
    subject: "person",
    data: z.object({ grant_id: uuid, credit_kind: creditKind, share_id: uuid, owner_person_id: uuid, shared_with_person_id: uuid }),
  }),
];
