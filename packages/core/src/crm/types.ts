/**
 * crm types named in the cross-module contract (02-data-model section 6.2, crm spec section 2).
 * Owned by crm from crm-P1 on; shapes may widen, names never change.
 */
import type { Locale } from "../i18n/locales";
import type { LocalizedText } from "../i18n/localized-text";
import type { SensitiveFieldKey } from "../privacy/sensitive-keys";

export type { Locale, LocalizedText, SensitiveFieldKey };

/** Who did something, as stored in `actor jsonb` columns (architecture section 3). */
export type Actor = {
  kind: "staff" | "customer" | "system" | "job" | "webhook";
  id: string | null;
  roleKey?: string;
  provider?: string;
};

export const PERSON_STATUSES = ["lead", "customer", "member"] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];

/** crm spec section 2 (`AcquisitionSchema`). */
export const ACQUISITION_SOURCES = [
  "website",
  "landing_page",
  "paid_meta",
  "paid_google",
  "paid_other",
  "organic_search",
  "social_media",
  "webinar",
  "event",
  "referral",
  "partner",
  "customer_introduction",
  "guest",
  "walk_in",
  "qr_code",
  "b2b_campaign",
  "import",
  "manual",
  "other",
] as const;
export type AcquisitionSource = (typeof ACQUISITION_SOURCES)[number];

export type Acquisition = {
  source: AcquisitionSource;
  campaign?: string;
  medium?: string;
  funnel?: string;
  utm?: { source?: string; medium?: string; campaign?: string; term?: string; content?: string };
  referrer_person_id?: string;
  referral_code?: string;
  partner_company_id?: string;
  event_session_id?: string;
  webinar_id?: string;
  form_slug?: string;
  captured_at: string;
};

export const CONSENT_PURPOSES = [
  "newsletter",
  "events",
  "member_comms",
  "b2b",
  "assessment_result",
  "sensitive_processing",
  "ai_processing",
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const MARKETING_PURPOSES = ["newsletter", "events", "member_comms", "b2b"] as const;
export type MarketingPurpose = (typeof MARKETING_PURPOSES)[number];

export const CONSENT_METHODS = ["form", "portal", "import", "staff", "preference_centre", "unsubscribe_link", "complaint"] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

export type LawfulBasis = "consent" | "legitimate_interest";

export type ConsentState = {
  status: "granted" | "withdrawn";
  method: ConsentMethod;
  source: string;
  wordingVersion: string;
  recordedAt: Date;
  lawfulBasis?: LawfulBasis;
};

/** One `consent_records` row as the pure rules need it. */
export type ConsentRecordLike = {
  id: string;
  personId?: string;
  purpose: ConsentPurpose;
  status: "granted" | "withdrawn";
  method: ConsentMethod;
  source: string;
  wordingVersion: string;
  lawfulBasis?: LawfulBasis;
  recordedAt: Date;
  createdAt?: Date;
};

export type ConsentOutcome = "recorded" | "unchanged" | "needs_confirmation" | "skipped_suppressed" | "skipped_minor";

export const SUPPRESSION_SCOPES = ["all", ...MARKETING_PURPOSES] as const;
export type SuppressionScope = "all" | MarketingPurpose;
export const SUPPRESSION_REASONS = ["unsubscribe", "hard_bounce", "complaint", "manual", "erased"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** One `suppressions` row as the pure rules need it. */
export type SuppressionLike = { scope: SuppressionScope; reason: SuppressionReason; createdAt: Date };

export type PersonTagSource = "manual" | "automation" | "import" | "form";
export type TaskKind = "call" | "follow_up" | "payment" | "proposal" | "review" | "other";
export type TaskPriority = "low" | "normal" | "high";
export type TaskStatus = "open" | "done" | "cancelled";
export type TaskSource = "manual" | "automation" | "retention" | "system";
export type CompanySize = "1_9" | "10_49" | "50_249" | "250_plus";
export type CompanyStatus = "target" | "prospect" | "customer" | "partner" | "inactive";
export type DecisionRole = "decision_maker" | "influencer" | "user" | "gatekeeper";

/** Duplicate reasons (rule 3.28); `person_duplicate_candidates.reasons` values. */
export const DUPLICATE_REASONS = ["external_id", "email_variant", "phone", "name_birth", "name_postal"] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number] | (string & {});

/** Timeline categories (crm spec 4.7), by the kind's prefix before the dot. */
export const TIMELINE_CATEGORIES = ["profile", "bookings", "purchases", "email", "webinar", "forms", "automation", "service", "consent", "b2b"] as const;
export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number] | (string & {});

export type DeclarationKind = "guardian_consent";
export type DeclarationStatus = "accepted" | "revoked";
export type DeclarationMethod = "portal" | "reception" | "form" | "import";

/** `persons.address` (crm spec section 2). */
export type PostalAddress = { street?: string; number?: string; box?: string; postal_code?: string; city?: string; country: string };

export type EmergencyContact = { name: string; phone: string; relation?: string };

export type PersonSummary = {
  id: string;
  customerNumber: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  locale: Locale;
  status: PersonStatus;
  isTester: boolean;
  partnerCompanyId: string | null;
  mergedIntoPersonId: string | null;
  erasedAt: Date | null;
};

export type CompanySummary = {
  id: string;
  name: string;
  vatNumber: string | null;
  status: CompanyStatus;
  isPartner: boolean;
  commissionPct: number | null;
};

export type ExternalIdSource = "simplybook" | "lightspeed" | "mailchimp" | "sheet" | "webinargeek" | "typeform" | "scoreapp";

/** One row of an ops import mapped to person fields (ops imports, crm rule on upserts). */
export type ImportPersonRow = {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  locale?: Locale | null;
  birthOn?: string | null;
  postalCode?: string | null;
  city?: string | null;
  acquisition?: Omit<Acquisition, "captured_at">;
  externalIds?: Partial<Record<ExternalIdSource, string>>;
  tags?: string[];
};

/** The one write path for person columns (cross-module D13). */
export type PersonFieldPatch = {
  firstName?: string;
  lastName?: string;
  phone?: string;
  birthOn?: string;
  postalCode?: string;
  city?: string;
  preferredChannel?: "email" | "phone" | "whatsapp";
  emergencyContact?: EmergencyContact;
  externalIds?: Partial<Record<ExternalIdSource, string>>;
};

export type TimelineItem = {
  id: string;
  occurredAt: Date;
  kind: string;
  category: TimelineCategory;
  personId: string | null;
  companyId: string | null;
  data: Record<string, unknown>;
  isSensitive: boolean;
};

export type TimelinePage = { items: TimelineItem[]; nextBefore: { occurredAt: Date; id: string } | null };

/** `C-000123` from a customer number. */
export function formatCustomerNumber(n: number | bigint | string): string {
  return `C-${String(n).padStart(6, "0")}`;
}
