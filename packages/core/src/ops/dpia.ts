/**
 * The DPIA register (ops rule 70, blueprint 66): six higher-risk processing activities, one
 * `dpia_records` row each. A feature in `DPIA_GATED` stays off until its record is `approved`
 * or `not_required`; `isDpiaApproved(db, key)` in ops' api is the one check.
 */
import type { DpiaKey } from "./types";

export const DPIA_KEYS = [
  "sensitive_assessment_processing",
  "behavioural_scoring",
  "ai_customer_ranking",
  "watch_time_profiling",
  "b2b_prospecting",
  "voice_ai",
] as const satisfies readonly DpiaKey[];

export const DPIA_STATUSES = ["not_started", "in_progress", "approved", "rejected", "not_required"] as const;
export type DpiaStatus = (typeof DPIA_STATUSES)[number];

/** Statuses that switch a gated feature on. */
export const DPIA_OPEN_STATUSES: readonly DpiaStatus[] = ["approved", "not_required"];

/** Whether a DPIA status lets its gated features run. */
export function isDpiaStatusApproved(status: DpiaStatus): boolean {
  return DPIA_OPEN_STATUSES.includes(status);
}

/** Setting `approved` or `not_required` needs a `decision_note` (rule 70). */
export function dpiaNeedsDecisionNote(status: DpiaStatus): boolean {
  return isDpiaStatusApproved(status);
}

/** The features each DPIA gates (rule 70); `b2b_prospecting` and `voice_ai` gate nothing yet. */
export const DPIA_GATED: Readonly<Record<DpiaKey, readonly string[]>> = {
  sensitive_assessment_processing: ["forms.publish_sensitive_version", "platform.sensitive_ai_switch"],
  behavioural_scoring: ["ops.churn_indicators", "ops.opportunity_scores"],
  ai_customer_ranking: ["ops.ai_questions_ranking"],
  watch_time_profiling: ["ops.profile_watch_time", "automation.webinar_behaviour_journeys"],
  b2b_prospecting: [],
  voice_ai: [],
};

/** Relations of the `ai` schema an NL question may read only while the DPIA is approved (rule 77). */
export const DPIA_GATED_AI_RELATIONS: Readonly<Partial<Record<DpiaKey, readonly string[]>>> = {
  ai_customer_ranking: ["ai.retention_candidates", "ai.customers"],
};
