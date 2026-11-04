/**
 * site views (site spec section 2, data model 2.11). Each view is `pgView(name, columns).existing()`
 * with its SQL exported beside it as `<name>Sql`; `pnpm db:views` writes the migration and
 * `createTestDb()` applies the same SQL (DM-1). Prices and seat counts are deliberately absent:
 * they come from commerce's and booking's api functions.
 */
import { bigint, boolean, integer, jsonb, pgView, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { LocalizedText } from "./_shared";
import { sessionsStatus } from "./booking";
import { pagesKind, pagesLegalKey, pagesStatus, termsAcceptancesContext } from "./site";

const tz = (name: string) => timestamp(name, { withTimezone: true });

/** Live pages with their live version. */
export const vPublishedPagesSql = `select p.id as page_id, p.kind, p.slug, p.legal_key, p.session_id, p.partner_company_id, p.first_published_at,
       v.id as version_id, v.version, v.title, v.locales, v.seo, v.excerpt, v.cover_media_id, v.published_at, v.is_material_change
from pages p join page_versions v on v.id = p.current_version_id
where p.status = 'published'`;

export const vPublishedPages = pgView("v_published_pages", {
  pageId: uuid("page_id").notNull(),
  kind: pagesKind("kind").notNull(),
  slug: text("slug").notNull(),
  legalKey: pagesLegalKey("legal_key"),
  sessionId: uuid("session_id"),
  partnerCompanyId: uuid("partner_company_id"),
  firstPublishedAt: tz("first_published_at"),
  versionId: uuid("version_id").notNull(),
  version: integer("version").notNull(),
  title: jsonb("title").$type<LocalizedText>().notNull(),
  locales: text("locales").array().notNull(),
  seo: jsonb("seo").notNull(),
  excerpt: jsonb("excerpt").$type<LocalizedText>(),
  coverMediaId: uuid("cover_media_id"),
  publishedAt: tz("published_at"),
  isMaterialChange: boolean("is_material_change").notNull(),
}).existing();

/** Event sessions with their optional live event page (listing source). */
export const vSiteEventsSql = `select s.id as session_id, s.title as session_title, s.starts_at, s.ends_at, s.status as session_status,
       s.is_member_only, s.is_lead_magnet, s.lead_window_end_at, s.location,
       p.id as page_id, v.id as version_id, v.locales, v.title as page_title, v.excerpt, v.cover_media_id
from sessions s
left join pages p on p.session_id = s.id and p.status = 'published'
left join page_versions v on v.id = p.current_version_id
where s.kind = 'event' and s.status <> 'cancelled'`;

export const vSiteEvents = pgView("v_site_events", {
  sessionId: uuid("session_id").notNull(),
  sessionTitle: jsonb("session_title").$type<LocalizedText>().notNull(),
  startsAt: tz("starts_at").notNull(),
  endsAt: tz("ends_at").notNull(),
  sessionStatus: sessionsStatus("session_status").notNull(),
  isMemberOnly: boolean("is_member_only").notNull(),
  isLeadMagnet: boolean("is_lead_magnet").notNull(),
  leadWindowEndAt: tz("lead_window_end_at"),
  location: text("location"),
  pageId: uuid("page_id"),
  versionId: uuid("version_id"),
  locales: text("locales").array(),
  pageTitle: jsonb("page_title").$type<LocalizedText>(),
  excerpt: jsonb("excerpt").$type<LocalizedText>(),
  coverMediaId: uuid("cover_media_id"),
}).existing();

/** Published ordinal per legal version ("Version n"; also the cookie banner version). */
export const vLegalVersionsSql = `select p.legal_key, v.id as version_id, v.published_at, v.is_material_change,
       row_number() over (partition by p.legal_key order by v.published_at) as ordinal,
       (v.id = p.current_version_id) as is_current
from pages p join page_versions v on v.page_id = p.id
where p.legal_key is not null and v.published_at is not null`;

export const vLegalVersions = pgView("v_legal_versions", {
  legalKey: pagesLegalKey("legal_key").notNull(),
  versionId: uuid("version_id").notNull(),
  publishedAt: tz("published_at").notNull(),
  isMaterialChange: boolean("is_material_change").notNull(),
  ordinal: bigint("ordinal", { mode: "number" }).notNull(),
  isCurrent: boolean("is_current").notNull(),
}).existing();

/** Latest acceptance per person and legal document. */
export const vTermsAcceptanceLatestSql = `select distinct on (person_id, legal_key) person_id, legal_key, page_version_id, accepted_at, context
from terms_acceptances order by person_id, legal_key, accepted_at desc`;

export const vTermsAcceptanceLatest = pgView("v_terms_acceptance_latest", {
  personId: uuid("person_id").notNull(),
  legalKey: pagesLegalKey("legal_key").notNull(),
  pageVersionId: uuid("page_version_id").notNull(),
  acceptedAt: tz("accepted_at").notNull(),
  context: termsAcceptancesContext("context").notNull(),
}).existing();

/** Admin overview of every page (CMS list). */
export const vSitePageOverviewSql = `select p.id as page_id, p.kind, p.slug, p.status, p.current_version_id,
       (select v.id from page_versions v where v.page_id = p.id and v.state = 'draft') as draft_version_id,
       (select count(*) from page_versions v where v.page_id = p.id and v.state = 'proposed')::int as open_proposals,
       (select max(v.published_at) from page_versions v where v.page_id = p.id) as last_published_at,
       p.updated_at
from pages p`;

export const vSitePageOverview = pgView("v_site_page_overview", {
  pageId: uuid("page_id").notNull(),
  kind: pagesKind("kind").notNull(),
  slug: text("slug").notNull(),
  status: pagesStatus("status").notNull(),
  currentVersionId: uuid("current_version_id"),
  draftVersionId: uuid("draft_version_id"),
  openProposals: integer("open_proposals").notNull(),
  lastPublishedAt: tz("last_published_at"),
  updatedAt: tz("updated_at").notNull(),
}).existing();
