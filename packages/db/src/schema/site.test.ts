import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../client";
import { createTestDb, makePerson, makeSession, makeUser } from "../testing";
import { files } from "./platform";
import {
  cookieConsents,
  mediaAssets,
  navMenus,
  pageEditRequests,
  pageRoutes,
  pages,
  pageVersions,
  redirects,
  siteAuditReports,
  termsAcceptances,
  wordpressImportItems,
  wordpressImports,
} from "./site";
import { vLegalVersions, vPublishedPages, vSiteEvents, vSitePageOverview, vTermsAcceptanceLatest } from "./site.views";

/** The Postgres error behind a failed query (message and SQLSTATE). */
async function pgError(promise: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string; code?: string } }).cause ?? (error as { message?: string; code?: string });
    return { message: String(cause.message ?? error), code: cause.code };
  }
  throw new Error("expected the query to fail");
}

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

let n = 0;
const slug = (p = "page") => `${p}-${++n}`;

async function page(over: Partial<typeof pages.$inferInsert> = {}) {
  const [row] = await h.db.insert(pages).values({ kind: "standard", slug: slug(), ...over }).returning();
  return row!;
}

async function version(pageId: string, over: Partial<typeof pageVersions.$inferInsert> = {}) {
  const max = await h.db.execute(sql`select coalesce(max(version), 0)::int as v from page_versions where page_id = ${pageId}`);
  const next = (max as { rows: { v: number }[] }).rows[0]!.v + 1;
  const [row] = await h.db.insert(pageVersions).values({ pageId, version: next, title: { "nl-BE": "Titel" }, ...over }).returning();
  return row!;
}

async function publish(pageId: string, over: Partial<typeof pageVersions.$inferInsert> = {}) {
  const v = await version(pageId, { state: "published", publishedAt: new Date(), ...over });
  await h.db.update(pages).set({ status: "published", currentVersionId: v.id, firstPublishedAt: new Date() }).where(eq(pages.id, pageId));
  return v;
}

describe("site tables and views", () => {
  it("every table and view exists and is queryable", async () => {
    for (const t of [pages, pageVersions, pageRoutes, redirects, navMenus, mediaAssets, pageEditRequests, termsAcceptances, cookieConsents, wordpressImports, wordpressImportItems, siteAuditReports]) {
      await expect(h.db.select().from(t).limit(1)).resolves.toBeDefined();
    }
    for (const v of [vPublishedPages, vSiteEvents, vLegalVersions, vTermsAcceptanceLatest, vSitePageOverview]) {
      await expect(h.db.select().from(v).limit(1)).resolves.toBeDefined();
    }
  });

  it("v_published_pages, v_site_page_overview and v_site_events reflect live versions and drafts", async () => {
    const session = await makeSession(h.db, { kind: "event" });
    const p = await page({ kind: "event", sessionId: session.id });
    const live = await publish(p.id, { locales: ["nl-BE", "en"] });
    const draft = await version(p.id);
    await version(p.id, { state: "proposed", createdBy: "claude" });
    const [pub] = await h.db.select().from(vPublishedPages).where(eq(vPublishedPages.pageId, p.id));
    expect(pub).toMatchObject({ versionId: live.id, version: 1, locales: ["nl-BE", "en"], kind: "event" });
    const [ov] = await h.db.select().from(vSitePageOverview).where(eq(vSitePageOverview.pageId, p.id));
    expect(ov).toMatchObject({ draftVersionId: draft.id, openProposals: 1, status: "published" });
    const [ev] = await h.db.select().from(vSiteEvents).where(eq(vSiteEvents.sessionId, session.id));
    expect(ev).toMatchObject({ pageId: p.id, versionId: live.id });
  });

  it("v_legal_versions numbers published legal versions in order", async () => {
    const terms = await page({ kind: "legal", legalKey: "terms" });
    const v1 = await publish(terms.id, { publishedAt: new Date("2026-01-01T00:00:00Z") });
    const v2 = await publish(terms.id, { publishedAt: new Date("2026-06-01T00:00:00Z"), isMaterialChange: true });
    const rows = await h.db.select().from(vLegalVersions).where(eq(vLegalVersions.legalKey, "terms"));
    expect(rows.map((r) => [r.versionId, r.ordinal, r.isCurrent]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([
      [v1.id, 1, false],
      [v2.id, 2, true],
    ]);
  });

  it("a page has at most one draft version", async () => {
    const p = await page();
    await version(p.id);
    const err = await pgError(version(p.id));
    expect(err.message).toMatch(/page_versions_one_draft_uq/);
    await expect(version(p.id, { state: "proposed", createdBy: "claude" })).resolves.toBeDefined();
  });

  it("exactly one non-archived home page; an archived one frees the kind", async () => {
    const home = await page({ kind: "home", slug: "home" });
    expect((await pgError(page({ kind: "home" }))).message).toMatch(/pages_singleton_kind_uq/);
    await h.db.update(pages).set({ status: "archived" }).where(eq(pages.id, home.id));
    await expect(page({ kind: "home" })).resolves.toBeDefined();
  });

  it("one page per legal key, including accessibility_statement and guardian_consent", async () => {
    for (const legalKey of ["accessibility_statement", "guardian_consent", "privacy_notice", "cookie_notice"] as const) {
      await page({ kind: "legal", legalKey });
      expect((await pgError(page({ kind: "legal", legalKey }))).message).toMatch(/pages_legal_key_uq/);
    }
    expect((await pgError(page({ kind: "legal" }))).message).toMatch(/pages_legal_key_ck/);
    expect((await pgError(page({ kind: "standard", legalKey: "terms" }))).message).toMatch(/pages_legal_key_ck/);
  });

  it("a published page needs a current version; session and partner columns need their kinds", async () => {
    expect((await pgError(page({ status: "published" }))).message).toMatch(/pages_published_version_ck/);
    const session = await makeSession(h.db, { kind: "event" });
    expect((await pgError(page({ kind: "standard", sessionId: session.id }))).message).toMatch(/pages_session_kind_ck/);
    expect((await pgError(page({ kind: "standard", partnerCompanyId: randomUUID() }))).message).toMatch(/pages_partner_kind_ck/);
    expect((await pgError(page({ slug: "Bad Slug" }))).message).toMatch(/pages_slug_ck/);
  });

  it("routes are unique per locale and per page and locale", async () => {
    const a = await page();
    const b = await page();
    const va = await publish(a.id);
    const vb = await publish(b.id);
    await h.db.insert(pageRoutes).values({ pageId: a.id, locale: "nl-BE", path: "over-ons", versionId: va.id });
    await h.db.insert(pageRoutes).values({ pageId: b.id, locale: "fr-BE", path: "over-ons", versionId: vb.id });
    expect((await pgError(h.db.insert(pageRoutes).values({ pageId: b.id, locale: "nl-BE", path: "over-ons", versionId: vb.id }))).message).toMatch(/page_routes_locale_path_uq/);
    expect((await pgError(h.db.insert(pageRoutes).values({ pageId: a.id, locale: "nl-BE", path: "team", versionId: va.id }))).message).toMatch(/page_routes_page_locale_uq/);
    expect((await pgError(h.db.insert(pageRoutes).values({ pageId: a.id, locale: "en", path: "Over/Ons", versionId: va.id }))).message).toMatch(/page_routes_path_ck/);
    expect((await pgError(h.db.insert(pageRoutes).values({ pageId: a.id, locale: "en", path: "a/b/c/d", versionId: va.id }))).message).toMatch(/page_routes_path_ck/);
  });

  it("a redirect targets either a page and locale or a url", async () => {
    const p = await page();
    await h.db.insert(redirects).values({ fromPath: "/over-ons", toPageId: p.id, toLocale: "nl-BE", source: "wordpress" });
    await h.db.insert(redirects).values({ fromPath: "/feed", toUrl: "/nl/feed.xml", source: "wordpress" });
    expect((await pgError(h.db.insert(redirects).values({ fromPath: "/x1", toPageId: p.id, toUrl: "/nl", source: "manual" }))).message).toMatch(/redirects_target_ck/);
    expect((await pgError(h.db.insert(redirects).values({ fromPath: "/x2", toPageId: p.id, source: "manual" }))).message).toMatch(/redirects_target_ck/);
    expect((await pgError(h.db.insert(redirects).values({ fromPath: "/x3", source: "manual" }))).message).toMatch(/redirects_target_ck/);
    expect((await pgError(h.db.insert(redirects).values({ fromPath: "/x4", toUrl: "/x4", source: "manual" }))).message).toMatch(/redirects_to_url_ck/);
    expect((await pgError(h.db.insert(redirects).values({ fromPath: "/x5", toUrl: "javascript:alert(1)", source: "manual" }))).message).toMatch(/redirects_to_url_ck/);
    expect((await pgError(h.db.insert(redirects).values({ fromPath: "/admin/x", toUrl: "/nl", source: "manual" }))).message).toMatch(/redirects_from_path_ck/);
    expect((await pgError(h.db.insert(redirects).values({ fromPath: "/feed", toUrl: "/nl", source: "manual" }))).message).toMatch(/redirects_from_path_unique|unique/);
  });

  it("version state checks: a user row is never superseded, a Claude row is never a draft", async () => {
    const p = await page();
    expect((await pgError(version(p.id, { state: "superseded", createdBy: "user" }))).message).toMatch(/page_versions_superseded_claude_ck/);
    expect((await pgError(version(p.id, { state: "draft", createdBy: "claude" }))).message).toMatch(/page_versions_claude_not_draft_ck/);
    await expect(version(p.id, { state: "superseded", createdBy: "claude" })).resolves.toBeDefined();
    expect((await pgError(version(p.id, { state: "published" }))).message).toMatch(/page_versions_published_ck/);
    expect((await pgError(version(p.id, { state: "rejected", createdBy: "claude" }))).message).toMatch(/page_versions_rejected_ck/);
    expect((await pgError(version(p.id, { scheduledPublishAt: new Date(), state: "rejected", rejectedAt: new Date(), createdBy: "claude" }))).message).toMatch(
      /page_versions_schedule_state_ck/,
    );
    expect((await pgError(version(p.id, { locales: ["de"] as never }))).message).toMatch(/page_versions_locales_ck/);
  });

  it("terms acceptances: idempotency key unique, append-only", async () => {
    const person = await makePerson(h.db);
    const terms = await page({ kind: "legal", legalKey: "terms", slug: slug("terms") }).catch(async () => {
      const [existing] = await h.db.select().from(pages).where(eq(pages.legalKey, "terms"));
      return existing!;
    });
    const v = await publish(terms.id);
    const key = `terms:${person.id}:${v.id}:portal_prompt:none`;
    const row = { personId: person.id, pageVersionId: v.id, legalKey: "terms" as const, context: "portal_prompt" as const, idempotencyKey: key, ip: "192.0.2.1" };
    const [inserted] = await h.db.insert(termsAcceptances).values(row).returning();
    expect((await pgError(h.db.insert(termsAcceptances).values(row))).message).toMatch(/idempotency_key/);
    const again = await h.db.insert(termsAcceptances).values(row).onConflictDoNothing({ target: termsAcceptances.idempotencyKey }).returning();
    expect(again).toHaveLength(0);
    const [latest] = await h.db.select().from(vTermsAcceptanceLatest).where(eq(vTermsAcceptanceLatest.personId, person.id));
    expect(latest).toMatchObject({ pageVersionId: v.id, context: "portal_prompt" });
    expect(inserted!.acceptedAt).toBeInstanceOf(Date);
    const update = await pgError(h.db.update(termsAcceptances).set({ ip: null }).where(eq(termsAcceptances.id, inserted!.id)));
    expect(update.message).toMatch(/append|not allowed|reject|immutable/i);
  });

  it("media, edit requests, imports and audit reports accept valid rows and refuse invalid ones", async () => {
    const user = await makeUser(h.db);
    const [file] = await h.db
      .insert(files)
      .values({ kind: "image", name: "tuin.png", mime: "image/png", sizeBytes: 1, bytes: new Uint8Array([1]), sha256: "b".repeat(64), isPublic: true })
      .returning();
    await h.db.insert(mediaAssets).values({ fileId: file!.id, width: 10, height: 10, alt: { "nl-BE": "Tuin" } });
    expect((await pgError(h.db.insert(mediaAssets).values({ fileId: file!.id, width: 10, height: 10 }))).message).toMatch(/file_id/);
    const p = await page();
    await h.db.insert(pageEditRequests).values({ pageId: p.id, instruction: "Maak korter", locales: ["nl-BE"], requestedByUserId: user.id });
    expect((await pgError(h.db.insert(pageEditRequests).values({ pageId: p.id, instruction: "Nog eens", locales: ["nl-BE"], requestedByUserId: user.id }))).message).toMatch(
      /page_edit_requests_active_uq/,
    );
    const p2 = await page();
    expect((await pgError(h.db.insert(pageEditRequests).values({ pageId: p2.id, instruction: "x", locales: ["nl-BE"], requestedByUserId: user.id }))).message).toMatch(
      /page_edit_requests_instruction_ck/,
    );
    const [wxr] = await h.db
      .insert(files)
      .values({ kind: "import", name: "export.xml", mime: "application/xml", sizeBytes: 1, bytes: new Uint8Array([1]), sha256: "c".repeat(64) })
      .returning();
    expect((await pgError(h.db.insert(wordpressImports).values({ fileId: wxr!.id, siteOrigin: "http://www.beam.be", createdByUserId: user.id }))).message).toMatch(/wordpress_imports_origin_ck/);
    const [imp] = await h.db.insert(wordpressImports).values({ fileId: wxr!.id, siteOrigin: "https://www.beam.be", createdByUserId: user.id }).returning();
    const item = { importId: imp!.id, wpId: 12, wpType: "page" as const, wpStatus: "publish", title: "Over ons", wpLink: "https://www.beam.be/over-ons/", wpPath: "/over-ons" };
    await h.db.insert(wordpressImportItems).values(item);
    expect((await pgError(h.db.insert(wordpressImportItems).values(item))).message).toMatch(/wordpress_import_items_item_uq/);
    await h.db.insert(siteAuditReports).values({ weekOn: "2026-11-02", findings: [] });
    expect((await pgError(h.db.insert(siteAuditReports).values({ weekOn: "2026-11-02", findings: [] }))).message).toMatch(/week_on/);
    await h.db.insert(cookieConsents).values({ consentKey: randomUUID(), choices: { analytics: true, marketing: false }, bannerVersion: 1, action: "custom", locale: "en" });
    await h.db.insert(navMenus).values({ key: "header" });
    expect((await pgError(h.db.insert(navMenus).values({ key: "header" }))).message).toMatch(/key/);
  });
});
