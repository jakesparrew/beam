/**
 * The segment compiler's field allow-list (crm spec rule 27 and section 4, architecture
 * section 4). Wave 0 initial list by platform-P7; crm owns it from Wave 1 and builds it from
 * ops' `PERSON_PROFILE_COLUMNS`. No `SENSITIVE_FIELD_KEYS` member may ever appear here
 * (`apps/web/test/registries.test.ts`).
 */
export type SegmentFieldType = "enum" | "boolean" | "number" | "date" | "text" | "text_array" | "uuid_array";

export type SegmentField = { column: string; type: SegmentFieldType; label: string };

const f = (column: string, type: SegmentFieldType): SegmentField => ({ column, type, label: `crm.segments.fields.${column}` });

export const SEGMENT_FIELDS: readonly SegmentField[] = [
  f("status", "enum"),
  f("is_member", "boolean"),
  f("membership_status", "enum"),
  f("membership_period_end_at", "date"),
  f("b2c_stage", "enum"),
  f("locale", "enum"),
  f("country", "text"),
  f("postal_code", "text"),
  f("city", "text"),
  f("acquisition_source", "enum"),
  f("acquisition_campaign", "text"),
  f("acquisition_medium", "text"),
  f("created_at", "date"),
  f("revenue_cents", "number"),
  f("lifetime_value_cents", "number"),
  f("purchases", "number"),
  f("visits", "number"),
  f("events_attended", "number"),
  f("no_shows", "number"),
  f("avg_order_cents", "number"),
  f("first_purchase_at", "date"),
  f("last_purchase_at", "date"),
  f("first_visit_at", "date"),
  f("last_visit_at", "date"),
  f("last_activity_at", "date"),
  f("days_since_activity", "number"),
  f("next_booking_at", "date"),
  f("has_future_booking", "boolean"),
  f("credits_day_remaining", "number"),
  f("credits_night_remaining", "number"),
  f("credits_euro_remaining", "number"),
  f("next_grant_expires_at", "date"),
  f("package_product_ids", "uuid_array"),
  f("tags", "text_array"),
  f("consent_newsletter", "boolean"),
  f("consent_events", "boolean"),
  f("consent_member_comms", "boolean"),
  f("consent_b2b", "boolean"),
  f("is_suppressed_all", "boolean"),
  f("is_company_contact", "boolean"),
  f("has_waitlist_waiting", "boolean"),
  f("last_assessment_form_slug", "text"),
  f("last_assessment_outcome_key", "text"),
  f("is_tester", "boolean"),
];

/** The column names only (what `registries.test.ts` checks against the sensitive keys). */
export const SEGMENT_ALLOWED_FIELDS: readonly string[] = SEGMENT_FIELDS.map((x) => x.column);
