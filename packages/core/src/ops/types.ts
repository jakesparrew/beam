/**
 * ops types named in the cross-module contract (02-data-model section 6.10). Wave 0 skeleton
 * by platform-P7; ops owns this file from ops-P1 on.
 */
export type ModuleId =
  | "platform"
  | "crm"
  | "booking"
  | "commerce"
  | "credits"
  | "finance"
  | "forms"
  | "email"
  | "automation"
  | "ops"
  | "site"
  | "webinar";

/** Values of ops' `dpia_records_key` enum (cross-module D38). */
export type DpiaKey =
  | "sensitive_assessment_processing"
  | "behavioural_scoring"
  | "ai_customer_ranking"
  | "watch_time_profiling"
  | "b2b_prospecting"
  | "voice_ai";

export type PrivacyKind = "export" | "erase" | "restrict" | "rectify" | "object";
export type PrivacyStatus = "received" | "verified" | "running" | "done" | "failed" | "cancelled";

/** A retention-list reason key (ops retention lists, R2); ops narrows it to its eight list keys. */
export type RetentionReason = string;

/** Ops rule 62: module erase handlers run in this order after the external propagation. */
export const ERASE_ORDER: readonly ModuleId[] = [
  "webinar",
  "automation",
  "email",
  "forms",
  "booking",
  "credits",
  "commerce",
  "finance",
  "site",
  "ops",
  "crm",
  "platform",
];
