/**
 * What the subject export's `README.txt` states besides the data (ops rule 60, GDPR article 15):
 * the categories of recipients (the subprocessor register of proposal section 9), the fixed
 * contractual purposes, the warnings of an erasure request and the supervisory authority. The
 * texts themselves are catalogue keys `ops.privacy.readme.*` in the three locales.
 */

export type Subprocessor = {
  key: string;
  /** Company names, never translated. */
  name: string;
  /** Catalogue key of the role (`ops.privacy.readme.role.<key>`). */
  roleKey: string;
  location: string;
  /** Catalogue key of the data processed (`ops.privacy.readme.data.<key>`). */
  dataKey: string;
  /** Transfer mechanism when data leaves the EEA. */
  transfer?: "SCC" | "DPF" | "SCC/DPF";
};

const sp = (key: string, name: string, location: string, transfer?: Subprocessor["transfer"]): Subprocessor => ({
  key,
  name,
  roleKey: `ops.privacy.readme.role.${key}`,
  location,
  dataKey: `ops.privacy.readme.data.${key}`,
  ...(transfer ? { transfer } : {}),
});

/** Proposal section 9, "Subprocessor register". */
export const SUBPROCESSORS: readonly Subprocessor[] = [
  sp("database", "Neon", "EU (Frankfurt)"),
  sp("hosting", "Vercel", "EU region", "SCC/DPF"),
  sp("email", "Resend", "EU (sending), US (delivery logs, 30 days)", "SCC/DPF"),
  sp("payments", "Mollie, Stripe, Viva Wallet", "EU"),
  sp("invoicing", "Billit", "Belgium / EU"),
  sp("webinar_video", "Google (YouTube Live, Meet)", "EU / US", "SCC/DPF"),
  sp("ai", "Anthropic (Claude)", "EU-hosted endpoint where available", "SCC/DPF"),
];

/** Purposes processed under the contract, listed in every README besides the consent purposes. */
export const CONTRACTUAL_PURPOSES = ["bookings", "payments", "invoicing", "packages_and_memberships", "customer_service", "legal_obligations"] as const;

/** Warnings an erasure must acknowledge (rule 61); stored in `privacy_requests.warnings`. */
export const PRIVACY_WARNINGS = ["active_membership", "credits_remaining", "future_bookings", "open_invoices", "open_orders"] as const;
export type PrivacyWarning = (typeof PRIVACY_WARNINGS)[number];

/** The Belgian supervisory authority named in the README (rule 60). */
export const SUPERVISORY_AUTHORITY = {
  "nl-BE": "Gegevensbeschermingsautoriteit",
  "fr-BE": "Autorité de protection des données",
  en: "Belgian Data Protection Authority",
  url: "https://www.dataprotectionauthority.be",
} as const;

/** Typed confirmation words of the portal erasure dialog (ops section 5). */
export const ERASE_CONFIRM_WORDS = { "nl-BE": "VERWIJDER", "fr-BE": "SUPPRIMER", en: "DELETE" } as const;

/** Rule 18(1) GDPR grounds of `processing_restrictions.reason`. */
export const RESTRICTION_REASONS = ["accuracy_contested", "unlawful_processing", "needed_for_legal_claims", "objection_pending"] as const;
export type RestrictionReason = (typeof RESTRICTION_REASONS)[number];

/** Person fields a subject may ask to rectify from the portal (field names only, rule 67). */
export const RECTIFY_FIELDS = ["first_name", "last_name", "email", "phone", "birth_on", "address", "locale", "company_name"] as const;
export type RectifyField = (typeof RECTIFY_FIELDS)[number];

/** Rule 58: requests are due 30 days after receipt and flagged after 25. */
export const PRIVACY_DUE_DAYS = 30;
export const PRIVACY_OVERDUE_WARNING_DAYS = 25;
/** Rule 61: an erasure starts 24 hours after verification. */
export const ERASE_DELAY_HOURS = 24;
/** Rule 60: export parts and lifetime. */
export const PRIVACY_EXPORT_PART_BYTES = 9 * 1024 * 1024;
export const PRIVACY_EXPORT_EXPIRY_DAYS = 7;
