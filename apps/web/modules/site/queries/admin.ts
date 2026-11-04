/**
 * site queries, back-office (site spec section 4 "Admin", section 5; site-P3): listPagesForAdmin,
 * getPageEditor, getVersion, listVersionHistory, listMedia, listRedirects, getContentIssues and
 * the editor's picker lists. Every function takes an optional db (the app db by default, OD-15)
 * and returns JSON-safe rows (ISO date strings) for the client components.
 */
import type { DbOrTx } from "@beam/db";
import { auditLog, files, mediaAssets, navMenus, pageEditRequests, pageRoutes, pages, pageVersions, products, redirects, sessions, users } from "@beam/db/schema";
import { NotImplementedError } from "@beam/core/errors";
import { LOCALES, messagesFor, type Locale, type LocalizedText } from "@beam/core/i18n";
import { LEGAL_KEYS, missingCompanyIdentification, type LegalKey, type NavItem, type PageKind, type PageStatus, type PageVersionState, type PublishIssue, type VersionContent } from "@beam/core/site";
import { ilike } from "drizzle-orm";
import { and, desc, eq, getAppDb, gte, inArray, isNotNull, lt, ne, or, sql } from "@/lib/ctx";
import { reportError } from "@/lib/logger";
import { listPublishedForms } from "@/modules/forms/api";
import { checkContent, hiddenNavTargets } from "../server/refs";
import { getCompanySetting, hasOpeningHours } from "../server/settings";
import { versionContent, type VersionRow } from "../server/versions";

const db0 = async (db?: DbOrTx): Promise<DbOrTx> => db ?? (await getAppDb());
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** The title in `locale`, else the first locale that has one, else the slug. */
export function titleIn(title: LocalizedText | null | undefined, locale: Locale, fallback: string): string {
  const own = title?.[locale]?.trim();
  if (own) return own;
  for (const l of LOCALES) if (title?.[l]?.trim()) return title[l].trim();
  return fallback;
}

// ---------------------------------------------------------------------------------------------
// Pages table
// ---------------------------------------------------------------------------------------------

export type AdminPageRow = {
  pageId: string;
  kind: PageKind;
  slug: string;
  status: PageStatus;
  legalKey: LegalKey | null;
  title: string;
  liveVersion: number | null;
  draftVersionId: string | null;
  openProposals: number;
  scheduledAt: string | null;
  lastPublishedAt: string | null;
  updatedAt: string;
};

export async function listPagesForAdmin(filter: { kind?: PageKind; status?: PageStatus; q?: string } = {}, locale: Locale = "en", db?: DbOrTx): Promise<AdminPageRow[]> {
  const d = await db0(db);
  const conds = [
    filter.kind ? eq(pages.kind, filter.kind) : undefined,
    filter.status ? eq(pages.status, filter.status) : undefined,
    filter.q?.trim() ? or(ilike(pages.slug, `%${filter.q.trim()}%`), sql`${pageVersions.title}::text ilike ${`%${filter.q.trim()}%`}`) : undefined,
  ].filter((c) => c !== undefined);
  const rows = await d
    .select({ page: pages, current: { version: pageVersions.version, title: pageVersions.title } })
    .from(pages)
    .leftJoin(pageVersions, eq(pageVersions.id, pages.currentVersionId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(pages.kind, pages.slug);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.page.id);
  const others = await d
    .select({ pageId: pageVersions.pageId, id: pageVersions.id, state: pageVersions.state, title: pageVersions.title, scheduled: pageVersions.scheduledPublishAt, publishedAt: pageVersions.publishedAt })
    .from(pageVersions)
    .where(and(inArray(pageVersions.pageId, ids), or(inArray(pageVersions.state, ["draft", "proposed"]), isNotNull(pageVersions.publishedAt))));
  return rows.map(({ page, current }) => {
    const mine = others.filter((o) => o.pageId === page.id);
    const draft = mine.find((o) => o.state === "draft");
    const published = mine.map((o) => o.publishedAt?.getTime() ?? 0).filter(Boolean);
    const scheduled = mine.map((o) => o.scheduled).filter((s): s is Date => !!s).sort((a, b) => a.getTime() - b.getTime())[0];
    return {
      pageId: page.id,
      kind: page.kind,
      slug: page.slug,
      status: page.status,
      legalKey: (page.legalKey) ?? null,
      title: titleIn(current?.title ?? draft?.title, locale, page.slug),
      liveVersion: page.status === "published" ? (current?.version ?? null) : null,
      draftVersionId: draft?.id ?? null,
      openProposals: mine.filter((o) => o.state === "proposed").length,
      scheduledAt: iso(scheduled),
      lastPublishedAt: published.length ? new Date(Math.max(...published)).toISOString() : null,
      updatedAt: page.updatedAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Editor, versions and history
// ---------------------------------------------------------------------------------------------

export type AdminVersion = VersionContent & {
  versionId: string;
  pageId: string;
  version: number;
  state: PageVersionState;
  changeSummary: string | null;
  basedOnVersionId: string | null;
  createdBy: "user" | "claude";
  createdByName: string | null;
  scheduledPublishAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

function toAdminVersion(row: VersionRow, names: Map<string, string>): AdminVersion {
  return {
    ...versionContent(row),
    versionId: row.id,
    pageId: row.pageId,
    version: row.version,
    state: row.state,
    changeSummary: row.changeSummary ?? null,
    basedOnVersionId: row.basedOnVersionId ?? null,
    createdBy: row.createdBy,
    createdByName: row.createdByUserId ? (names.get(row.createdByUserId) ?? null) : null,
    scheduledPublishAt: iso(row.scheduledPublishAt),
    publishedAt: iso(row.publishedAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function userNames(d: DbOrTx, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const rows = await d.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name ?? ""]));
}

export async function getVersion(versionId: string, db?: DbOrTx): Promise<AdminVersion | null> {
  const d = await db0(db);
  const [row] = await d.select().from(pageVersions).where(eq(pageVersions.id, versionId));
  if (!row) return null;
  return toAdminVersion(row, await userNames(d, [row.createdByUserId]));
}

export type HistoryRow = Pick<AdminVersion, "versionId" | "version" | "state" | "createdBy" | "createdByName" | "publishedAt" | "scheduledPublishAt" | "changeSummary"> & { isLive: boolean };

export async function listVersionHistory(pageId: string, db?: DbOrTx): Promise<HistoryRow[]> {
  const d = await db0(db);
  const [page] = await d.select({ currentVersionId: pages.currentVersionId, status: pages.status }).from(pages).where(eq(pages.id, pageId));
  const rows = await d.select().from(pageVersions).where(eq(pageVersions.pageId, pageId)).orderBy(desc(pageVersions.version));
  const names = await userNames(d, rows.map((r) => r.createdByUserId));
  return rows.map((r) => {
    const v = toAdminVersion(r, names);
    return {
      versionId: v.versionId,
      version: v.version,
      state: v.state,
      createdBy: v.createdBy,
      createdByName: v.createdByName,
      publishedAt: v.publishedAt,
      scheduledPublishAt: v.scheduledPublishAt,
      changeSummary: v.changeSummary,
      isLive: page?.status === "published" && page.currentVersionId === r.id,
    };
  });
}

export type PageEditorData = {
  page: { pageId: string; kind: PageKind; slug: string; status: PageStatus; legalKey: LegalKey | null; sessionId: string | null; currentVersionId: string | null; updatedAt: string };
  live: AdminVersion | null;
  draft: AdminVersion | null;
  /** The version the editor opens: the draft, else the live version, else the newest version. */
  base: AdminVersion | null;
  issues: PublishIssue[];
  /** Rule 16: the draft was started from another version than the live one. */
  outOfDate: boolean;
  routes: Partial<Record<Locale, string>>;
  history: HistoryRow[];
};

export async function getPageEditor(pageId: string, db?: DbOrTx): Promise<PageEditorData | null> {
  const d = await db0(db);
  const [page] = await d.select().from(pages).where(eq(pages.id, pageId));
  if (!page) return null;
  const rows = await d.select().from(pageVersions).where(eq(pageVersions.pageId, pageId)).orderBy(desc(pageVersions.version));
  const names = await userNames(d, rows.map((r) => r.createdByUserId));
  const liveRow = page.currentVersionId ? rows.find((r) => r.id === page.currentVersionId) : undefined;
  const draftRow = rows.find((r) => r.state === "draft");
  const live = liveRow ? toAdminVersion(liveRow, names) : null;
  const draft = draftRow ? toAdminVersion(draftRow, names) : null;
  const baseRow = draftRow ?? liveRow ?? rows[0];
  const issues = baseRow ? await checkContent(d, page, versionContent(baseRow)) : [];
  const routeRows = await d.select({ locale: pageRoutes.locale, path: pageRoutes.path }).from(pageRoutes).where(eq(pageRoutes.pageId, pageId));
  const routes: Partial<Record<Locale, string>> = {};
  for (const r of routeRows) routes[r.locale] = r.path;
  return {
    page: {
      pageId: page.id,
      kind: page.kind,
      slug: page.slug,
      status: page.status,
      legalKey: (page.legalKey) ?? null,
      sessionId: page.sessionId ?? null,
      currentVersionId: page.currentVersionId ?? null,
      updatedAt: page.updatedAt.toISOString(),
    },
    live,
    draft,
    base: baseRow ? toAdminVersion(baseRow, names) : null,
    issues,
    outOfDate: !!draftRow && !!page.currentVersionId && page.status === "published" && draftRow.basedOnVersionId !== page.currentVersionId,
    routes,
    history: await listVersionHistory(pageId, d),
  };
}

// ---------------------------------------------------------------------------------------------
// Media and redirects
// ---------------------------------------------------------------------------------------------

export type AdminMediaRow = {
  mediaId: string;
  fileId: string;
  name: string;
  mime: string;
  sizeBytes: number;
  width: number;
  height: number;
  alt: LocalizedText;
  isDecorative: boolean;
  caption: LocalizedText | null;
  credit: string | null;
  source: "upload" | "wordpress";
  usage: number;
  createdAt: string;
};

export const MEDIA_PAGE_SIZE = 60;

/** Images newest first, `MEDIA_PAGE_SIZE` per page (`cursor` = the last row's `createdAt`). */
export async function listMedia(opts: { q?: string; cursor?: string } = {}, db?: DbOrTx): Promise<{ rows: AdminMediaRow[]; next: string | null }> {
  const d = await db0(db);
  const q = opts.q?.trim();
  const conds = [
    q ? or(ilike(files.name, `%${q}%`), sql`${mediaAssets.alt}::text ilike ${`%${q}%`}`) : undefined,
    opts.cursor ? lt(mediaAssets.createdAt, new Date(opts.cursor)) : undefined,
  ].filter((c) => c !== undefined);
  const rows = await d
    .select({ m: mediaAssets, name: files.name, mime: files.mime, sizeBytes: files.sizeBytes })
    .from(mediaAssets)
    .innerJoin(files, eq(files.id, mediaAssets.fileId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(mediaAssets.createdAt))
    .limit(MEDIA_PAGE_SIZE + 1);
  const page = rows.slice(0, MEDIA_PAGE_SIZE);
  // Usage: drafts, proposals and live versions whose content mentions the id.
  const active = await d
    .select({ blocks: pageVersions.blocks, seo: pageVersions.seo, cover: pageVersions.coverMediaId })
    .from(pageVersions)
    .leftJoin(pages, eq(pages.currentVersionId, pageVersions.id))
    .where(or(inArray(pageVersions.state, ["draft", "proposed"]), eq(pages.status, "published")));
  const texts = active.map((a) => `${JSON.stringify(a.blocks)}${JSON.stringify(a.seo)}${a.cover ?? ""}`);
  return {
    rows: page.map(({ m, name, mime, sizeBytes }) => ({
      mediaId: m.id,
      fileId: m.fileId,
      name,
      mime,
      sizeBytes,
      width: m.width,
      height: m.height,
      alt: m.alt ?? {},
      isDecorative: m.isDecorative,
      caption: m.caption ?? null,
      credit: m.credit ?? null,
      source: m.source,
      usage: texts.filter((t) => t.includes(m.id)).length,
      createdAt: m.createdAt.toISOString(),
    })),
    next: rows.length > MEDIA_PAGE_SIZE ? page[page.length - 1]!.m.createdAt.toISOString() : null,
  };
}

export type AdminRedirectRow = {
  id: string;
  fromPath: string;
  toPageId: string | null;
  toLocale: Locale | null;
  toUrl: string | null;
  toLabel: string;
  isPermanent: boolean;
  source: "wordpress" | "rename" | "archive" | "manual";
  hits: number;
  lastHitAt: string | null;
};

export const REDIRECTS_PAGE_SIZE = 200;

export async function listRedirects(
  opts: { q?: string; source?: AdminRedirectRow["source"]; cursor?: string } = {},
  locale: Locale = "en",
  db?: DbOrTx,
): Promise<{ rows: AdminRedirectRow[]; next: string | null }> {
  const d = await db0(db);
  const q = opts.q?.trim();
  const conds = [
    q ? or(ilike(redirects.fromPath, `%${q}%`), ilike(redirects.toUrl, `%${q}%`)) : undefined,
    opts.source ? eq(redirects.source, opts.source) : undefined,
    opts.cursor ? gte(redirects.fromPath, opts.cursor) : undefined,
  ].filter((c) => c !== undefined);
  const rows = await d
    .select({ r: redirects, slug: pages.slug, title: pageVersions.title })
    .from(redirects)
    .leftJoin(pages, eq(pages.id, redirects.toPageId))
    .leftJoin(pageVersions, eq(pageVersions.id, pages.currentVersionId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(redirects.fromPath)
    .limit(REDIRECTS_PAGE_SIZE + 1);
  const page = rows.slice(0, REDIRECTS_PAGE_SIZE);
  return {
    rows: page.map(({ r, slug, title }) => ({
      id: r.id,
      fromPath: r.fromPath,
      toPageId: r.toPageId ?? null,
      toLocale: (r.toLocale) ?? null,
      toUrl: r.toUrl ?? null,
      toLabel: r.toUrl ?? `${titleIn(title, locale, slug ?? "")} (${r.toLocale})`,
      isPermanent: r.isPermanent,
      source: r.source,
      hits: r.hits,
      lastHitAt: iso(r.lastHitAt),
    })),
    next: rows.length > REDIRECTS_PAGE_SIZE ? rows[REDIRECTS_PAGE_SIZE]!.r.fromPath : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Navigation menus
// ---------------------------------------------------------------------------------------------

export type AdminNavMenu = { key: "header" | "footer" | "legal"; items: NavItem[]; version: number; hidden: { itemId: string; locale: Locale }[] };

export async function listNavMenusForAdmin(db?: DbOrTx): Promise<AdminNavMenu[]> {
  const d = await db0(db);
  const rows = await d.select().from(navMenus);
  const out: AdminNavMenu[] = [];
  for (const key of ["header", "footer", "legal"] as const) {
    const row = rows.find((r) => r.key === key);
    const items = (row?.items ?? []);
    const hidden = (await hiddenNavTargets(d, key, items)).map((h) => ({ itemId: h.itemId, locale: h.locale }));
    out.push({ key, items, version: row?.version ?? 0, hidden });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Content issues (`/admin/site`, rules 13, 24, 26, 29, 59-61, 67, edge cases 13-15)
// ---------------------------------------------------------------------------------------------

export type ContentIssueCode =
  | "draft_issues"
  | "schedule_failed"
  | "nav_target_hidden"
  | "product_inactive"
  | "event_past"
  | "event_session_missing"
  | "opening_hours_missing"
  | "legal_page_missing"
  | "company_identification_missing";

export type ContentIssue = {
  code: ContentIssueCode;
  /** Go-live issues (rules 60, 61, 67) render as the red banner. */
  goLive: boolean;
  pageId?: string;
  versionId?: string;
  title?: string;
  locale?: Locale;
  /** Issue codes of a blocking draft, the missing legal key, or the missing company fields. */
  details?: string[];
};

/** Every issue of `/admin/site`, go-live issues first. */
export async function getContentIssues(db?: DbOrTx, opts: { locale?: Locale; now?: Date } = {}): Promise<ContentIssue[]> {
  const d = await db0(db);
  const locale = opts.locale ?? "en";
  const now = opts.now ?? new Date();
  const goLive: ContentIssue[] = [];
  const out: ContentIssue[] = [];

  // Missing legal pages (rules 61, 67, edge cases 28, 39, 41): no live page per legal key.
  const legal = await d.select({ legalKey: pages.legalKey }).from(pages).where(and(eq(pages.status, "published"), isNotNull(pages.legalKey)));
  const present = new Set(legal.map((l) => l.legalKey));
  for (const key of LEGAL_KEYS) if (!present.has(key)) goLive.push({ code: "legal_page_missing", goLive: true, details: [key] });

  const missingCompany = missingCompanyIdentification(await getCompanySetting(d));
  if (missingCompany.length) goLive.push({ code: "company_identification_missing", goLive: true, details: missingCompany });

  if (!(await hasOpeningHours(d))) out.push({ code: "opening_hours_missing", goLive: false });

  const allPages = await d.select().from(pages).where(ne(pages.status, "archived"));
  const byId = new Map(allPages.map((p) => [p.id, p]));
  const versions = allPages.length
    ? await d
        .select()
        .from(pageVersions)
        .where(and(inArray(pageVersions.pageId, allPages.map((p) => p.id)), or(eq(pageVersions.state, "draft"), inArray(pageVersions.id, allPages.map((p) => p.currentVersionId).filter((x): x is string => !!x)))))
    : [];
  const titleOf = (pageId: string) => {
    const page = byId.get(pageId)!;
    const v = versions.find((x) => x.id === page.currentVersionId) ?? versions.find((x) => x.pageId === pageId);
    return titleIn(v?.title, locale, page.slug);
  };

  // Blocking publish issues of drafts.
  for (const v of versions.filter((x) => x.state === "draft")) {
    const page = byId.get(v.pageId)!;
    const issues = await checkContent(d, page, versionContent(v));
    if (issues.length) out.push({ code: "draft_issues", goLive: false, pageId: page.id, versionId: v.id, title: titleOf(page.id), details: [...new Set(issues.map((i) => i.code))] });
  }

  // Scheduled publishes that failed (rule 13) and were not rescheduled or published since.
  const failed = await d
    .select({ entityId: auditLog.entityId, newValue: auditLog.newValue })
    .from(auditLog)
    .where(and(eq(auditLog.action, "site.page.schedule_failed"), gte(auditLog.createdAt, new Date(now.getTime() - 30 * 86_400_000))))
    .orderBy(desc(auditLog.createdAt));
  const failedIds = [...new Set(failed.map((f) => f.entityId).filter((x): x is string => !!x))];
  if (failedIds.length) {
    const still = await d
      .select({ id: pageVersions.id, pageId: pageVersions.pageId })
      .from(pageVersions)
      .where(and(inArray(pageVersions.id, failedIds), inArray(pageVersions.state, ["draft", "proposed"]), sql`${pageVersions.scheduledPublishAt} is null`));
    for (const s of still) if (byId.has(s.pageId)) out.push({ code: "schedule_failed", goLive: false, pageId: s.pageId, versionId: s.id, title: titleOf(s.pageId) });
  }

  // Live versions: inactive products (edge case 13), event pages without a session or past (edge cases 14-15).
  const liveVersions = versions.filter((v) => byId.get(v.pageId)?.status === "published" && byId.get(v.pageId)?.currentVersionId === v.id);
  const productIds = new Set<string>();
  for (const v of liveVersions)
    for (const l of LOCALES)
      for (const b of v.blocks?.[l] ?? []) {
        if (b.type === "pricing_table") for (const id of b.productIds) productIds.add(id);
        if (b.type === "booking_cta" && b.target.kind === "buy_product") productIds.add(b.target.productId);
      }
  if (productIds.size) {
    const inactive = new Set(
      (await d.select({ id: products.id, isActive: products.isActive }).from(products).where(inArray(products.id, [...productIds]))).filter((p) => !p.isActive).map((p) => p.id),
    );
    for (const v of liveVersions) {
      const json = JSON.stringify(v.blocks ?? {});
      const hit = [...inactive].filter((id) => json.includes(id));
      if (hit.length) out.push({ code: "product_inactive", goLive: false, pageId: v.pageId, versionId: v.id, title: titleOf(v.pageId), details: hit });
    }
  }
  const eventPages = allPages.filter((p) => p.kind === "event" && p.status === "published");
  const sessionRows = eventPages.some((p) => p.sessionId)
    ? await d.select({ id: sessions.id, endsAt: sessions.endsAt }).from(sessions).where(inArray(sessions.id, eventPages.map((p) => p.sessionId).filter((x): x is string => !!x)))
    : [];
  for (const p of eventPages) {
    const s = sessionRows.find((r) => r.id === p.sessionId);
    if (!s) out.push({ code: "event_session_missing", goLive: false, pageId: p.id, title: titleOf(p.id) });
    else if (s.endsAt.getTime() < now.getTime()) out.push({ code: "event_past", goLive: false, pageId: p.id, title: titleOf(p.id) });
  }

  // Menu items pointing at hidden pages (rule 24).
  const menus = await d.select().from(navMenus);
  for (const m of menus) {
    for (const h of await hiddenNavTargets(d, m.key, (m.items ?? []))) {
      out.push({ code: "nav_target_hidden", goLive: false, pageId: h.pageId, locale: h.locale, details: [m.key, h.itemId], title: byId.has(h.pageId) ? titleOf(h.pageId) : undefined });
    }
  }
  return [...goLive, ...out];
}

// ---------------------------------------------------------------------------------------------
// Open Claude requests and pickers
// ---------------------------------------------------------------------------------------------

export type OpenEditRequest = { editRequestId: string; pageId: string; status: "pending" | "running"; createdAt: string; title: string };

export async function listOpenEditRequests(locale: Locale = "en", db?: DbOrTx): Promise<OpenEditRequest[]> {
  const d = await db0(db);
  const rows = await d
    .select({ r: pageEditRequests, slug: pages.slug, title: pageVersions.title })
    .from(pageEditRequests)
    .innerJoin(pages, eq(pages.id, pageEditRequests.pageId))
    .leftJoin(pageVersions, eq(pageVersions.id, pages.currentVersionId))
    .where(inArray(pageEditRequests.status, ["pending", "running"]))
    .orderBy(desc(pageEditRequests.createdAt));
  return rows.map(({ r, slug, title }) => ({ editRequestId: r.id, pageId: r.pageId, status: r.status as "pending" | "running", createdAt: r.createdAt.toISOString(), title: titleIn(title, locale, slug) }));
}

export type PickerOption = { id: string; label: string; hint?: string };

export type EditorPickers = {
  pages: (PickerOption & { status: PageStatus })[];
  products: PickerOption[];
  sessions: PickerOption[];
  forms: (PickerOption & { slug: string; locales: Locale[] })[];
  media: (PickerOption & { fileId: string; width: number; height: number; alt: LocalizedText; isDecorative: boolean })[];
};

/** Options of the link, product, session, form and media pickers. */
export async function getEditorPickers(locale: Locale = "en", db?: DbOrTx, now: Date = new Date()): Promise<EditorPickers> {
  const d = await db0(db);
  const pageRows = await d
    .select({ id: pages.id, slug: pages.slug, status: pages.status, title: pageVersions.title })
    .from(pages)
    .leftJoin(pageVersions, eq(pageVersions.id, pages.currentVersionId))
    .where(ne(pages.status, "archived"))
    .orderBy(pages.slug);
  const productRows = await d.select({ id: products.id, sku: products.sku, name: products.name }).from(products).where(eq(products.isActive, true)).orderBy(products.sku);
  const sessionRows = await d
    .select({ id: sessions.id, title: sessions.title, startsAt: sessions.startsAt })
    .from(sessions)
    .where(and(eq(sessions.kind, "event"), gte(sessions.endsAt, now), ne(sessions.status, "cancelled")))
    .orderBy(sessions.startsAt)
    .limit(200);
  let forms: EditorPickers["forms"] = [];
  try {
    forms = (await listPublishedForms(d)).map((f) => ({ id: f.id, slug: f.slug, label: titleIn(f.name, locale, f.slug), locales: f.locales }));
  } catch (error) {
    if (!(error instanceof NotImplementedError)) reportError(error, { tags: { module: "site", step: "editor_forms" } });
  }
  const media = await listMedia({}, d);
  return {
    pages: pageRows.map((p) => ({ id: p.id, label: titleIn(p.title, locale, p.slug), hint: p.slug, status: p.status })),
    products: productRows.map((p) => ({ id: p.id, label: titleIn(p.name, locale, p.sku), hint: p.sku })),
    sessions: sessionRows.map((s) => ({ id: s.id, label: titleIn(s.title, locale, s.id), hint: s.startsAt.toISOString() })),
    forms,
    media: media.rows.map((m) => ({ id: m.mediaId, fileId: m.fileId, label: titleIn(m.alt, locale, m.name), width: m.width, height: m.height, alt: m.alt, isDecorative: m.isDecorative })),
  };
}

// ---------------------------------------------------------------------------------------------
// Labels for the client components (`site.admin.*`, flattened: `editor.save`, `issue.path_taken`)
// ---------------------------------------------------------------------------------------------

export type SiteAdminLabels = Record<string, string>;

export function siteAdminLabels(locale: Locale): SiteAdminLabels {
  const tree = ((messagesFor(locale, ["site"]).site as Record<string, unknown> | undefined)?.admin ?? {}) as Record<string, unknown>;
  const out: SiteAdminLabels = {};
  const walk = (node: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string") out[`${prefix}${k}`] = v;
      else if (v && typeof v === "object") walk(v as Record<string, unknown>, `${prefix}${k}.`);
    }
  };
  walk(tree, "");
  return out;
}
