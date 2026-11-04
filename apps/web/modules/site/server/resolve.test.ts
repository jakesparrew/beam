import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeSession } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { pageRoutes, pages, pageVersions, redirects } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import { eq } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";

const afterQueue: (() => unknown)[] = [];
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void afterQueue.push(fn) }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));

const { setAppDb } = await import("@/lib/ctx");
const { resolveRequest } = await import("./resolve");

let handle: DbHandle;

type PageInput = {
  kind?: "standard" | "home" | "event";
  status?: "draft" | "published" | "archived";
  paths: Partial<Record<Locale, string>>;
  live?: boolean;
  sessionId?: string;
};

/** A page with one published version; `live` (default when published) writes its routes. */
async function page(input: PageInput): Promise<string> {
  const db = handle.db;
  const status = input.status ?? "published";
  const kind = input.kind ?? "standard";
  const [p] = await db.insert(pages).values({ kind, slug: `p-${randomUUID().slice(0, 8)}`, sessionId: input.sessionId ?? null }).returning();
  const locales = Object.keys(input.paths) as Locale[];
  const [v] = await db
    .insert(pageVersions)
    .values({ pageId: p!.id, version: 1, state: "published", publishedAt: new Date(), title: Object.fromEntries(locales.map((l) => [l, `Title ${l}`])), paths: input.paths, locales })
    .returning();
  await db.update(pages).set({ status, currentVersionId: v!.id, ...(status === "archived" ? { archivedAt: new Date() } : {}) }).where(eq(pages.id, p!.id));
  if (input.live ?? status === "published") {
    for (const l of locales) await db.insert(pageRoutes).values({ pageId: p!.id, locale: l, path: input.paths[l]!, versionId: v!.id });
  }
  return p!.id;
}

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => {
  afterQueue.length = 0;
});

describe("resolveRequest", () => {
  it("renders the live route of the locale", async () => {
    const id = await page({ paths: { "nl-BE": "over-ons", en: "about-us" } });
    const r = await resolveRequest("nl-BE", ["over-ons"]);
    expect(r.kind).toBe("page");
    if (r.kind !== "page") return;
    expect(r.page.pageId).toBe(id);
    expect(r.page.routes).toEqual({ "nl-BE": "over-ons", en: "about-us" });
    expect(r.page.title).toBe("Title nl-BE");
  });

  it("follows a rename redirect to the page's current path", async () => {
    const id = await page({ paths: { "nl-BE": "dagsessies-nieuw" } });
    await handle.db.insert(redirects).values({ fromPath: "/nl/dagsessies-oud", toPageId: id, toLocale: "nl-BE", source: "rename" });
    expect(await resolveRequest("nl-BE", ["dagsessies-oud"])).toEqual({ kind: "redirect", to: "/nl/dagsessies-nieuw", permanent: true });
  });

  it("follows a to_url redirect with its permanence", async () => {
    await handle.db.insert(redirects).values({ fromPath: "/nl/partner", toUrl: "https://partner.example.com/beam", isPermanent: false, source: "manual" });
    expect(await resolveRequest("nl-BE", ["partner"])).toEqual({ kind: "redirect", to: "https://partner.example.com/beam", permanent: false });
  });

  it("looks up the prefix-less WordPress path after the prefixed one", async () => {
    const id = await page({ paths: { "nl-BE": "nachten" } });
    await handle.db.insert(redirects).values({ fromPath: "/overnachten", toPageId: id, toLocale: "nl-BE", source: "wordpress" });
    expect(await resolveRequest("nl-BE", ["overnachten"])).toEqual({ kind: "redirect", to: "/nl/nachten", permanent: true });
    expect(await resolveRequest("nl-BE", ["Overnachten"])).toEqual({ kind: "redirect", to: "/nl/nachten", permanent: true });
  });

  it("looks up `?p=` and `?page_id=` links on home before rendering it", async () => {
    await page({ kind: "home", paths: { "nl-BE": "", en: "" } });
    const target = await page({ paths: { "nl-BE": "prijzen" } });
    await handle.db.insert(redirects).values({ fromPath: "/?p=123", toPageId: target, toLocale: "nl-BE", source: "wordpress" });
    await handle.db.insert(redirects).values({ fromPath: "/?page_id=45", toPageId: target, toLocale: "nl-BE", source: "wordpress" });
    expect(await resolveRequest("nl-BE", [], new URLSearchParams("p=123"))).toEqual({ kind: "redirect", to: "/nl/prijzen", permanent: true });
    expect(await resolveRequest("nl-BE", [], { page_id: "45" })).toEqual({ kind: "redirect", to: "/nl/prijzen", permanent: true });
    const home = await resolveRequest("nl-BE", [], { p: "999" });
    expect(home.kind === "page" && home.page.kind).toBe("home");
  });

  it("answers gone for an archived page's former path", async () => {
    await page({ status: "archived", paths: { "nl-BE": "oude-actie" }, live: false });
    expect(await resolveRequest("nl-BE", ["oude-actie"])).toEqual({ kind: "gone" });
  });

  it("answers gone for a redirect to an archived page", async () => {
    const id = await page({ status: "archived", paths: { "nl-BE": "weg" }, live: false });
    await handle.db.insert(redirects).values({ fromPath: "/nl/naar-weg", toPageId: id, toLocale: "nl-BE", source: "manual" });
    expect(await resolveRequest("nl-BE", ["naar-weg"])).toEqual({ kind: "gone" });
  });

  it("answers not found for an unpublished page", async () => {
    await page({ status: "draft", paths: { "nl-BE": "concept" }, live: false });
    expect(await resolveRequest("nl-BE", ["concept"])).toEqual({ kind: "not_found" });
    expect(await resolveRequest("nl-BE", ["bestaat-niet"])).toEqual({ kind: "not_found" });
  });

  it("sends a path that is live only in another locale to `unavailable`", async () => {
    const id = await page({ paths: { "nl-BE": "alleen-nederlands" } });
    expect(await resolveRequest("fr-BE", ["alleen-nederlands"])).toEqual({ kind: "redirect", to: `/fr/unavailable?page=${id}`, permanent: false });
  });

  it("resolves the stable event link to the event page, else the portal booking page", async () => {
    const withPage = await makeSession(handle.db, { kind: "event" });
    await page({ kind: "event", sessionId: withPage.id, paths: { "nl-BE": "events/yoga-avond", "fr-BE": "evenements/soiree-yoga" } });
    expect(await resolveRequest("fr-BE", ["events", withPage.id])).toEqual({ kind: "redirect", to: "/fr/evenements/soiree-yoga", permanent: false });
    const without = await makeSession(handle.db, { kind: "event" });
    expect(await resolveRequest("nl-BE", ["events", without.id])).toEqual({ kind: "redirect", to: `/nl/account/book/${without.id}`, permanent: false });
    // the event page exists only in nl and fr: an English visitor books in the portal
    expect(await resolveRequest("en", ["events", withPage.id])).toEqual({ kind: "redirect", to: `/en/account/book/${withPage.id}`, permanent: false });
  });

  it("answers not found for a stable link to a non-event or unknown session", async () => {
    const day = await makeSession(handle.db, { kind: "day" });
    expect(await resolveRequest("nl-BE", ["events", day.id])).toEqual({ kind: "not_found" });
    expect(await resolveRequest("nl-BE", ["events", randomUUID()])).toEqual({ kind: "not_found" });
  });

  it("answers gone for the legacy WordPress paths after the locale prefix", async () => {
    expect(await resolveRequest("nl-BE", ["wp-admin"])).toEqual({ kind: "gone" });
    expect(await resolveRequest("nl-BE", ["wp-admin", "edit.php"])).toEqual({ kind: "gone" });
    expect(await resolveRequest("fr-BE", ["wp-login.php"])).toEqual({ kind: "gone" });
    expect(await resolveRequest("en", ["xmlrpc.php"])).toEqual({ kind: "gone" });
  });

  it("counts a redirect as seen through after(), not on the response path", async () => {
    const id = await page({ paths: { "nl-BE": "teller" } });
    const [row] = await handle.db.insert(redirects).values({ fromPath: "/nl/teller-oud", toPageId: id, toLocale: "nl-BE", source: "manual" }).returning();
    await resolveRequest("nl-BE", ["teller-oud"]);
    const [before] = await handle.db.select().from(redirects).where(eq(redirects.id, row!.id));
    expect(before!.hits).toBe(0);
    expect(afterQueue).toHaveLength(1);
    await afterQueue[0]!();
    const [seen] = await handle.db.select().from(redirects).where(eq(redirects.id, row!.id));
    expect(seen!.hits).toBe(1);
    expect(seen!.lastHitAt).toBeInstanceOf(Date);
  });
});
