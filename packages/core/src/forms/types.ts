/**
 * forms types named in the cross-module contract (02-data-model section 6.7) and the pure engine
 * types of forms-P2 (forms spec section 3: F, L, S, P). Wave 0 skeleton by platform-P7; forms
 * owns this file from forms-P1 on. The Zod schemas of the JSON shapes live in `definition.ts`.
 */
import type { AcquisitionSource } from "../crm/types";
import type { Locale } from "../i18n/locales";
import type { LocalizedText } from "../i18n/localized-text";

export type { AcquisitionSource };

export const FORM_KINDS = ["lead", "intake", "survey", "assessment", "registration"] as const;
export type FormKind = (typeof FORM_KINDS)[number];
export type FormStatus = "draft" | "published" | "archived";
export type SubmissionStatus = "started" | "partial" | "abandoned" | "completed";

export type PublicFormRef = { id: string; slug: string; kind: FormKind; name: LocalizedText; locales: Locale[] };

export type PersonSubmissionSummary = {
  submissionId: string;
  formId: string;
  formSlug: string;
  formName: LocalizedText;
  version: number;
  status: SubmissionStatus;
  outcomeKey: string | null;
  outcomeLabel: LocalizedText | null;
  total: number | null;
  source: string;
  campaign: string | null;
  startedAt: Date;
  completedAt: Date | null;
  hasSensitive: boolean;
};

export type LatestOutcome = { formSlug: string; outcomeKey: string; totalScore: number | null; completedAt: Date };

export type UtmParams = Partial<Record<"source" | "medium" | "campaign" | "term" | "content", string>>;
/** UTM values as read from a landing URL (rule A1). */
export type Utm = UtmParams;

/** Props of forms' `FormEmbed` server component (site's published names). */
export type FormEmbedProps = {
  slug: string;
  locale: Locale;
  context: { pagePath: string; utm?: UtmParams; landingPath?: string; referrer?: string; partnerCompanyId?: string };
};

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type FieldKey = string;
export type SectionKey = string;
export type EndingKey = string;
export type DimensionKey = string;
export type OutcomeKey = string;

// ---------------------------------------------------------------------------
// Definition (rules F1 to F7)
// ---------------------------------------------------------------------------

export const FIELD_TYPES = [
  "single_choice",
  "multiple_choice",
  "yes_no",
  "rating",
  "number",
  "short_text",
  "long_text",
  "dropdown",
  "date",
  "email",
  "phone",
  "consent",
  "hidden",
  "utm",
  "acknowledgement",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const SENSITIVE_KINDS = ["health", "sleep", "stress", "recovery", "wellbeing"] as const;
export type SensitiveKind = (typeof SENSITIVE_KINDS)[number];

export const MAPS_TO = ["person.email", "person.first_name", "person.last_name", "person.phone", "person.birth_on"] as const;
export type MapsTo = (typeof MAPS_TO)[number];

/** Rule P6: the purposes a `consent` field may carry (`assessment_result` is never a field, C3). */
export const FORM_CONSENT_PURPOSES = ["newsletter", "events", "member_comms", "b2b", "sensitive_processing", "ai_processing"] as const;
export type FormConsentPurpose = (typeof FORM_CONSENT_PURPOSES)[number];
/** Purposes that must be freely given (`required: false`), rule P6. */
export const OPTIONAL_CONSENT_PURPOSES = ["newsletter", "events", "member_comms", "b2b", "ai_processing"] as const;
/** Marketing purposes (P6 sign-up exception, C5 age rule). */
export const MARKETING_CONSENT_PURPOSES = ["newsletter", "events", "member_comms", "b2b"] as const;

export const UTM_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
export type UtmParam = (typeof UTM_PARAMS)[number];

export const CONDITION_OPS = ["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "contains", "answered", "not_answered"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/** A literal compared in a field condition. */
export type ConditionValue = string | number | boolean | (string | number)[];

/** Rule F4: recursive, max depth 6 and 50 leaves. `score` is a dimension key or `total`. */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { field: FieldKey; op: ConditionOp; value?: ConditionValue }
  | { score: DimensionKey | "total"; op: ConditionOp; value: number }
  | { range: { dimension: DimensionKey | "total"; key: string } };

export type ChoiceOption = { key: string; label: LocalizedText; scores?: Record<DimensionKey, number> };

type FieldBase = {
  key: FieldKey;
  label: LocalizedText;
  help?: LocalizedText;
  placeholder?: LocalizedText;
  required: boolean;
  visibleIf?: Condition;
  sensitive: boolean;
  sensitiveKind?: SensitiveKind;
  mapsTo?: MapsTo;
};

export type SingleChoiceField = FieldBase & { type: "single_choice"; options: ChoiceOption[] };
export type DropdownField = FieldBase & { type: "dropdown"; options: ChoiceOption[] };
export type MultipleChoiceField = FieldBase & { type: "multiple_choice"; options: ChoiceOption[]; minSelected?: number; maxSelected?: number };
/** Answer `true` (yes) or `false` (no); `scores.yes` / `scores.no` weigh the answer (S2). */
export type YesNoField = FieldBase & { type: "yes_no"; scores?: { yes?: Record<DimensionKey, number>; no?: Record<DimensionKey, number> } };
export type RatingField = FieldBase & { type: "rating"; scale: 5 | 10; weights?: Record<DimensionKey, number> };
export type NumberField = FieldBase & { type: "number"; min?: number; max?: number; step?: number; weights?: Record<DimensionKey, number> };
export type ShortTextField = FieldBase & { type: "short_text"; maxLength?: number };
export type LongTextField = FieldBase & { type: "long_text"; maxLength?: number };
export type DateField = FieldBase & { type: "date"; min?: string; max?: string };
export type EmailField = FieldBase & { type: "email" };
export type PhoneField = FieldBase & { type: "phone" };
export type ConsentField = FieldBase & { type: "consent"; purpose: FormConsentPurpose; wording: LocalizedText };
/** Always required, stored as `true`; proof of acknowledgement, never a consent purpose (F2). */
export type AcknowledgementField = FieldBase & { type: "acknowledgement"; text: LocalizedText };
export type HiddenField = FieldBase & { type: "hidden"; from: "query" | "constant"; param?: string; value?: string };
export type UtmField = FieldBase & { type: "utm"; param: UtmParam };

export type Field =
  | SingleChoiceField
  | DropdownField
  | MultipleChoiceField
  | YesNoField
  | RatingField
  | NumberField
  | ShortTextField
  | LongTextField
  | DateField
  | EmailField
  | PhoneField
  | ConsentField
  | AcknowledgementField
  | HiddenField
  | UtmField;

export type ChoiceField = SingleChoiceField | DropdownField | MultipleChoiceField;

export type Section = {
  key: SectionKey;
  title?: LocalizedText;
  description?: LocalizedText;
  fieldKeys: FieldKey[];
  visibleIf?: Condition;
};

export type LogicRule = {
  key: string;
  afterSection: SectionKey;
  if: Condition;
  then: { goto: SectionKey } | { end: EndingKey };
};

export const CTA_KINDS = ["booking", "event", "product", "experience", "webinar", "url"] as const;
export type CtaKind = (typeof CTA_KINDS)[number];

export type Cta = {
  key: string;
  label: LocalizedText;
  kind: CtaKind;
  sessionTemplateId?: string;
  sessionId?: string;
  productId?: string;
  webinarId?: string;
  url?: string;
};

export type EndingKind = "result" | "thank_you" | "redirect";

export type Ending = {
  key: EndingKey;
  kind: EndingKind;
  title: LocalizedText;
  body: LocalizedText;
  showScore: boolean;
  showDimensions: DimensionKey[];
  ctas: Cta[];
  redirectUrl?: string;
  email?: { subject: LocalizedText; intro: LocalizedText };
};

export type FormSettings = {
  resumeEnabled: boolean;
  resumeDays: number;
  skipKnownFields: boolean;
  capturePartialLeads: boolean;
  showProgress: boolean;
  sendResultEmail: boolean;
  submitLabel: LocalizedText;
  createInboxThread: boolean;
  funnel?: string;
  validityDays?: number;
  staffEntryAllowed: boolean;
};

export type FormDefinition = {
  title: LocalizedText;
  intro?: LocalizedText;
  settings: FormSettings;
  sections: Section[];
  fields: Record<FieldKey, Field>;
  logic: LogicRule[];
  endings: Ending[];
};

// ---------------------------------------------------------------------------
// Scoring (rules S1 to S8)
// ---------------------------------------------------------------------------

export type Range = {
  key: string;
  from: number;
  to: number;
  label: LocalizedText;
  explanation?: LocalizedText;
  recommendation?: LocalizedText;
};

export type Dimension = {
  key: DimensionKey;
  label: LocalizedText;
  kind: "sum" | "avg" | "formula";
  formula?: string;
  min?: number;
  max?: number;
  ranges: Range[];
};

export type Outcome = {
  key: OutcomeKey;
  label: LocalizedText;
  priority: number;
  when: Condition;
  endingKey: EndingKey;
  tagKeys: string[];
  explanation?: LocalizedText;
  recommendation?: LocalizedText;
};

/** `{}` in the database = not scored; the schema fills `dimensions: []` and `outcomes: []`. */
export type FormScoring = {
  dimensions: Dimension[];
  total?: { kind: "sum_dimensions" | "formula"; formula?: string; ranges: Range[] };
  outcomes: Outcome[];
  defaultOutcomeKey?: OutcomeKey;
};

// ---------------------------------------------------------------------------
// Answers and scores
// ---------------------------------------------------------------------------

export type AnswerValue = string | number | boolean | string[] | null;
export type Answers = Record<FieldKey, AnswerValue>;

export type DimensionScore = { value: number | null; rangeKey: string | null };

/** What conditions read: the total and every dimension. */
export type ScoreState = {
  total: number | null;
  totalRangeKey: string | null;
  dimensions: Record<DimensionKey, DimensionScore>;
};

/** `computeScore` result: all dimensions (sensitive ones included, kept in memory only, S6). */
export type ScoreResult = ScoreState & {
  /** Dimensions that are sensitive (S6); stored only as `score:<key>` in `form_sensitive_answers`. */
  sensitiveDimensionKeys: DimensionKey[];
  /** True when the total depends on a sensitive dimension, so it is never stored in plain form. */
  totalSensitive: boolean;
};

// ---------------------------------------------------------------------------
// Import (rule I2)
// ---------------------------------------------------------------------------

/** Dotted path with `[n]` indexes and `[field.ref=<ref>]` selectors. */
export type JsonPath = string;

export type ImportMapping = {
  email: JsonPath;
  firstName?: JsonPath;
  lastName?: JsonPath;
  phone?: JsonPath;
  locale?: JsonPath;
  externalId: JsonPath;
  completedAt?: JsonPath;
  score?: JsonPath;
  outcome?: JsonPath;
  outcomeMap?: Record<string, OutcomeKey>;
  answers: Record<FieldKey, JsonPath>;
  sensitiveFieldKeys: FieldKey[];
  consents?: Partial<Record<FormConsentPurpose, JsonPath>>;
};

// ---------------------------------------------------------------------------
// Publish validation (rules P1 to P8)
// ---------------------------------------------------------------------------

export const PUBLISH_ISSUE_CODES = [
  // P2
  "incomplete_text",
  // F7 and schema
  "invalid_shape",
  // P3
  "no_section",
  "duplicate_key",
  "invalid_key",
  "field_not_in_section",
  "field_in_two_sections",
  "unknown_field",
  "unknown_section",
  "unknown_dimension",
  "unknown_range",
  "unknown_ending",
  "unknown_outcome",
  "hidden_field_not_first",
  "goto_not_forward",
  "condition_forward_reference",
  "condition_too_deep",
  "condition_too_many_leaves",
  "sensitive_in_logic",
  "formula_invalid",
  "dimension_cycle",
  "no_ending",
  "default_outcome_missing",
  "range_overlap",
  "range_invalid",
  "cta_target_missing",
  "redirect_url_missing",
  "invalid_option",
  "limit_exceeded",
  "acknowledgement_not_required",
  // P4
  "email_field_missing",
  "result_email_missing",
  // P5
  "sensitive_consent_missing",
  "sensitive_consent_late",
  // P6
  "consent_purpose_invalid",
  "consent_must_be_optional",
  // P7 (server checks, reported with the same shape)
  "dpia_not_approved",
  // P8 warnings
  "unreachable_section",
  "unreachable_ending",
  "outcome_unselectable",
  "long_text_not_sensitive",
  "result_without_cta",
] as const;
export type PublishIssueCode = (typeof PUBLISH_ISSUE_CODES)[number];

export type PublishIssue = {
  level: "error" | "warning";
  code: PublishIssueCode;
  /** Dotted path into `{ definition, scoring }`, for example `fields.sleep_hours.label`. */
  path: string;
  message: string;
  /** For `incomplete_text`: the missing locales. */
  locales?: Locale[];
};

// ---------------------------------------------------------------------------
// Attribution (rule A2)
// ---------------------------------------------------------------------------

export const FORM_LINK_CHANNELS = ["link", "qr", "ad", "email", "social", "partner", "referral", "print", "b2b"] as const;
export type FormLinkChannel = (typeof FORM_LINK_CHANNELS)[number];
