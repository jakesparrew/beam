/**
 * crm types named in the cross-module contract (02-data-model section 6.2). Wave 0 skeleton by
 * platform-P7; crm owns this file from crm-P1 on and may widen the shapes, never rename them.
 */
import type { Locale } from "../i18n/locales";

export type PersonStatus = "lead" | "customer" | "member";

/** crm spec section 2 (`AcquisitionSchema`). */
export type AcquisitionSource =
  | "website"
  | "landing_page"
  | "paid_meta"
  | "paid_google"
  | "paid_other"
  | "organic_search"
  | "social_media"
  | "webinar"
  | "event"
  | "referral"
  | "partner"
  | "customer_introduction"
  | "guest"
  | "walk_in"
  | "qr_code"
  | "b2b_campaign"
  | "import"
  | "manual"
  | "other";

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

export type ConsentPurpose =
  | "newsletter"
  | "events"
  | "member_comms"
  | "b2b"
  | "assessment_result"
  | "sensitive_processing"
  | "ai_processing";
export type MarketingPurpose = "newsletter" | "events" | "member_comms" | "b2b";
export type ConsentMethod = "form" | "portal" | "import" | "staff" | "preference_centre" | "unsubscribe_link" | "complaint";
export type ConsentState = {
  status: "granted" | "withdrawn";
  method: ConsentMethod;
  source: string;
  wordingVersion: string;
  recordedAt: Date;
};
export type SuppressionScope = "all" | MarketingPurpose;
export type SuppressionReason = "unsubscribe" | "hard_bounce" | "complaint" | "manual" | "erased";

export type PersonTagSource = "manual" | "automation" | "import" | "form";
export type TaskKind = "call" | "follow_up" | "payment" | "proposal" | "review" | "other";
export type TaskPriority = "low" | "normal" | "high";
export type TaskSource = "manual" | "automation" | "retention" | "system";
export type CompanySize = "1_9" | "10_49" | "50_249" | "250_plus";
export type CompanyStatus = "target" | "prospect" | "customer" | "partner" | "inactive";
export type DecisionRole = "decision_maker" | "influencer" | "user" | "gatekeeper";
export type DuplicateReason = "email" | "phone" | "name_birth" | "name_postal_code" | (string & {});
export type TimelineCategory = "identity" | "consent" | "booking" | "commerce" | "credits" | "finance" | "forms" | "email" | "automation" | "note" | (string & {});

export type PostalAddress = { street: string; postalCode: string; city: string; country: string };

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

export type ExternalIdSource = "simplybook" | "lightspeed" | "mailchimp" | "sheet" | "webinargeek" | "typeform" | "scoreapp";

/** The one write path for person columns (cross-module D13). */
export type PersonFieldPatch = {
  firstName?: string;
  lastName?: string;
  phone?: string;
  birthOn?: string;
  postalCode?: string;
  city?: string;
  preferredChannel?: "email" | "phone" | "whatsapp";
  emergencyContact?: { name: string; phone: string; relation?: string };
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
