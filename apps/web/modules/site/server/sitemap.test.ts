import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makeSession } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { pageRoutes, pages, pageVersions, settings } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import type { PageSeo } from "@beam/core/site";
import { eq } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";

vi.mock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));

const { setAppDb } = await import("@/lib/ctx");
const { getSitemapEntries, loadSitemapEntries, robotsFor, isProductionEnv } = await import("./sitemap");

const ORIGIN = "https://www.beam.example.com";
const NOW = new Date("2026-06-15T10:00:00Z");
const DAY = 86_400_000;
let handle: DbHandle;

type PageInput = {
  kind?: "standard" | "home" | "event" | "legal";
  status?: "draft" | "published" | "archived";
  paths: Partial<Record<Locale, string>>;
  seo?: Partial<Record<Locale, PageSeo>>;
  legalKey?: "terms" | "guardian_consent";
  sessionId?: string;
  publishedAt?: Date;
  /** Writes routes even for an unpublished page (a stale projection must still be ignored). */
  routes?: boolean;
};

async function page(input: PageInput): Promise<string> {
  const db = handle.db;
  const status = input.status ?? "published";
  const [p] = await db
    .insert(pages)
    .values({ kind: input.kind ?? "standard", slug: `p-${randomUUID().slice(0, 8)}`, legalKey: input.legalKey ?? null, sessionId: input.sessionId ?? null })
    .returning();
  const locales = Object.keys(input.paths) as Locale[];
  const [v] = await db
    .insert(pageVersions)
    .values({
      pageId: p!.id,
      version: 1,
      state: "published",
      publishedAt: input.publishedAt ?? new Date("2026-05-01T08:00:00Z"),
      title: Object.fromEntries(locales.map((l) => [l, `Title ${l}`])),
      paths: input.paths,
      seo: input.seo ?? {},
      locales,
    })
    .returning();
  await db.update(pages).set({ status, currentVersionId: v!.id, ...(status === "archived" ? { archivedAt: new Date() } : {}) }).where(eq(pages.id, p!.id));
  if (input.routes ?? status === "published") {
    for (const l of locales) await db.insert(pageRoutes).values({ pageId: p!.id, locale: l, path: input.paths[l]!, versionId: v!.id });
  }
  return p!.id;
}

const seo = (noindex = false): PageSeo => ({ title: "Title", description: "A description that is long enough for a search result.", noindex });

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  await handle.db
    .insert(settings)
    .values({ key: "site", value: { canonical_origin: `${ORIGIN}/` } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { canonical_origin: `${ORIGIN}/` } } });

  await page({ kind: "home", paths: { "nl-BE": "", "fr-BE": "", en: "" }, publishedAt: new Date("2026-05-02T08:00:00Z") });
  await page({ paths: { "nl-BE": "over-ons", en: "about-us" }, seo: { "nl-BE": seo(), en: seo(true) } });
  await page({ paths: { "nl-BE": "verborgen" }, seo: { "nl-BE": seo(true) } });
  await page({ status: "archived", paths: { "nl-BE": "oud" }, routes: true });
  await page({ status: "draft", paths: { "nl-BE": "concept" } });
  await page({ kind: "legal", legalKey: "terms", paths: { "nl-BE": "voorwaarden" } });
  await page({ kind: "legal", legalKey: "guardian_consent", paths: { "nl-BE": "toestemming-voogd" } });

  const upcoming = await makeSession(handle.db, { kind: "event", startsAt: new Date(NOW.getTime() + 7 * DAY) });
  const recent = await makeSession(handle.db, { kind: "event", startsAt: new Date(NOW.getTime() - 10 * DAY) });
  const old = await makeSession(handle.db, { kind: "event", startsAt: new Date(NOW.getTime() - 40 * DAY) });
  const cancelled = await makeSession(handle.db, { kind: "event", startsAt: new Date(NOW.getTime() + 3 * DAY), status: "cancelled", cancelledAt: NOW, cancelReason: "Weather" });
  await page({ kind: "event", sessionId: upcoming.id, paths: { "nl-BE": "events/concert" } });
  await page({ kind: "event", sessionId: recent.id, paths: { "nl-BE": "events/lezing" } });
  await page({ kind: "event", sessionId: old.id, paths: { "nl-BE": "events/oud-concert" } });
  await page({ kind: "event", sessionId: cancelled.id, paths: { "nl-BE": "events/geannuleerd" } });
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

describe("getSitemapEntries", () => {
  it("lists every live route of indexable pages with alternates and lastModified", async () => {
    const entries = await loadSitemapEntries(handle.db, { now: NOW });
    const urls = entries.map((e) => e.url);
    expect(urls).toEqual(
      [
        `${ORIGIN}/en`,
        `${ORIGIN}/fr`,
        `${ORIGIN}/nl`,
        `${ORIGIN}/nl/over-ons`,
        `${ORIGIN}/nl/voorwaarden`,
        `${ORIGIN}/nl/events/concert`,
        `${ORIGIN}/nl/events/lezing`,
      ].sort((a, b) => a.localeCompare(b)),
    );
    const home = entries.find((e) => e.url === `${ORIGIN}/nl`)!;
    expect(home.lastModified).toBe("2026-05-02T08:00:00.000Z");
    expect(home.alternates).toEqual({ languages: { "nl-BE": `${ORIGIN}/nl`, "fr-BE": `${ORIGIN}/fr`, en: `${ORIGIN}/en` } });
    // `about-us` is noindex in English: neither listed nor offered as an alternate.
    expect(entries.find((e) => e.url === `${ORIGIN}/nl/over-ons`)!.alternates).toBeUndefined();
  });

  it("excludes noindex, archived and draft pages, the guardian consent page and past or cancelled events", async () => {
    const urls = (await loadSitemapEntries(handle.db, { now: NOW })).map((e) => e.url);
    for (const path of ["/en/about-us", "/nl/verborgen", "/nl/oud", "/nl/concept", "/nl/toestemming-voogd", "/nl/events/oud-concert", "/nl/events/geannuleerd"]) {
      expect(urls).not.toContain(`${ORIGIN}${path}`);
    }
  });

  it("serves the same entries through the cached reader", async () => {
    const entries = await getSitemapEntries();
    expect(entries.map((e) => e.url)).toContain(`${ORIGIN}/nl/over-ons`);
  });
});

describe("robots", () => {
  it("allows the site in production and points at the sitemap", () => {
    expect(robotsFor({ isProduction: true, origin: ORIGIN })).toEqual({
      rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/api", "/*/account", "/*/preview"] }],
      sitemap: `${ORIGIN}/sitemap.xml`,
    });
  });

  it("disallows everything outside production", () => {
    expect(robotsFor({ isProduction: false, origin: ORIGIN })).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
    expect(isProductionEnv({ VERCEL_ENV: "preview" })).toBe(false);
    expect(isProductionEnv({})).toBe(false);
    expect(isProductionEnv({ VERCEL_ENV: "production" })).toBe(true);
  });
});
