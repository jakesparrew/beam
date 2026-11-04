/**
 * Column mapping presets for the old tools' exports (ops rules 47a and 53, runbook
 * `docs/runbooks/data-migration.md`). Each preset maps CSV headers of one export to the target
 * fields of exactly one import kind; staff can still change every column before the dry run.
 * Webinar presets follow webinar's V1 stopgap rules 1-7 (registrants and attendees of
 * WebinarGeek and Zoom, kind `history`).
 */
import { IMPORT_TARGETS, type ImportKind, type ImportSource } from "./import-targets";

export type ImportPreset = {
  source: ImportSource;
  kind: ImportKind;
  /** CSV header (as exported by the tool) to target field; unknown headers stay unmapped. */
  columns: Readonly<Record<string, string>>;
  delimiter: "," | ";" | "\t";
  dateFormat: "iso" | "dd/mm/yyyy" | "mm/dd/yyyy";
  /** Fixed `history_kind` of every row (webinar presets), else read from a column. */
  historyKind?: "webinar_registration" | "webinar_attendance" | "purchase" | "visit";
  /** crm `persons.external_ids` key the preset's ids are written to (rule 50). */
  externalIdKey?: "simplybook" | "lightspeed" | "mailchimp" | "sheet" | "webinargeek" | "typeform" | "scoreapp";
  /** Webinar provider recorded in `imported_history.data.provider`. */
  provider?: "webinargeek" | "zoom";
};

export const IMPORT_PRESETS = {
  simplybook_clients: {
    source: "simplybook",
    kind: "persons",
    delimiter: ";",
    dateFormat: "dd/mm/yyyy",
    externalIdKey: "simplybook",
    columns: { "Client ID": "external_id", Email: "email", Phone: "phone", Name: "first_name", Surname: "last_name", Address: "street", Zip: "postal_code", City: "city", Country: "country", "Created at": "created_at" },
  },
  simplybook_bookings: {
    source: "simplybook",
    kind: "bookings",
    delimiter: ";",
    dateFormat: "dd/mm/yyyy",
    externalIdKey: "simplybook",
    columns: { "Booking ID": "external_id", "Client email": "email", "Start date time": "session_starts_at", Service: "session_kind", "Payment method": "paid_with" },
  },
  simplybook_history: {
    source: "simplybook",
    kind: "history",
    delimiter: ";",
    dateFormat: "dd/mm/yyyy",
    externalIdKey: "simplybook",
    columns: { "Booking ID": "external_id", "Client email": "email", Status: "history_kind", "Start date time": "occurred_at", Service: "session_kind", Price: "amount_cents" },
  },
  simplybook_packages: {
    source: "simplybook",
    kind: "packages",
    delimiter: ";",
    dateFormat: "dd/mm/yyyy",
    externalIdKey: "simplybook",
    columns: { "Package instance ID": "external_id", "Client email": "email", "Package code": "product_sku", "Remaining": "units_remaining", "Total": "units_original", "Expires": "expires_on" },
  },
  simplybook_memberships: {
    source: "simplybook",
    kind: "memberships",
    delimiter: ";",
    dateFormat: "dd/mm/yyyy",
    externalIdKey: "simplybook",
    columns: { "Membership ID": "external_id", "Client email": "email", "Membership code": "product_sku", "Valid until": "period_end_on", "Start date": "started_on", Status: "status" },
  },
  lightspeed_customers: {
    source: "lightspeed",
    kind: "persons",
    delimiter: ",",
    dateFormat: "iso",
    externalIdKey: "lightspeed",
    columns: { "Customer ID": "external_id", Email: "email", Phone: "phone", "First name": "first_name", "Last name": "last_name", "Zip code": "postal_code", City: "city", Country: "country" },
  },
  lightspeed_sales: {
    source: "lightspeed",
    kind: "history",
    delimiter: ",",
    dateFormat: "iso",
    externalIdKey: "lightspeed",
    historyKind: "purchase",
    columns: { "Receipt ID": "external_id", "Customer email": "email", Date: "occurred_at", "Total incl. VAT": "amount_cents", Category: "product_kind", Description: "description" },
  },
  mailchimp_members: {
    source: "mailchimp",
    kind: "persons",
    delimiter: ",",
    dateFormat: "iso",
    externalIdKey: "mailchimp",
    columns: { LEID: "external_id", "Email Address": "email", "First Name": "first_name", "Last Name": "last_name", Phone: "phone", OPTIN_TIME: "created_at", Language: "locale" },
  },
  mailchimp_consents: {
    source: "mailchimp",
    kind: "consents",
    delimiter: ",",
    dateFormat: "iso",
    externalIdKey: "mailchimp",
    columns: { "Email Address": "email", Status: "status", CONFIRM_TIME: "recorded_at", Source: "source" },
  },
  mailchimp_unsubscribed: {
    source: "mailchimp",
    kind: "suppressions",
    delimiter: ",",
    dateFormat: "iso",
    externalIdKey: "mailchimp",
    columns: { "Email Address": "email", UNSUB_TIME: "suppressed_at", UNSUB_CAMPAIGN_TITLE: "reason" },
  },
  mailchimp_cleaned: {
    source: "mailchimp",
    kind: "suppressions",
    delimiter: ",",
    dateFormat: "iso",
    externalIdKey: "mailchimp",
    columns: { "Email Address": "email", CLEAN_TIME: "suppressed_at", CLEAN_CAMPAIGN_TITLE: "reason" },
  },
  mailchimp_tags: {
    source: "mailchimp",
    kind: "tags",
    delimiter: ",",
    dateFormat: "iso",
    externalIdKey: "mailchimp",
    columns: { "Email Address": "email", TAGS: "tag_key" },
  },
  webinargeek_registrants: {
    source: "webinar_tool",
    kind: "history",
    delimiter: ";",
    dateFormat: "dd/mm/yyyy",
    externalIdKey: "webinargeek",
    provider: "webinargeek",
    historyKind: "webinar_registration",
    columns: { Email: "email", "Registration date": "occurred_at", "Webinar title": "webinar_title", "Broadcast date": "webinar_starts_at", "Webinar ID": "external_id" },
  },
  webinargeek_attendees: {
    source: "webinar_tool",
    kind: "history",
    delimiter: ";",
    dateFormat: "dd/mm/yyyy",
    externalIdKey: "webinargeek",
    provider: "webinargeek",
    historyKind: "webinar_attendance",
    columns: { Email: "email", "Watched at": "occurred_at", "Webinar title": "webinar_title", "Broadcast date": "webinar_starts_at", "Webinar ID": "external_id" },
  },
  zoom_registrants: {
    source: "webinar_tool",
    kind: "history",
    delimiter: ",",
    dateFormat: "mm/dd/yyyy",
    provider: "zoom",
    historyKind: "webinar_registration",
    columns: { Email: "email", "Registration Time": "occurred_at", Topic: "webinar_title", "Start Time": "webinar_starts_at", "Webinar ID": "external_id" },
  },
  zoom_attendees: {
    source: "webinar_tool",
    kind: "history",
    delimiter: ",",
    dateFormat: "mm/dd/yyyy",
    provider: "zoom",
    historyKind: "webinar_attendance",
    columns: { Email: "email", "Join Time": "occurred_at", Topic: "webinar_title", "Start Time": "webinar_starts_at", "Webinar ID": "external_id" },
  },
} as const satisfies Record<string, ImportPreset>;

export type ImportPresetKey = keyof typeof IMPORT_PRESETS;

/** The four webinar presets of webinar's V1 stopgap (rule 47a). */
export const WEBINAR_PRESET_KEYS = ["webinargeek_registrants", "webinargeek_attendees", "zoom_registrants", "zoom_attendees"] as const satisfies readonly ImportPresetKey[];

/** The presets of one source and kind, for the mapping step's picker. */
export function presetsFor(source: ImportSource, kind: ImportKind): ImportPresetKey[] {
  return (Object.keys(IMPORT_PRESETS) as ImportPresetKey[]).filter((k) => {
    const p: ImportPreset = IMPORT_PRESETS[k];
    return p.source === source && p.kind === kind;
  });
}

/** Whether every column of a preset maps to a target of its kind. */
export function presetTargetsValid(preset: ImportPreset): boolean {
  const allowed: readonly string[] = IMPORT_TARGETS[preset.kind];
  return Object.values(preset.columns).every((t) => allowed.includes(t));
}
