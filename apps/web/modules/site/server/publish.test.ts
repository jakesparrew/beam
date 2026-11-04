/**
 * site-P3 `publishVersionTx` and the reference checks (site rules 5-7, 11, edge cases 2-4): a
 * system context publishes a proposal in the caller's transaction, a second publish of the same
 * version is a conflict, alt text and form references block publishing, and the page kind is
 * found by path (request from forms-P3, rule A2 branch 7).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { pageRoutes, pages, pageVersions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import type { Block } from "@beam/core/site";

vi.mock("@/modules/forms/api", () => ({
  getPublishedFormMeta: (_db: unknown, slug: string) => Promise.resolve(slug === "contact" ? { formId: randomUUID(), locales: ["nl-BE", "fr-BE"] } : null),
  listPublishedForms: () => Promise.resolve([]),
}));

const { createCtx, eq } = await import("@/lib/ctx");
const { publishable, makeMedia, slug, textBlock } = await import("../site-p3.fixtures");
const { getPageKindByPath, checkContent } = await import("./refs");
const { publishVersionTx, PublishBlockedError } = await import("./publish");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

async function pageWith(kind: "standard" | "landing", state: "draft" | "proposed", content = publishable(slug("pub"))) {
  const [p] = await h.db.insert(pages).values({ kind, slug: slug("pub") }).returning();
  const [v] = await h.db
    .insert(pageVersions)
    .values({ pageId: p!.id, version: 1, state, createdBy: state === "proposed" ? "claude" : "user", ...content, excerpt: kind === "landing" ? { "nl-BE": "Kort", "fr-BE": "Court", en: "Short" } : null })
    .returning();
  return { page: p!, version: v!, content };
}

const inTx = <T>(fn: (tx: Tx) => Promise<T>) => h.db.transaction((tx) => fn(tx));
const systemCtx = (tx: Tx) => createCtx({ tx, actor: { kind: "system", jobId: "test" } });

describe("publishVersionTx", () => {
  it("publishes a Claude proposal in the caller's transaction with no publishing user", async () => {
    const { page, version } = await pageWith("landing", "proposed");
    const out = await inTx((tx) => publishVersionTx(tx, systemCtx(tx), version.id, { scheduledBy: randomUUID() }));
    expect(out.publishedAt).toBeInstanceOf(Date);
    const [v] = await h.db.select().from(pageVersions).where(eq(pageVersions.id, version.id));
    expect(v).toMatchObject({ state: "published", publishedByUserId: null });
    const routes = await h.db.select().from(pageRoutes).where(eq(pageRoutes.pageId, page.id));
    expect(routes).toHaveLength(3);
    await expect(inTx((tx) => publishVersionTx(tx, systemCtx(tx), version.id, {}))).rejects.toThrow("already_published");
  });

  it("is blocked by missing alt text and by a form that lacks a locale", async () => {
    const media = await makeMedia(h.db, { "nl-BE": "Sauna" });
    const blocks = (): Block[] => [textBlock(), { id: randomUUID(), type: "image", mediaId: media.id }, { id: randomUUID(), type: "form_embed", formSlug: "contact" }];
    const content = publishable(slug("alt"), ["nl-BE", "en"], { blocks });
    const { version } = await pageWith("standard", "draft", content);
    const error = await inTx((tx) => publishVersionTx(tx, systemCtx(tx), version.id, {})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublishBlockedError);
    const codes = (error as InstanceType<typeof PublishBlockedError>).issues.map((i) => `${i.code}:${i.locale}`);
    expect(codes.sort()).toEqual(["alt_missing:en", "form_locale_missing:en"]);
  });

  it("checkContent reports a missing excerpt for landing pages", async () => {
    const { page, content } = await pageWith("landing", "draft");
    expect(await checkContent(h.db, page, { ...content, excerpt: { "nl-BE": "a", "fr-BE": "b", en: "c" } })).toEqual([]);
    const issues = await checkContent(h.db, page, { ...content, excerpt: null });
    expect(issues.map((i) => `${i.code}:${i.locale}`)).toEqual(["excerpt_missing:nl-BE", "excerpt_missing:fr-BE", "excerpt_missing:en"]);
  });
});

describe("getPageKindByPath", () => {
  it("finds the kind of a live page by path with or without the locale prefix", async () => {
    const { page, version, content } = await pageWith("landing", "draft");
    await inTx((tx) => publishVersionTx(tx, systemCtx(tx), version.id, {}));
    const nl = content.paths["nl-BE"]!;
    expect(await getPageKindByPath(h.db, "nl-BE", nl)).toBe("landing");
    expect(await getPageKindByPath(h.db, "nl-BE", `/nl/${nl}?utm_source=x`)).toBe("landing");
    expect(await getPageKindByPath(h.db, "fr-BE", `/fr/${nl}`)).toBeNull();
    await h.db.update(pages).set({ status: "draft" }).where(eq(pages.id, page.id));
    expect(await getPageKindByPath(h.db, "nl-BE", nl)).toBeNull();
  });
});
