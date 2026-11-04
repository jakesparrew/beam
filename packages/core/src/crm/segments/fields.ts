/**
 * The segment compiler's allow-lists (crm spec 4.6, rules 3.27 and 3.38). Field rules may only
 * name these `v_person_profile` columns (ops' `PERSON_PROFILE_COLUMNS` names), event rules only
 * these `activity_events` kinds and `data` keys, with the writers' exact spelling. No
 * `SENSITIVE_FIELD_KEYS` member and no `is_sensitive` event ever appears here (unit test).
 */
import { LOCALES } from "../../i18n/locales";
import { ACQUISITION_SOURCES, PERSON_STATUSES } from "../types";

export type SegmentFieldType = "enum" | "text" | "number" | "timestamp" | "text[]" | "boolean";

export type SegmentField = {
  column: string;
  type: SegmentFieldType;
  /** i18n key of the label (`crm.segments.fields.<column>`). */
  label: string;
  options?: readonly string[];
};

/** The comparators each field type allows (crm spec 4.6). */
export const COMPARATORS_BY_TYPE = {
  enum: ["eq", "neq", "in", "not_in", "is_null", "is_not_null"],
  text: ["eq", "neq", "in", "not_in", "is_null", "is_not_null"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_null"],
  timestamp: ["before", "after", "within_last_days", "more_than_days_ago", "within_next_days", "is_null", "is_not_null"],
  "text[]": ["contains_any", "contains_all", "contains_none"],
  boolean: ["is_true", "is_false"],
} as const satisfies Record<SegmentFieldType, readonly string[]>;

export const COMPARATORS = [...new Set(Object.values(COMPARATORS_BY_TYPE).flat())] as Comparator[];
export type Comparator = (typeof COMPARATORS_BY_TYPE)[SegmentFieldType][number];

const MEMBERSHIP_STATUSES = ["pending", "active", "past_due", "cancelled", "expired"] as const;
const B2C_STAGES = ["lead", "engaged_lead", "experienced", "first_visit", "first_purchase", "active", "repeat", "member", "retention", "lost"] as const;

const f = (column: string, type: SegmentFieldType, options?: readonly string[]): SegmentField => ({
  column,
  type,
  label: `crm.segments.fields.${column}`,
  ...(options ? { options } : {}),
});

/** V1 fields of `v_person_profile` (ops), in the builder's display order. */
export const SEGMENT_FIELDS: readonly SegmentField[] = [
  f("status", "enum", PERSON_STATUSES),
  f("is_member", "boolean"),
  f("membership_status", "enum", MEMBERSHIP_STATUSES),
  f("membership_period_end_at", "timestamp"),
  f("b2c_stage", "enum", B2C_STAGES),
  f("locale", "enum", LOCALES),
  f("country", "text"),
  f("postal_code", "text"),
  f("city", "text"),
  f("acquisition_source", "enum", ACQUISITION_SOURCES),
  f("acquisition_campaign", "text"),
  f("acquisition_medium", "text"),
  f("created_at", "timestamp"),
  f("revenue_cents", "number"),
  f("lifetime_value_cents", "number"),
  f("purchases", "number"),
  f("visits", "number"),
  f("events_attended", "number"),
  f("no_shows", "number"),
  f("avg_order_cents", "number"),
  f("first_purchase_at", "timestamp"),
  f("last_purchase_at", "timestamp"),
  f("first_visit_at", "timestamp"),
  f("last_visit_at", "timestamp"),
  f("last_activity_at", "timestamp"),
  f("days_since_activity", "number"),
  f("next_booking_at", "timestamp"),
  f("has_future_booking", "boolean"),
  f("credits_day_remaining", "number"),
  f("credits_night_remaining", "number"),
  f("credits_euro_remaining", "number"),
  f("next_grant_expires_at", "timestamp"),
  f("package_product_ids", "text[]"),
  f("tags", "text[]"),
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

/**
 * R2 webinar columns of `v_person_profile`. They join `SEGMENT_FIELDS` when ops adds them to
 * the view in R2, so the V1 field test never names a column that does not exist yet.
 */
export const SEGMENT_R2_FIELDS: readonly SegmentField[] = [
  f("webinars_registered", "number"),
  f("webinars_attended_live", "number"),
  f("webinars_watched_replay", "number"),
];

/** The column names (what `registries.test.ts` and the compiler check). */
export const SEGMENT_ALLOWED_FIELDS: readonly string[] = SEGMENT_FIELDS.map((x) => x.column);

export const SEGMENT_FIELD_BY_COLUMN: Readonly<Record<string, SegmentField>> = Object.fromEntries(SEGMENT_FIELDS.map((x) => [x.column, x]));

// ---------------------------------------------------------------------------
// Event rules
// ---------------------------------------------------------------------------

/**
 * forms `data` keys per kind, as forms' schemas in `apps/web/modules/forms/events.ts` declare
 * them (forms-P3): only the keys that kind's data actually carries.
 */
const FORM_STARTED_KEYS = ["form_slug", "funnel", "form_kind"];
const FORM_COMPLETED_KEYS = ["form_slug", "outcome_key", "funnel", "form_kind"];
const FORM_ABANDONED_KEYS = ["form_slug"];
const FORM_RESULT_VIEWED_KEYS = ["form_slug", "outcome_key"];
const ASSESSMENT_RESULT_KEYS = ["form_slug", "outcome_key", "funnel", "form_kind"];
const ASSESSMENT_CTA_KEYS = ["form_slug", "outcome_key", "cta_key"];
const BOOKING_KEYS = ["session_kind", "session_id", "event_category", "owner_person_id", "is_guest", "is_first_booking", "is_first_visit"];
const WAITLIST_KEYS = ["session_kind", "session_id", "queue"];
/** webinar `data` keys per kind, as the webinar event table (02-data-model section 7) declares them. */
const WEBINAR_REGISTERED_KEYS = ["webinar_id", "slug", "webinar_mode", "source", "person_status"];
const WEBINAR_ONLY_ID_KEYS = ["webinar_id"];

/** `where` keys allowed per event kind, spelled as the writer's `data` schema (crm spec 4.6). */
export const SEGMENT_EVENT_DATA_KEYS = {
  "booking.confirmed": BOOKING_KEYS,
  "booking.attended": BOOKING_KEYS,
  "booking.check_in_undone": BOOKING_KEYS,
  "booking.no_show": BOOKING_KEYS,
  "booking.cancelled": BOOKING_KEYS,
  "booking.late_cancelled": BOOKING_KEYS,
  "booking.event_ended": BOOKING_KEYS,
  "waitlist.joined": WAITLIST_KEYS,
  "waitlist.offered": WAITLIST_KEYS,
  "waitlist.confirmed": WAITLIST_KEYS,
  "waitlist.expired": WAITLIST_KEYS,
  "waitlist.requeued": WAITLIST_KEYS,
  "waitlist.released": WAITLIST_KEYS,
  "waitlist.withdrawn": WAITLIST_KEYS,
  "order.paid": [],
  "checkout.abandoned": [],
  "promotion.redeemed": [],
  "credits.threshold_reached": [],
  "credits.grant_expired": [],
  "credits.share_added": [],
  "membership.started": [],
  "membership.renewed": [],
  "membership.cancelled": [],
  "form.started": FORM_STARTED_KEYS,
  "form.completed": FORM_COMPLETED_KEYS,
  "form.abandoned": FORM_ABANDONED_KEYS,
  "form.result_viewed": FORM_RESULT_VIEWED_KEYS,
  "assessment.result_generated": ASSESSMENT_RESULT_KEYS,
  "assessment.cta_clicked": ASSESSMENT_CTA_KEYS,
  "email.opened": [],
  "email.clicked": [],
  "ops.stage_changed": ["from", "to"],
  "webinar.registered": WEBINAR_REGISTERED_KEYS,
  "webinar.started": WEBINAR_ONLY_ID_KEYS,
  "webinar.attended": ["webinar_id", "watched_sec"],
  "webinar.watched": ["webinar_id", "threshold", "watched_sec"],
  "webinar.no_show": ["webinar_id", "replay_available"],
  "webinar.poll_answered": ["webinar_id", "poll_key", "option_keys", "option_key"],
  "webinar.cta_clicked": ["webinar_id", "cta_key"],
  "webinar.question_asked": WEBINAR_ONLY_ID_KEYS,
  "webinar.chat_posted": WEBINAR_ONLY_ID_KEYS,
} as const satisfies Record<string, readonly string[]>;

export type AllowedEventKind = keyof typeof SEGMENT_EVENT_DATA_KEYS;

/**
 * Event kinds a segment may count. `referral.attributed` (credits, R3) joins this list when
 * credits declares the kind; the registry test checks every kind against the event registry.
 */
export const SEGMENT_ALLOWED_EVENT_KINDS = Object.keys(SEGMENT_EVENT_DATA_KEYS) as AllowedEventKind[];

/** `data` keys that hold an array (compiled to `data->key ? value`). */
export const SEGMENT_ARRAY_EVENT_KEYS: readonly string[] = ["option_keys"];
/** `data` keys that are numeric (accept `{ gte, lte }`, compiled to a numeric cast). */
export const SEGMENT_NUMERIC_EVENT_KEYS: readonly string[] = ["watched_sec", "threshold"];
