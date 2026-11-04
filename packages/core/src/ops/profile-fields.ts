/**
 * The columns of `v_person_profile` (ops spec 2.4), the only view the segment compiler targets.
 * crm builds `SEGMENT_ALLOWED_FIELDS` from this list, so every column is listed with its type.
 * It never contains `email`, `phone`, names, the birth date or any `SENSITIVE_COLUMNS` member.
 * `release` marks the R2 webinar columns; `dpia` marks a column present only while that DPIA
 * is approved (rule 70).
 */
import type { DpiaKey } from "./types";

export type ProfileColumnType = "uuid" | "text" | "text[]" | "uuid[]" | "integer" | "boolean" | "timestamptz" | "locale" | "date";

export type ProfileColumn = {
  name: string;
  type: ProfileColumnType;
  release: "V1" | "R2";
  /** The DPIA that must be approved before the column exists (rule 70). */
  dpia?: DpiaKey;
};

const v1 = (name: string, type: ProfileColumnType): ProfileColumn => ({ name, type, release: "V1" });
const r2 = (name: string, type: ProfileColumnType): ProfileColumn => ({ name, type, release: "R2" });

export const PERSON_PROFILE_COLUMNS: readonly ProfileColumn[] = [
  v1("person_id", "uuid"),
  v1("locale", "locale"),
  v1("created_at", "timestamptz"),
  v1("is_tester", "boolean"),
  v1("partner_company_id", "uuid"),
  v1("acquisition_source", "text"),
  v1("acquisition_campaign", "text"),
  v1("acquisition_medium", "text"),
  v1("postal_code", "text"),
  v1("city", "text"),
  v1("country", "text"),
  v1("status", "text"),
  v1("is_member", "boolean"),
  v1("tags", "text[]"),
  v1("revenue_cents", "integer"),
  v1("purchases", "integer"),
  v1("visits", "integer"),
  v1("events_attended", "integer"),
  v1("no_shows", "integer"),
  v1("avg_order_cents", "integer"),
  v1("first_purchase_at", "timestamptz"),
  v1("last_purchase_at", "timestamptz"),
  v1("first_visit_at", "timestamptz"),
  v1("last_visit_at", "timestamptz"),
  v1("last_activity_at", "timestamptz"),
  v1("next_booking_at", "timestamptz"),
  v1("has_future_booking", "boolean"),
  v1("b2c_stage", "text"),
  v1("days_since_activity", "integer"),
  v1("lifetime_value_cents", "integer"),
  v1("is_high_value", "boolean"),
  v1("credits_day_remaining", "integer"),
  v1("credits_night_remaining", "integer"),
  v1("credits_euro_remaining", "integer"),
  v1("next_grant_expires_at", "timestamptz"),
  v1("package_product_ids", "uuid[]"),
  v1("membership_status", "text"),
  v1("membership_period_end_at", "timestamptz"),
  v1("consent_newsletter", "boolean"),
  v1("consent_events", "boolean"),
  v1("consent_member_comms", "boolean"),
  v1("consent_b2b", "boolean"),
  v1("is_suppressed_all", "boolean"),
  v1("is_company_contact", "boolean"),
  v1("has_waitlist_waiting", "boolean"),
  v1("last_assessment_form_slug", "text"),
  v1("last_assessment_outcome_key", "text"),
  v1("imported_webinars_registered", "integer"),
  v1("imported_webinars_attended", "integer"),
  r2("webinars_registered", "integer"),
  r2("webinars_attended_live", "integer"),
  r2("last_webinar_attended_at", "timestamptz"),
  r2("webinars_watched_replay", "integer"),
  r2("webinars_watched_on_demand", "integer"),
  r2("webinar_poll_answers", "integer"),
  r2("webinar_cta_clicks", "integer"),
  r2("webinars_registered_total", "integer"),
  r2("webinars_attended_total", "integer"),
  { name: "watch_sec_total", type: "integer", release: "R2", dpia: "watch_time_profiling" },
];

/** Column names that must never appear in `v_person_profile` (besides `SENSITIVE_COLUMNS`). */
export const PROFILE_FORBIDDEN_COLUMNS = ["email", "phone", "first_name", "last_name", "birth_on", "street", "notes"] as const;

/** The V1 column names, in view order. */
export const PERSON_PROFILE_V1_COLUMNS: readonly string[] = PERSON_PROFILE_COLUMNS.filter((c) => c.release === "V1").map((c) => c.name);
