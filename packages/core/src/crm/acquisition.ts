/**
 * `AcquisitionSchema` (crm spec 2.1, rule 3.4): where a person came from, written once in the
 * creating transaction. `guest` needs the booking owner as `referrer_person_id`.
 */
import { z } from "zod";
import { ACQUISITION_SOURCES, type Acquisition } from "./types";

const short = z.string().trim().min(1).max(200);

const AcquisitionFields = z.object({
  source: z.enum(ACQUISITION_SOURCES),
  campaign: short.optional(),
  medium: short.optional(),
  funnel: short.optional(),
  utm: z
    .object({ source: short.optional(), medium: short.optional(), campaign: short.optional(), term: short.optional(), content: short.optional() })
    .strict()
    .optional(),
  referrer_person_id: z.uuid().optional(),
  referral_code: z.string().trim().min(1).max(64).optional(),
  partner_company_id: z.uuid().optional(),
  event_session_id: z.uuid().optional(),
  webinar_id: z.uuid().optional(),
  form_slug: z.string().trim().min(1).max(120).optional(),
});

const guestNeedsReferrer = (a: { source: string; referrer_person_id?: string }) => a.source !== "guest" || !!a.referrer_person_id;
const guestMessage = { message: "guest_needs_referrer_person_id", path: ["referrer_person_id"] };

/** The stored shape, including `captured_at`. */
export const AcquisitionSchema = AcquisitionFields.extend({ captured_at: z.iso.datetime({ offset: true }) })
  .strict()
  .refine(guestNeedsReferrer, guestMessage);

/** What callers pass (`Omit<Acquisition, 'captured_at'>`); crm stamps `captured_at`. */
export const AcquisitionInputSchema = AcquisitionFields.strict().refine(guestNeedsReferrer, guestMessage);

export type AcquisitionInput = Omit<Acquisition, "captured_at">;

/** The stored acquisition for an input, stamped with `at`. Throws a ZodError on invalid input. */
export function captureAcquisition(input: AcquisitionInput, at: Date): Acquisition {
  const parsed = AcquisitionInputSchema.parse(input);
  return { ...parsed, captured_at: at.toISOString() };
}

/** True when a stored acquisition already has a source (rule 3.4: written once). */
export function hasAcquisitionSource(stored: { source?: unknown } | null | undefined): boolean {
  return typeof stored?.source === "string" && stored.source.length > 0;
}

/** Erasure keeps only `{ source, campaign, medium }` for aggregate attribution (crm spec 9). */
export function reduceAcquisitionForErasure(stored: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["source", "campaign", "medium"] as const) if (stored?.[k] !== undefined) out[k] = stored[k];
  return out;
}
