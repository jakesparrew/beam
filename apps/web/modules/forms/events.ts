/**
 * forms timeline events (forms spec section 3 E, section 4 "Event definitions"). Facade read by
 * `pnpm gen:indexes`. Every kind is recorded with `is_sensitive = false` (rule L6 keeps outcomes
 * and logic off sensitive answers), with `ref_type = 'form_submission'` and the dedupe keys of
 * the E table. `data` keys are snake_case and crm's (`form_slug`, `form_version_id`, `version`,
 * `score`, `outcome_key`, `submission_id`). The schemas are strict, so no answer value can ride
 * along (E2).
 */
import { z } from "zod";
import { ACQUISITION_SOURCES } from "@beam/core/crm";
import { CTA_KINDS, FORM_KINDS } from "@beam/core/forms";
import { defineEvent } from "@/lib/events";

const uuid = z.uuid();
const utm = z
  .object({ source: z.string(), medium: z.string(), campaign: z.string(), term: z.string(), content: z.string() })
  .partial()
  .strict();
const score = z.number().nullable();

/** `form.started` data (also the base of `form.completed`). */
export const formStartedData = z
  .object({
    submission_id: uuid,
    form_id: uuid,
    form_slug: z.string(),
    form_kind: z.enum(FORM_KINDS),
    form_version_id: uuid,
    version: z.number().int().positive(),
    source: z.enum(ACQUISITION_SOURCES),
    campaign: z.string().nullable(),
    funnel: z.string(),
    utm,
    link_key: z.string().nullable(),
  })
  .strict();

export const formCompletedData = formStartedData
  .extend({
    outcome_key: z.string().nullable(),
    score,
    dimensions: z.record(z.string(), z.string().nullable()),
    ending_key: z.string().nullable(),
    applied_tag_keys: z.array(z.string()),
    profile_conflicts: z.array(z.string()),
    via_import: z.boolean(),
    entered_by_staff: z.boolean(),
  })
  .strict();

export const resultGeneratedData = z
  .object({
    submission_id: uuid,
    form_slug: z.string(),
    form_kind: z.enum(FORM_KINDS),
    form_version_id: uuid,
    version: z.number().int().positive(),
    outcome_key: z.string().nullable(),
    score,
    funnel: z.string(),
    source: z.enum(ACQUISITION_SOURCES),
    result_email: z.enum(["queued", "not_sent"]),
  })
  .strict();

export const formAbandonedData = z
  .object({
    submission_id: uuid,
    form_slug: z.string(),
    form_version_id: uuid,
    last_section_key: z.string().nullable(),
    answered_count: z.number().int().nonnegative(),
  })
  .strict();

export const resultViewedData = z.object({ submission_id: uuid, form_slug: z.string(), outcome_key: z.string().nullable() }).strict();

export const ctaClickedData = z
  .object({
    submission_id: uuid,
    form_slug: z.string(),
    outcome_key: z.string().nullable(),
    cta_key: z.string(),
    cta_kind: z.enum(CTA_KINDS),
    target_id: z.string().nullable(),
    fallback: z.boolean(),
  })
  .strict();

export const events = [
  defineEvent({ kind: "form.started", subject: "person", isSensitive: false, data: formStartedData }),
  defineEvent({ kind: "form.completed", subject: "person", isSensitive: false, data: formCompletedData }),
  defineEvent({ kind: "assessment.result_generated", subject: "person", isSensitive: false, data: resultGeneratedData }),
  defineEvent({ kind: "form.abandoned", subject: "person", isSensitive: false, data: formAbandonedData }),
  defineEvent({ kind: "form.result_viewed", subject: "person", isSensitive: false, data: resultViewedData }),
  defineEvent({ kind: "assessment.cta_clicked", subject: "person", isSensitive: false, data: ctaClickedData }),
];
