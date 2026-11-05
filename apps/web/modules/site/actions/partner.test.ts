/**
 * site-P9 partner landing pages (site spec section 4, 12): `setPagePartner` needs `site.publish`,
 * takes a partner only for `landing` pages and an existing company, is audited as
 * `site.page.set_partner` and revalidates the page; the form embed of a published landing page
 * passes the partner to forms, every other page kind passes none.
 */
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, companies, pages, pageVersions } from "@beam/db/schema";
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
vi.mock("@/modules/forms/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  FormEmbed: vi.fn((p: { slug: string }) => createElement("div", { "data-form-embed": p.slug })),
}));

const partner = await import("./partner");
const pagesActions = await import("./pages");
const forms = await import("@/modules/forms/api");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { publishable, slug, staffSession } = await import("../site-p3.fixtures");
const { formEmbedProps, FormEmbedBlockView, landingPartnerFor } = await import("../ui/public/blocks/form-embed");
const { emptyRenderData } = await import("../server/render-data");

let h: DbHandle;
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
  await staffSession(h.db, jar, ["site.edit", "site.publish"]);
});

function ok<T>(r: { ok: boolean; data?: T; error?: unknown }): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
}

async function company(name = `Partner ${randomUUID().slice(0, 6)}`, isPartner = true) {
  const [row] = await h.db.insert(companies).values({ name, isPartner }).returning({ id: companies.id, name: companies.name });
  return row!;
}

/** A published page of `kind` in nl-BE; returns its id and live nl path. */
async function publishedPage(kind: "landing" | "standard") {
  const base = slug(kind === "landing" ? "lp" : "pg");
  const created = ok(await pagesActions.createPage({ kind, slug: base, title: { "nl-BE": base }, locales: ["nl-BE"] }));
  const content = { ...publishable(base, ["nl-BE"]), excerpt: { "nl-BE": `Excerpt of ${base}` } };
  const [row] = await h.db.select().from(pageVersions).where(eq(pageVersions.id, created.versionId));
  const saved = ok(await pagesActions.saveDraft({ pageId: created.pageId, versionId: created.versionId, expectedUpdatedAt: row!.updatedAt.toISOString(), ...content }));
  ok(await pagesActions.publishVersion({ versionId: saved.versionId }));
  return { pageId: created.pageId, path: `/nl/${content.paths["nl-BE"]}` };
}

describe("setPagePartner", () => {
  it("links a landing page to a partner company, audits it and revalidates the page", async () => {
    const page = await publishedPage("landing");
    const c = await company();
    const res = ok(await partner.setPagePartner({ pageId: page.pageId, companyId: c.id }));
    expect(res).toEqual({ pageId: page.pageId, partnerCompanyId: c.id, changed: true });
    const [row] = await h.db.select({ p: pages.partnerCompanyId }).from(pages).where(eq(pages.id, page.pageId));
    expect(row!.p).toBe(c.id);
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "site.page.set_partner"), eq(auditLog.entityId, page.pageId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.newValue).toEqual({ partnerCompanyId: c.id });
    expect(revalidated).toContain(`site:page:${page.pageId}`);

    // The same partner again changes nothing; null unlinks.
    revalidated.length = 0;
    expect(ok(await partner.setPagePartner({ pageId: page.pageId, companyId: c.id })).changed).toBe(false);
    expect(revalidated).toEqual([]);
    expect(ok(await partner.setPagePartner({ pageId: page.pageId, companyId: null })).partnerCompanyId).toBeNull();
  });

  it("refuses a partner on a page that is not a landing page, and an unknown company", async () => {
    const page = await publishedPage("standard");
    const c = await company();
    const res = await partner.setPagePartner({ pageId: page.pageId, companyId: c.id });
    expect(res).toMatchObject({ ok: false, error: { code: "validation", fields: { companyId: "landing_only" } } });
    const landing = await publishedPage("landing");
    expect(await partner.setPagePartner({ pageId: landing.pageId, companyId: randomUUID() })).toMatchObject({ ok: false, error: { code: "validation", fields: { companyId: "not_found" } } });
    expect(await partner.setPagePartner({ pageId: randomUUID(), companyId: null })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("requires site.publish", async () => {
    const page = await publishedPage("landing");
    const c = await company();
    jar.clear();
    await staffSession(h.db, jar, ["site.edit"]);
    expect(await partner.setPagePartner({ pageId: page.pageId, companyId: c.id })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});

describe("getPagePartnerOptions", () => {
  it("offers the partner companies and names the current partner (also one no longer flagged partner)", async () => {
    const page = await publishedPage("landing");
    const listed = await company("Aaa Partner");
    const former = await company("Former Partner", false);
    await h.db.update(pages).set({ partnerCompanyId: former.id }).where(eq(pages.id, page.pageId));
    const data = ok(await partner.getPagePartnerOptions({ pageId: page.pageId }));
    expect(data.kind).toBe("landing");
    expect(data.current).toEqual({ id: former.id, name: "Former Partner" });
    expect(data.options.map((o) => o.id)).toEqual(expect.arrayContaining([listed.id, former.id]));
  });

  it("requires site.edit", async () => {
    const page = await publishedPage("landing");
    jar.clear();
    await staffSession(h.db, jar, ["dashboard.read"]);
    expect(await partner.getPagePartnerOptions({ pageId: page.pageId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});

describe("partner id in the form embed (landing pages only)", () => {
  it("landingPartnerFor returns the partner only for a published landing page", async () => {
    const landing = await publishedPage("landing");
    const standard = await publishedPage("standard");
    const c = await company();
    ok(await partner.setPagePartner({ pageId: landing.pageId, companyId: c.id }));
    expect(await landingPartnerFor(h.db, "nl-BE", landing.path)).toBe(c.id);
    expect(await landingPartnerFor(h.db, "nl-BE", `${landing.path}?utm_source=x`)).toBe(c.id);
    expect(await landingPartnerFor(h.db, "fr-BE", landing.path)).toBeNull();
    // A partner can only be stored on a landing page (check constraint); a standard page has none.
    await expect(h.db.update(pages).set({ partnerCompanyId: c.id }).where(eq(pages.id, standard.pageId))).rejects.toThrow();
    expect(await landingPartnerFor(h.db, "nl-BE", standard.path)).toBeNull();
    // Unpublished: no partner.
    ok(await pagesActions.unpublishPage({ pageId: landing.pageId }));
    expect(await landingPartnerFor(h.db, "nl-BE", landing.path)).toBeNull();
  });

  it("formEmbedProps adds partnerCompanyId only when there is one", () => {
    const id = randomUUID();
    expect(formEmbedProps("contact", "nl-BE", "/nl/actie", {}, id).context).toEqual({ pagePath: "/nl/actie", landingPath: "/nl/actie", partnerCompanyId: id });
    expect(formEmbedProps("contact", "nl-BE", "/nl/actie", {}, null).context).toEqual({ pagePath: "/nl/actie", landingPath: "/nl/actie" });
  });

  it("the block passes the partner of render data that knows it, only for landing pages", () => {
    const id = randomUUID();
    const block = { id: randomUUID(), type: "form_embed" as const, formSlug: "contact" };
    const tr = (k: string) => k;
    const render = (extra: Record<string, unknown>) => {
      renderToStaticMarkup(createElement(FormEmbedBlockView, { block, ctx: { locale: "nl-BE", tr, data: { ...emptyRenderData("nl-BE", "/nl/actie"), ...extra } } as never }));
      return vi.mocked(forms.FormEmbed).mock.calls.at(-1)![0].context;
    };
    expect(render({ partnerCompanyId: id, pageKind: "landing" })).toMatchObject({ partnerCompanyId: id });
    expect(render({ partnerCompanyId: id, pageKind: "standard" })).not.toHaveProperty("partnerCompanyId");
    expect(render({})).not.toHaveProperty("partnerCompanyId");
  });
});
