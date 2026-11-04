/**
 * site schema (site spec section 2, data model 1.2.11). Wave 0 created the contract table
 * `pages` (platform-P2); site-P1 completes it without changing its existing columns and adds
 * every other site table, including the R3 column `pages.partner_company_id` and the R4 table
 * `site_audit_reports`, so later releases need no site migration.
 *
 * `page_versions` rows are IMMUTABLE once `published_at` is set (guard in site's service code);
 * `terms_acceptances`, `cookie_consents` and `site_audit_reports` are APPEND (trigger from
 * `0002_append_only.sql`, the tables are in `APPEND_ONLY_TABLES`).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { Block, NavItem, PageSeo, SiteAuditFinding } from "@beam/core/site";
import { sessions } from "./booking";
import { companies, persons } from "./crm";
import { files, localeEnum, users } from "./platform";
import { createdAt, id, localized, timestamps, tstz, type Locale } from "./_shared";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const pagesKind = pgEnum("pages_kind", [
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
]);
export const pagesStatus = pgEnum("pages_status", [
  "draft",
  "published",
  "archived",
]);
export const pagesLegalKey = pgEnum("pages_legal_key", [
  "privacy_notice",
  "terms",
  "cookie_notice",
  "accessibility_statement",
  "guardian_consent",
]);
export const pageVersionsState = pgEnum("page_versions_state", [
  "draft",
  "proposed",
  "published",
  "rejected",
  "superseded",
]);
export const pageVersionsCreatedBy = pgEnum("page_versions_created_by", [
  "user",
  "claude",
]);
export const redirectsSource = pgEnum("redirects_source", [
  "wordpress",
  "rename",
  "archive",
  "manual",
]);
export const navMenusKey = pgEnum("nav_menus_key", ["header", "footer", "legal"]);
export const mediaAssetsSource = pgEnum("media_assets_source", [
  "upload",
  "wordpress",
]);
export const pageEditRequestsKind = pgEnum("page_edit_requests_kind", [
  "edit",
  "new_page",
  "translate",
]);
export const pageEditRequestsStatus = pgEnum("page_edit_requests_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const termsAcceptancesContext = pgEnum("terms_acceptances_context", [
  "checkout",
  "signup",
  "booking",
  "portal_prompt",
  "pos",
  "import",
]);
export const cookieConsentsAction = pgEnum("cookie_consents_action", [
  "accept_all",
  "reject_all",
  "custom",
  "withdraw",
]);
export const wordpressImportsStatus = pgEnum("wordpress_imports_status", [
  "uploaded",
  "parsing",
  "parsed",
  "applying",
  "done",
  "failed",
]);
export const wordpressImportItemsWpType = pgEnum(
  "wordpress_import_items_wp_type",
  ["page", "post", "attachment"],
);
export const wordpressImportItemsDecision = pgEnum(
  "wordpress_import_items_decision",
  ["import", "skip", "redirect_only"],
);
export const wordpressImportItemsStatus = pgEnum(
  "wordpress_import_items_status",
  ["pending", "imported", "skipped", "error"],
);

const PATH_RE = "^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*){0,2}$";

// ---------------------------------------------------------------------------
// pages (Wave 0 contract table, completed here)
// ---------------------------------------------------------------------------

export const pages = pgTable(
  "pages",
  {
    id: id(),
    kind: pagesKind().notNull(),
    slug: text().notNull().unique(),
    status: pagesStatus().notNull().default("draft"),
    currentVersionId: uuid().references((): AnyPgColumn => pageVersions.id),
    legalKey: pagesLegalKey(),
    sessionId: uuid().references(() => sessions.id, { onDelete: "set null" }),
    // R3.
    partnerCompanyId: uuid().references((): AnyPgColumn => companies.id, { onDelete: "set null" }),
    firstPublishedAt: tstz(),
    archivedAt: tstz(),
    archivedByUserId: uuid().references(() => users.id),
    createdByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("pages_kind_status_idx").on(t.kind, t.status),
    check(
      "pages_slug_ck",
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.slug}) <= 80`,
    ),
    check(
      "pages_legal_key_ck",
      sql`(${t.kind} = 'legal') = (${t.legalKey} is not null)`,
    ),
    check(
      "pages_session_kind_ck",
      sql`${t.sessionId} is null or ${t.kind} = 'event'`,
    ),
    check(
      "pages_partner_kind_ck",
      sql`${t.partnerCompanyId} is null or ${t.kind} = 'landing'`,
    ),
    check(
      "pages_published_version_ck",
      sql`${t.status} <> 'published' or ${t.currentVersionId} is not null`,
    ),
    uniqueIndex("pages_singleton_kind_uq")
      .on(t.kind)
      .where(
        sql`${t.kind} in ('home', 'events_index', 'blog_index', 'contact') and ${t.status} <> 'archived'`,
      ),
    uniqueIndex("pages_legal_key_uq")
      .on(t.legalKey)
      .where(sql`${t.legalKey} is not null and ${t.status} <> 'archived'`),
    uniqueIndex("pages_session_uq")
      .on(t.sessionId)
      .where(sql`${t.sessionId} is not null and ${t.status} <> 'archived'`),
    index("pages_posts_published_idx")
      .on(t.firstPublishedAt.desc())
      .where(sql`${t.kind} = 'post' and ${t.status} = 'published'`),
  ],
);

// ---------------------------------------------------------------------------
// page_versions (IMMUTABLE once published_at is set)
// ---------------------------------------------------------------------------

export const pageVersions = pgTable(
  "page_versions",
  {
    id: id(),
    pageId: uuid()
      .notNull()
      .references((): AnyPgColumn => pages.id, { onDelete: "restrict" }),
    version: integer().notNull(),
    state: pageVersionsState().notNull().default("draft"),
    title: localized().notNull().default({}),
    paths: jsonb().$type<Partial<Record<Locale, string>>>().notNull().default({}),
    blocks: jsonb().$type<Partial<Record<Locale, Block[]>>>().notNull().default({}),
    seo: jsonb().$type<Partial<Record<Locale, PageSeo>>>().notNull().default({}),
    excerpt: localized(),
    coverMediaId: uuid().references((): AnyPgColumn => mediaAssets.id, {
      onDelete: "restrict",
    }),
    locales: text()
      .array()
      .$type<Locale[]>()
      .notNull()
      .default(sql`'{nl-BE,fr-BE,en}'::text[]`),
    isMaterialChange: boolean().notNull().default(false),
    changeSummary: text(),
    basedOnVersionId: uuid().references((): AnyPgColumn => pageVersions.id),
    createdBy: pageVersionsCreatedBy().notNull().default("user"),
    createdByUserId: uuid().references(() => users.id),
    editRequestId: uuid().references((): AnyPgColumn => pageEditRequests.id, {
      onDelete: "set null",
    }),
    // Plain uuid, no FK: `ai_requests` is purged after 30 days.
    proposedByAiRequestId: uuid(),
    scheduledPublishAt: tstz(),
    publishedAt: tstz(),
    publishedByUserId: uuid().references(() => users.id),
    rejectedAt: tstz(),
    rejectedByUserId: uuid().references(() => users.id),
    rejectReason: text(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("page_versions_page_version_uq").on(t.pageId, t.version),
    uniqueIndex("page_versions_one_draft_uq")
      .on(t.pageId)
      .where(sql`${t.state} = 'draft'`),
    index("page_versions_page_state_idx").on(t.pageId, t.state),
    index("page_versions_scheduled_idx")
      .on(t.scheduledPublishAt)
      .where(sql`${t.scheduledPublishAt} is not null`),
    index("page_versions_edit_request_idx").on(t.editRequestId),
    check("page_versions_version_ck", sql`${t.version} > 0`),
    check(
      "page_versions_locales_ck",
      sql`${t.locales} <@ array['nl-BE','fr-BE','en']::text[] and cardinality(${t.locales}) >= 1`,
    ),
    check(
      "page_versions_change_summary_ck",
      sql`${t.changeSummary} is null or length(${t.changeSummary}) <= 500`,
    ),
    check(
      "page_versions_reject_reason_ck",
      sql`${t.rejectReason} is null or length(${t.rejectReason}) <= 500`,
    ),
    check(
      "page_versions_published_ck",
      sql`(${t.state} = 'published') = (${t.publishedAt} is not null)`,
    ),
    check(
      "page_versions_rejected_ck",
      sql`${t.state} <> 'rejected' or ${t.rejectedAt} is not null`,
    ),
    check(
      "page_versions_claude_not_draft_ck",
      sql`${t.createdBy} = 'user' or ${t.state} <> 'draft'`,
    ),
    check(
      "page_versions_superseded_claude_ck",
      sql`${t.state} <> 'superseded' or ${t.createdBy} = 'claude'`,
    ),
    check(
      "page_versions_schedule_state_ck",
      sql`${t.scheduledPublishAt} is null or ${t.state} in ('draft', 'proposed')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// page_routes (mutable projection of live paths)
// ---------------------------------------------------------------------------

export const pageRoutes = pgTable(
  "page_routes",
  {
    id: id(),
    pageId: uuid()
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    locale: localeEnum().notNull(),
    path: text().notNull(),
    versionId: uuid()
      .notNull()
      .references(() => pageVersions.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("page_routes_locale_path_uq").on(t.locale, t.path),
    uniqueIndex("page_routes_page_locale_uq").on(t.pageId, t.locale),
    check(
      "page_routes_path_ck",
      sql`(${t.path} = '' or ${t.path} ~ ${sql.raw(`'${PATH_RE}'`)}) and length(${t.path}) <= 200`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// redirects
// ---------------------------------------------------------------------------

export const redirects = pgTable(
  "redirects",
  {
    id: id(),
    fromPath: text().notNull().unique("redirects_from_path_uq"),
    toPageId: uuid().references(() => pages.id, { onDelete: "cascade" }),
    toLocale: localeEnum(),
    toUrl: text(),
    isPermanent: boolean().notNull().default(true),
    source: redirectsSource().notNull(),
    hits: integer().notNull().default(0),
    lastHitAt: tstz(),
    createdByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("redirects_to_page_idx").on(t.toPageId),
    check(
      "redirects_from_path_ck",
      sql`${t.fromPath} like '/%' and ${t.fromPath} !~ '^/(admin|api|_next)(/|$)'`,
    ),
    check(
      "redirects_target_ck",
      sql`(${t.toPageId} is not null and ${t.toLocale} is not null and ${t.toUrl} is null) or (${t.toPageId} is null and ${t.toLocale} is null and ${t.toUrl} is not null)`,
    ),
    check(
      "redirects_to_url_ck",
      sql`${t.toUrl} is null or ((${t.toUrl} like '/%' or ${t.toUrl} like 'https://%') and length(${t.toUrl}) <= 500 and ${t.toUrl} <> ${t.fromPath})`,
    ),
    check("redirects_hits_ck", sql`${t.hits} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// nav_menus (history in audit_log)
// ---------------------------------------------------------------------------

export const navMenus = pgTable(
  "nav_menus",
  {
    id: id(),
    key: navMenusKey().notNull().unique("nav_menus_key_uq"),
    items: jsonb().$type<NavItem[]>().notNull().default([]),
    version: integer().notNull().default(1),
    updatedByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [check("nav_menus_version_ck", sql`${t.version} >= 1`)],
);

// ---------------------------------------------------------------------------
// media_assets
// ---------------------------------------------------------------------------

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: id(),
    fileId: uuid()
      .notNull()
      .unique("media_assets_file_id_uq")
      .references(() => files.id, { onDelete: "restrict" }),
    alt: localized().notNull().default({}),
    isDecorative: boolean().notNull().default(false),
    width: integer().notNull(),
    height: integer().notNull(),
    caption: localized(),
    credit: text(),
    source: mediaAssetsSource().notNull().default("upload"),
    wordpressUrl: text(),
    uploadedByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("media_assets_source_idx").on(t.source),
    uniqueIndex("media_assets_wordpress_url_uq")
      .on(t.wordpressUrl)
      .where(sql`${t.wordpressUrl} is not null`),
    check("media_assets_width_ck", sql`${t.width} > 0`),
    check("media_assets_height_ck", sql`${t.height} > 0`),
    check(
      "media_assets_credit_ck",
      sql`${t.credit} is null or length(${t.credit}) <= 200`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// page_edit_requests (Claude proposals)
// ---------------------------------------------------------------------------

export const pageEditRequests = pgTable(
  "page_edit_requests",
  {
    id: id(),
    pageId: uuid()
      .notNull()
      .references((): AnyPgColumn => pages.id),
    kind: pageEditRequestsKind().notNull().default("edit"),
    instruction: text().notNull(),
    locales: text().array().$type<Locale[]>().notNull(),
    baseVersionId: uuid().references((): AnyPgColumn => pageVersions.id),
    baseUpdatedAt: tstz(),
    status: pageEditRequestsStatus().notNull().default("pending"),
    requestedByUserId: uuid()
      .notNull()
      .references(() => users.id),
    resultVersionId: uuid().references((): AnyPgColumn => pageVersions.id),
    // Plain uuid, no FK: `ai_requests` is purged after 30 days.
    aiRequestId: uuid(),
    errorCode: text(),
    errorMessage: text(),
    finishedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("page_edit_requests_active_uq")
      .on(t.pageId)
      .where(sql`${t.status} in ('pending', 'running')`),
    index("page_edit_requests_page_created_idx").on(
      t.pageId,
      t.createdAt.desc(),
    ),
    check(
      "page_edit_requests_instruction_ck",
      sql`length(${t.instruction}) between 3 and 4000`,
    ),
    check(
      "page_edit_requests_locales_ck",
      sql`${t.locales} <@ array['nl-BE','fr-BE','en']::text[] and cardinality(${t.locales}) >= 1`,
    ),
    check(
      "page_edit_requests_error_code_ck",
      sql`${t.errorCode} is null or ${t.errorCode} in ('budget_exceeded', 'invalid_output', 'ai_unavailable', 'page_archived')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// terms_acceptances (APPEND)
// ---------------------------------------------------------------------------

export const termsAcceptances = pgTable(
  "terms_acceptances",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    pageVersionId: uuid()
      .notNull()
      .references(() => pageVersions.id),
    legalKey: pagesLegalKey().notNull(),
    context: termsAcceptancesContext().notNull(),
    refType: text(),
    refId: uuid(),
    // Personal data (not sensitive); removed on erasure.
    ip: text(),
    idempotencyKey: text().notNull().unique("terms_acceptances_idempotency_key_uq"),
    acceptedAt: tstz().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("terms_acceptances_person_idx").on(
      t.personId,
      t.legalKey,
      t.acceptedAt.desc(),
    ),
    check(
      "terms_acceptances_ref_type_ck",
      sql`${t.refType} is null or ${t.refType} in ('order', 'booking', 'user', 'waitlist_entry')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// cookie_consents (APPEND)
// ---------------------------------------------------------------------------

export const cookieConsents = pgTable(
  "cookie_consents",
  {
    id: id(),
    consentKey: uuid().notNull(),
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    choices: jsonb().$type<{ analytics: boolean; marketing: boolean }>().notNull(),
    bannerVersion: integer().notNull(),
    action: cookieConsentsAction().notNull(),
    locale: localeEnum().notNull(),
    // HMAC-SHA256 of the IP with AUTH_SECRET, first 32 hex chars (personal data).
    ipHash: text(),
    recordedAt: tstz().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("cookie_consents_key_idx").on(t.consentKey, t.recordedAt.desc()),
    index("cookie_consents_person_idx")
      .on(t.personId)
      .where(sql`${t.personId} is not null`),
    index("cookie_consents_recorded_idx").on(t.recordedAt),
    check("cookie_consents_banner_version_ck", sql`${t.bannerVersion} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// wordpress_imports, wordpress_import_items
// ---------------------------------------------------------------------------

export type WordpressImportCounts = {
  pages?: number;
  posts?: number;
  attachments?: number;
  imported?: number;
  skipped?: number;
  errors?: number;
  redirects?: number;
};

export const wordpressImports = pgTable(
  "wordpress_imports",
  {
    id: id(),
    fileId: uuid()
      .notNull()
      .references(() => files.id),
    siteOrigin: text().notNull(),
    defaultLocale: localeEnum().notNull().default("nl-BE"),
    status: wordpressImportsStatus().notNull().default("uploaded"),
    counts: jsonb().$type<WordpressImportCounts>().notNull().default({}),
    report: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdByUserId: uuid()
      .notNull()
      .references(() => users.id),
    appliedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    check("wordpress_imports_origin_ck", sql`${t.siteOrigin} ~ '^https://'`),
  ],
);

export const wordpressImportItems = pgTable(
  "wordpress_import_items",
  {
    id: id(),
    importId: uuid()
      .notNull()
      .references(() => wordpressImports.id, { onDelete: "cascade" }),
    wpId: integer().notNull(),
    wpType: wordpressImportItemsWpType().notNull(),
    wpStatus: text().notNull(),
    locale: localeEnum(),
    translationGroup: text(),
    parentWpId: integer(),
    title: text().notNull(),
    wpLink: text().notNull(),
    wpPath: text().notNull(),
    contentHtml: text(),
    excerpt: text(),
    publishedAt: tstz(),
    attachmentUrl: text(),
    decision: wordpressImportItemsDecision().notNull().default("import"),
    targetPageId: uuid().references(() => pages.id),
    targetMediaId: uuid().references(() => mediaAssets.id),
    redirectToPageId: uuid().references(() => pages.id),
    status: wordpressImportItemsStatus().notNull().default("pending"),
    message: text(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("wordpress_import_items_item_uq").on(
      t.importId,
      t.wpType,
      t.wpId,
    ),
    index("wordpress_import_items_status_idx").on(t.importId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// site_audit_reports (R4, APPEND)
// ---------------------------------------------------------------------------

export const siteAuditReports = pgTable("site_audit_reports", {
  id: id(),
  weekOn: date({ mode: "string" }).notNull().unique("site_audit_reports_week_on_uq"),
  findings: jsonb().$type<SiteAuditFinding[]>().notNull(),
  aiRequestId: uuid(),
  createdAt: createdAt(),
});
