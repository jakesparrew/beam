/**
 * site-P3 page actions (site spec section 4, rules 3-16 and 54-55, section 12 tests): create, save
 * with optimistic locking, one draft, publish checks per locale, routes, rename redirects,
 * schedules, unpublish and archive with redirects, restore of archived pages, version restore, the
 * immutability of published rows and every allowed and one refused transition per state.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, pageEditRequests, pageRoutes, pages, pageVersions, redirects } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.41" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
const revalidated: string[] = [];
vi.mock("next/cache", () => ({ revalidateTag: (tag: string) => void revalidated.push(tag), unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));

const actions = await import("./pages");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { issuesFromFields } = await import("../server/publish");
const { getContentIssues } = await import("../queries/admin");
const { publishable, queued, slug, staffSession } = await import("../site-p3.fixtures");

let h: DbHandle;
let userId: string;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  revalidated.length = 0;
  userId = (await staffSession(h.db, jar, ["site.edit", "site.publish"])).id;
});

type Ok<T> = { ok: true; data: T };
function ok<T>(r: { ok: boolean; data?: T; error?: unknown }): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return (r as Ok<T>).data;
}

/** A standard page with a draft holding publishable content in `locales`. */
async function draftPage(base = slug("pg"), opts: { kind?: "standard" | "home" | "legal" | "landing"; legalKey?: "terms" | "accessibility_statement"; locales?: ("nl-BE" | "fr-BE" | "en")[] } = {}) {
  const locales = opts.locales ?? ["nl-BE", "fr-BE", "en"];
  const created = ok(await actions.createPage({ kind: opts.kind ?? "standard", slug: base, title: { "nl-BE": base }, locales, ...(opts.legalKey ? { legalKey: opts.legalKey } : {}) }));
  const content = publishable(base, locales);
  if (opts.kind === "home") for (const l of locales) content.paths[l] = "";
  const [row] = await h.db.select().from(pageVersions).where(eq(pageVersions.id, created.versionId));
  const saved = ok(await actions.saveDraft({ pageId: created.pageId, versionId: created.versionId, expectedUpdatedAt: row!.updatedAt.toISOString(), ...content }));
  return { pageId: created.pageId, versionId: saved.versionId, content, updatedAt: saved.updatedAt };
}

async function publishedPage(base = slug("pg"), opts: Parameters<typeof draftPage>[1] = {}) {
  const d = await draftPage(base, opts);
  ok(await actions.publishVersion({ versionId: d.versionId }));
  return d;
}

async function newDraft(pageId: string, content: ReturnType<typeof publishable>) {
  return ok(await actions.saveDraft({ pageId, ...content }));
}

const pageRow = async (id: string) => (await h.db.select().from(pages).where(eq(pages.id, id)))[0]!;
const versionRow = async (id: string) => (await h.db.select().from(pageVersions).where(eq(pageVersions.id, id)))[0];
const routesOf = (id: string) => h.db.select().from(pageRoutes).where(eq(pageRoutes.pageId, id));

describe("createPage and saveDraft", () => {
  it("creates a page with draft version 1 and audits it", async () => {
    const base = slug("new");
    const res = ok(await actions.createPage({ kind: "offer", slug: base, title: { "nl-BE": "Zomeractie", en: "Summer offer" }, locales: ["nl-BE", "en"] }));
    const v = await versionRow(res.versionId);
    expect(v).toMatchObject({ pageId: res.pageId, version: 1, state: "draft", createdBy: "user", createdByUserId: userId, locales: ["nl-BE", "en"] });
    expect(v!.paths).toEqual({ "nl-BE": "zomeractie", en: "summer-offer" });
    expect((await pageRow(res.pageId)).status).toBe("draft");
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "site.page.create"), eq(auditLog.entityId, res.pageId)));
    expect(audit).toBeTruthy();
  });

  it("refuses a taken slug, a second home and a legal page without a key", async () => {
    const base = slug("dup");
    ok(await actions.createPage({ kind: "standard", slug: base, title: {}, locales: ["nl-BE"] }));
    expect(await actions.createPage({ kind: "standard", slug: base, title: {}, locales: ["nl-BE"] })).toMatchObject({ ok: false, error: { code: "validation", fields: { slug: "taken" } } });
    expect(await actions.createPage({ kind: "legal", slug: slug("legal"), title: {}, locales: ["nl-BE"] })).toMatchObject({ ok: false, error: { code: "validation", fields: { legalKey: "required" } } });
    await draftPage(slug("home"), { kind: "home" });
    expect(await actions.createPage({ kind: "home", slug: slug("home2"), title: {}, locales: ["nl-BE"] })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("saves with an optimistic lock: a stale updatedAt is a conflict and writes nothing", async () => {
    const d = await draftPage();
    const next = { ...d.content, title: { ...d.content.title, en: "Changed" } };
    const saved = ok(await actions.saveDraft({ pageId: d.pageId, versionId: d.versionId, expectedUpdatedAt: d.updatedAt, ...next }));
    expect(saved.versionId).toBe(d.versionId);
    expect(saved.issues).toEqual([]);
    const stale = await actions.saveDraft({ pageId: d.pageId, versionId: d.versionId, expectedUpdatedAt: d.updatedAt, ...d.content, title: { en: "Lost" } });
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await versionRow(d.versionId))!.title.en).toBe("Changed");
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "site.page.save_draft"), eq(auditLog.entityId, d.pageId)));
    expect(JSON.stringify(audit!.newValue)).not.toContain("Changed");
    expect(audit!.newValue).toMatchObject({ versionId: d.versionId, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("keeps one draft per page: a save without the draft id is refused", async () => {
    const d = await draftPage();
    expect(await actions.saveDraft({ pageId: d.pageId, ...d.content })).toMatchObject({ ok: false, error: { code: "conflict", message: "draft_exists" } });
    const drafts = await h.db.select().from(pageVersions).where(and(eq(pageVersions.pageId, d.pageId), eq(pageVersions.state, "draft")));
    expect(drafts).toHaveLength(1);
  });

  it("refuses blocks that fail the block schema (validation on every write)", async () => {
    const d = await draftPage();
    const bad = { ...d.content, blocks: { "nl-BE": [{ id: randomUUID(), type: "hero", heading: "x", cta: { label: "Go", link: { kind: "url", href: "javascript:alert(1)" } } }] } };
    expect(await actions.saveDraft({ pageId: d.pageId, versionId: d.versionId, ...bad })).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});

describe("publishVersion", () => {
  it("is blocked with the issue list per locale", async () => {
    const d = await draftPage();
    const content = { ...d.content, seo: { ...d.content.seo, "fr-BE": { title: "", description: "short" } } };
    ok(await actions.saveDraft({ pageId: d.pageId, versionId: d.versionId, ...content }));
    const res = await actions.publishVersion({ versionId: d.versionId });
    expect(res).toMatchObject({ ok: false, error: { code: "validation", message: "publish_blocked" } });
    const issues = issuesFromFields(!res.ok ? res.error.fields : undefined);
    expect(issues.map((i) => [i.code, i.locale])).toEqual([
      ["seo_title_length", "fr-BE"],
      ["seo_description_length", "fr-BE"],
    ]);
    expect((await versionRow(d.versionId))!.state).toBe("draft");
    expect(await routesOf(d.pageId)).toEqual([]);
  });

  it("writes the routes, points the page at the version, audits and revalidates", async () => {
    const d = await draftPage();
    const res = ok(await actions.publishVersion({ versionId: d.versionId }));
    expect(res).toMatchObject({ publishedAt: expect.any(String), pageId: d.pageId });
    const page = await pageRow(d.pageId);
    expect(page).toMatchObject({ status: "published", currentVersionId: d.versionId });
    expect(page.firstPublishedAt).toBeTruthy();
    expect(await versionRow(d.versionId)).toMatchObject({ state: "published", publishedByUserId: userId });
    const routes = await routesOf(d.pageId);
    expect(Object.fromEntries(routes.map((r) => [r.locale, r.path]))).toEqual(d.content.paths);
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "site.page.publish"), eq(auditLog.entityId, d.pageId)));
    expect(audit!.newValue).toMatchObject({ versionId: d.versionId, created_by: "user" });
    expect(revalidated).toEqual(expect.arrayContaining([`site:page:${d.pageId}`, "site:routes", "site:nav", "site:sitemap"]));
    expect(await actions.publishVersion({ versionId: d.versionId })).toMatchObject({ ok: false, error: { code: "conflict", message: "already_published" } });
  });

  it("refuses a path another page holds in that locale (path_taken)", async () => {
    const a = await publishedPage();
    const b = await draftPage();
    ok(await actions.saveDraft({ pageId: b.pageId, versionId: b.versionId, ...b.content, paths: { ...b.content.paths, en: a.content.paths.en } }));
    const res = await actions.publishVersion({ versionId: b.versionId });
    expect(issuesFromFields(!res.ok ? res.error.fields : undefined)).toEqual([expect.objectContaining({ code: "path_taken", locale: "en" })]);
  });

  it("a rename creates a redirect from the old path and removes a redirect from the new path", async () => {
    const d = await publishedPage();
    const newPath = `${d.content.paths["nl-BE"]}-nieuw`;
    await h.db.insert(redirects).values({ fromPath: `/nl/${newPath}`, toUrl: "/nl/elders", source: "manual" });
    const draft = await newDraft(d.pageId, { ...d.content, paths: { ...d.content.paths, "nl-BE": newPath } });
    ok(await actions.publishVersion({ versionId: draft.versionId }));
    const [rename] = await h.db.select().from(redirects).where(eq(redirects.fromPath, `/nl/${d.content.paths["nl-BE"]}`));
    expect(rename).toMatchObject({ toPageId: d.pageId, toLocale: "nl-BE", toUrl: null, source: "rename", isPermanent: true });
    expect(await h.db.select().from(redirects).where(eq(redirects.fromPath, `/nl/${newPath}`))).toEqual([]);
    const routes = await routesOf(d.pageId);
    expect(routes.find((r) => r.locale === "nl-BE")!.path).toBe(newPath);
    expect(await h.db.select().from(redirects).where(eq(redirects.fromPath, `/fr/${d.content.paths["fr-BE"]}`))).toEqual([]);
  });

  it("schedules only between 5 minutes and 365 days ahead and enqueues the job", async () => {
    const d = await draftPage();
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    expect(await actions.publishVersion({ versionId: d.versionId, scheduleAt: at(60_000) })).toMatchObject({ ok: false, error: { code: "validation", fields: { scheduleAt: "too_soon" } } });
    expect(await actions.publishVersion({ versionId: d.versionId, scheduleAt: at(366 * 86_400_000) })).toMatchObject({ ok: false, error: { code: "validation", fields: { scheduleAt: "too_far" } } });
    const when = new Date(Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000);
    const res = ok(await actions.publishVersion({ versionId: d.versionId, scheduleAt: when.toISOString() }));
    expect(res).toMatchObject({ scheduledAt: when.toISOString() });
    expect((await versionRow(d.versionId))!.scheduledPublishAt?.toISOString()).toBe(when.toISOString());
    const jobs = (await queued(h.db, "site.publish_version")).filter((j) => (j.payload as { versionId: string }).versionId === d.versionId);
    expect(jobs.map((j) => j.idempotencyKey)).toEqual([`page_version:${d.versionId}:publish:${when.toISOString().slice(0, 16)}`]);
    expect((await pageRow(d.pageId)).status).toBe("draft");
    ok(await actions.cancelScheduledPublish({ versionId: d.versionId }));
    expect((await versionRow(d.versionId))!.scheduledPublishAt).toBeNull();
  });
});

describe("unpublish, archive and restore (rules 12, 54, 55)", () => {
  it("unpublish returns the page to draft without routes (its paths answer 404)", async () => {
    const d = await publishedPage();
    ok(await actions.unpublishPage({ pageId: d.pageId }));
    expect((await pageRow(d.pageId)).status).toBe("draft");
    expect(await routesOf(d.pageId)).toEqual([]);
    expect(await h.db.select().from(redirects).where(eq(redirects.fromPath, `/nl/${d.content.paths["nl-BE"]}`))).toEqual([]);
    expect(await actions.unpublishPage({ pageId: d.pageId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("archive with a redirect sends every former path to the target, rejects proposals and cancels pending requests", async () => {
    const target = await publishedPage();
    const d = await publishedPage();
    const [proposal] = await h.db
      .insert(pageVersions)
      .values({ pageId: d.pageId, version: 9, state: "proposed", createdBy: "claude", createdByUserId: userId, locales: ["nl-BE"], scheduledPublishAt: new Date(Date.now() + 86_400_000) })
      .returning();
    const [request] = await h.db.insert(pageEditRequests).values({ pageId: d.pageId, instruction: "Add an FAQ", locales: ["nl-BE"], requestedByUserId: userId }).returning();
    ok(await actions.archivePage({ pageId: d.pageId, redirectTo: { kind: "page", pageId: target.pageId } }));
    const page = await pageRow(d.pageId);
    expect(page).toMatchObject({ status: "archived", archivedByUserId: userId });
    expect(await routesOf(d.pageId)).toEqual([]);
    const rows = await h.db.select().from(redirects).where(eq(redirects.toPageId, target.pageId));
    expect(rows.map((r) => [r.fromPath, r.toLocale, r.source]).sort()).toEqual(
      [
        [`/en/${d.content.paths.en}`, "en", "archive"],
        [`/fr/${d.content.paths["fr-BE"]}`, "fr-BE", "archive"],
        [`/nl/${d.content.paths["nl-BE"]}`, "nl-BE", "archive"],
      ].sort(),
    );
    expect(await versionRow(proposal!.id)).toMatchObject({ state: "rejected", rejectReason: "Page archived", scheduledPublishAt: null });
    expect((await h.db.select().from(pageEditRequests).where(eq(pageEditRequests.id, request!.id)))[0]!.status).toBe("cancelled");
    expect(await actions.archivePage({ pageId: d.pageId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("restores an archived page to draft and removes its archive redirects", async () => {
    const target = await publishedPage();
    const d = await publishedPage();
    ok(await actions.archivePage({ pageId: d.pageId, redirectTo: { kind: "page", pageId: target.pageId } }));
    ok(await actions.restoreArchivedPage({ pageId: d.pageId }));
    expect(await pageRow(d.pageId)).toMatchObject({ status: "draft", archivedAt: null });
    expect(await h.db.select().from(redirects).where(eq(redirects.toPageId, target.pageId))).toEqual([]);
    expect(await actions.restoreArchivedPage({ pageId: d.pageId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("refuses restore while another page holds the singleton kind or the legal key", async () => {
    await h.db.update(pages).set({ status: "archived" }).where(eq(pages.kind, "home"));
    const home = await publishedPage(slug("home"), { kind: "home" });
    ok(await actions.archivePage({ pageId: home.pageId }));
    await draftPage(slug("home"), { kind: "home" });
    const res = await actions.restoreArchivedPage({ pageId: home.pageId });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict", message: expect.stringMatching(/^kind_taken:/) } });

    const terms = await draftPage(slug("terms"), { kind: "legal", legalKey: "terms" });
    ok(await actions.archivePage({ pageId: terms.pageId }));
    await draftPage(slug("terms"), { kind: "legal", legalKey: "terms" });
    expect(await actions.restoreArchivedPage({ pageId: terms.pageId })).toMatchObject({ ok: false, error: { code: "conflict", message: expect.stringMatching(/^legal_key_taken:/) } });
  });
});

describe("state transitions (rules 54-55)", () => {
  it("pages: draft -> published -> published -> draft -> archived -> draft -> archived", async () => {
    const d = await publishedPage();
    expect((await pageRow(d.pageId)).status).toBe("published");
    const v2 = await newDraft(d.pageId, { ...d.content, title: { ...d.content.title, en: "v2" } });
    ok(await actions.publishVersion({ versionId: v2.versionId }));
    expect(await pageRow(d.pageId)).toMatchObject({ status: "published", currentVersionId: v2.versionId });
    expect((await versionRow(d.versionId))!.state).toBe("published");
    ok(await actions.unpublishPage({ pageId: d.pageId }));
    ok(await actions.archivePage({ pageId: d.pageId }));
    ok(await actions.restoreArchivedPage({ pageId: d.pageId }));
    expect((await pageRow(d.pageId)).status).toBe("draft");
    // published -> archived directly
    const e = await publishedPage();
    ok(await actions.archivePage({ pageId: e.pageId }));
    expect((await pageRow(e.pageId)).status).toBe("archived");
    // refused: publish a version of an archived page; restore a draft page
    const v3 = await h.db.insert(pageVersions).values({ pageId: e.pageId, version: 5, state: "draft", locales: ["nl-BE"] }).returning();
    expect(await actions.publishVersion({ versionId: v3[0]!.id })).toMatchObject({ ok: false, error: { code: "conflict", message: "page_archived" } });
    expect(await actions.restoreArchivedPage({ pageId: d.pageId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("versions: draft -> deleted, proposed -> published, published is final", async () => {
    const d = await publishedPage();
    const v2 = await newDraft(d.pageId, d.content);
    ok(await actions.discardDraft({ versionId: v2.versionId }));
    expect(await versionRow(v2.versionId)).toBeUndefined();
    expect(await actions.discardDraft({ versionId: d.versionId })).toMatchObject({ ok: false, error: { code: "conflict" } });

    const [proposal] = await h.db
      .insert(pageVersions)
      .values({ pageId: d.pageId, version: 7, state: "proposed", createdBy: "claude", createdByUserId: userId, ...d.content, basedOnVersionId: d.versionId })
      .returning();
    ok(await actions.publishVersion({ versionId: proposal!.id }));
    expect(await versionRow(proposal!.id)).toMatchObject({ state: "published" });
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "site.page.publish"), eq(auditLog.entityId, d.pageId))).orderBy(auditLog.createdAt);
    expect(audit).toBeTruthy();
    const rows = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "site.page.publish"), eq(auditLog.entityId, d.pageId)));
    expect(rows.some((r) => (r.newValue as { created_by?: string }).created_by === "claude")).toBe(true);

    const [rejected] = await h.db.insert(pageVersions).values({ pageId: d.pageId, version: 8, state: "rejected", createdBy: "claude", rejectedAt: new Date(), locales: ["nl-BE"] }).returning();
    expect(await actions.publishVersion({ versionId: rejected!.id })).toMatchObject({ ok: false, error: { code: "conflict", message: "version_rejected" } });
  });

  it("restore version n copies it into a new draft; an existing draft needs replaceExisting", async () => {
    const d = await publishedPage();
    const v2 = await newDraft(d.pageId, { ...d.content, title: { ...d.content.title, en: "second" } });
    ok(await actions.publishVersion({ versionId: v2.versionId }));
    const draft = ok(await actions.createDraftFromVersion({ pageId: d.pageId, fromVersionId: d.versionId, replaceExisting: false }));
    const row = await versionRow(draft.versionId);
    expect(row).toMatchObject({ state: "draft", basedOnVersionId: d.versionId, version: 3 });
    expect(row!.title).toEqual(d.content.title);
    expect(await actions.createDraftFromVersion({ pageId: d.pageId, fromVersionId: v2.versionId, replaceExisting: false })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const replaced = ok(await actions.createDraftFromVersion({ pageId: d.pageId, fromVersionId: v2.versionId, replaceExisting: true }));
    expect(await versionRow(draft.versionId)).toBeUndefined();
    expect((await versionRow(replaced.versionId))!.title.en).toBe("second");
  });

  it("a published row cannot be updated through saveDraft", async () => {
    const d = await publishedPage();
    expect(await actions.saveDraft({ pageId: d.pageId, versionId: d.versionId, ...d.content, title: { en: "x" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await versionRow(d.versionId))!.title).toEqual(d.content.title);
  });
});

describe("go-live issues (rules 60, 61)", () => {
  it("lists the missing accessibility statement and company details as go-live issues", async () => {
    const issues = await getContentIssues(h.db);
    const goLive = issues.filter((i) => i.goLive);
    expect(goLive).toEqual(expect.arrayContaining([expect.objectContaining({ code: "legal_page_missing", details: ["accessibility_statement"] })]));
    expect(goLive.some((i) => i.code === "company_identification_missing")).toBe(true);
    const a11y = await publishedPage(slug("toegankelijkheid"), { kind: "legal", legalKey: "accessibility_statement" });
    expect(a11y).toBeTruthy();
    const after = await getContentIssues(h.db);
    expect(after.some((i) => i.code === "legal_page_missing" && i.details?.[0] === "accessibility_statement")).toBe(false);
  });
});
