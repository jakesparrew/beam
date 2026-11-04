/**
 * site types named in the cross-module contract (02-data-model section 6.11) and the shared
 * shapes of the site schema. site owns this file from site-P1 on. Pure types and constants.
 */
import type { Locale, LocalizedText } from "../i18n";
import type { Link } from "./links";

export type LegalKey = "privacy_notice" | "terms" | "cookie_notice" | "accessibility_statement" | "guardian_consent";
export const LEGAL_KEYS: readonly LegalKey[] = ["privacy_notice", "terms", "cookie_notice", "accessibility_statement", "guardian_consent"];

export type TermsContext = "checkout" | "signup" | "booking" | "portal_prompt" | "pos" | "import";
export const TERMS_CONTEXTS: readonly TermsContext[] = ["checkout", "signup", "booking", "portal_prompt", "pos", "import"];

export type PortalRoute =
  | "home"
  | "book_day"
  | "book_night"
  | "bookings"
  | "waitlist"
  | "shop"
  | "packages"
  | "membership"
  | "invoices"
  | "preferences"
  | "profile";

export type PageKind =
  | "home"
  | "standard"
  | "offer"
  | "pricing"
  | "events_index"
  | "event"
  | "blog_index"
  | "post"
  | "contact"
  | "legal"
  | "landing";
export const PAGE_KINDS: readonly PageKind[] = [
  "home",
  "standard",
  "offer",
  "pricing",
  "events_index",
  "event",
  "blog_index",
  "post",
  "contact",
  "legal",
  "landing",
];
/** Kinds with exactly one non-archived page (rule 10). */
export const SINGLETON_KINDS: readonly PageKind[] = ["home", "events_index", "blog_index", "contact"];
/** Kinds whose versions need an excerpt in every locale (rule 5). */
export const EXCERPT_KINDS: readonly PageKind[] = ["post", "event", "landing"];

export type PageStatus = "draft" | "published" | "archived";
export type PageVersionState = "draft" | "proposed" | "published" | "rejected" | "superseded";

/** `page_versions.seo[locale]`. */
export type PageSeo = { title: string; description: string; ogImageMediaId?: string; noindex?: boolean };

/** `nav_menus.items[]`: max 8 top-level items, depth 2, max 12 children. */
export type NavItem = { id: string; label: LocalizedText; target: Link; children?: NavItem[] };
export type NavMenuKey = "header" | "footer" | "legal";

/** `site_audit_reports.findings[]` (R4). */
export type SiteAuditFinding = { pageId: string; locale: Locale; severity: "info" | "warn"; code: string; message: string };

/** Public seat bands (rule 30); no exact count is ever shown publicly. */
export type AvailabilityBand = "available" | "few" | "full";
