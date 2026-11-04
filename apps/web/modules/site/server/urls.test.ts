import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makeSession } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { pageRoutes, pages, pageVersions, settings } from "@beam/db/schema";
import { DEFAULT_SITE_SETTINGS } from "@beam/core/site";
import { eq } from "@/lib/ctx";
import { absoluteUrl, bookSessionPath, canonicalOrigin, checkoutPath, getEventPageUrl, getPageUrl, giftPath, portalUrl, stableEventPath } from "./urls";

let handle: DbHandle;
let pageId: string;

beforeAll(async () => {
  handle = await createTestDb();
  const [p] = await handle.db.insert(pages).values({ kind: "pricing", slug: "pricing" }).returning();
  const [v] = await handle.db
    .insert(pageVersions)
    .values({ pageId: p!.id, version: 1, state: "published", publishedAt: new Date(), paths: { "nl-BE": "prijzen", "fr-BE": "tarifs" }, locales: ["nl-BE", "fr-BE"] })
    .returning();
  await handle.db.update(pages).set({ status: "published", currentVersionId: v!.id }).where(eq(pages.id, p!.id));
  await handle.db.insert(pageRoutes).values([
    { pageId: p!.id, locale: "nl-BE", path: "prijzen", versionId: v!.id },
    { pageId: p!.id, locale: "fr-BE", path: "tarifs", versionId: v!.id },
  ]);
  pageId = p!.id;
});
afterAll(async () => {
  await handle.close();
});

describe("absolute URLs from canonical_origin", () => {
  it("defaults to https://www.beam.be and follows settings.site", async () => {
    expect(await canonicalOrigin(handle.db)).toBe("https://www.beam.be");
    expect(await getPageUrl(handle.db, { pageId }, "nl-BE")).toBe("https://www.beam.be/nl/prijzen");
    await handle.db.insert(settings).values({ key: "site", value: { ...DEFAULT_SITE_SETTINGS, canonical_origin: "https://staging.example.com/" } });
    expect(await canonicalOrigin(handle.db)).toBe("https://staging.example.com");
    expect(await getPageUrl(handle.db, { slug: "pricing" }, "fr-BE")).toBe("https://staging.example.com/fr/tarifs");
  });

  it("returns null for a locale without a route, an unknown slug and an unpublished page", async () => {
    expect(await getPageUrl(handle.db, { pageId }, "en")).toBeNull();
    expect(await getPageUrl(handle.db, { slug: "missing" }, "nl-BE")).toBeNull();
    await handle.db.update(pages).set({ status: "draft" }).where(eq(pages.id, pageId));
    expect(await getPageUrl(handle.db, { pageId }, "nl-BE")).toBeNull();
    await handle.db.update(pages).set({ status: "published" }).where(eq(pages.id, pageId));
  });

  it("joins origin and path with exactly one slash", () => {
    expect(absoluteUrl("https://www.beam.be/", "/nl")).toBe("https://www.beam.be/nl");
    expect(absoluteUrl("https://www.beam.be", "nl/x")).toBe("https://www.beam.be/nl/x");
  });
});

describe("portal and commerce routes", () => {
  it("builds the portal entry points per locale", () => {
    expect(portalUrl("nl-BE", "book_day")).toBe("/nl/account/book?kind=day");
    expect(portalUrl("fr-BE", "book_night")).toBe("/fr/account/book?kind=night");
    expect(portalUrl("en", "home")).toBe("/en/account");
    expect(portalUrl("en", "invoices")).toBe("/en/account/invoices");
    expect(portalUrl("nl-BE", "shop", { ref: "ABCD2345" })).toBe("/nl/account/shop?ref=ABCD2345");
    expect(bookSessionPath("nl-BE", "s1")).toBe("/nl/account/book/s1");
    expect(stableEventPath("fr-BE", "s1")).toBe("/fr/events/s1");
  });

  it("links buying to the guest checkout with sku and the page path, and gifts to /gift", () => {
    expect(checkoutPath("nl-BE", "PKG-5DAY", "/nl/prijzen")).toBe("/nl/checkout?sku=PKG-5DAY&from=%2Fnl%2Fprijzen");
    expect(giftPath("en")).toBe("/en/gift");
  });
});

describe("getEventPageUrl", () => {
  it("returns the event page, falls back to the booking URL, and null for non-events", async () => {
    const origin = await canonicalOrigin(handle.db);
    const event = await makeSession(handle.db, { kind: "event" });
    expect(await getEventPageUrl(handle.db, event.id, "nl-BE")).toBe(`${origin}/nl/account/book/${event.id}`);
    const [p] = await handle.db.insert(pages).values({ kind: "event", slug: "jazz-night", sessionId: event.id }).returning();
    const [v] = await handle.db
      .insert(pageVersions)
      .values({ pageId: p!.id, version: 1, state: "published", publishedAt: new Date(), paths: { "nl-BE": "events/jazz-avond" }, locales: ["nl-BE"] })
      .returning();
    await handle.db.update(pages).set({ status: "published", currentVersionId: v!.id }).where(eq(pages.id, p!.id));
    await handle.db.insert(pageRoutes).values({ pageId: p!.id, locale: "nl-BE", path: "events/jazz-avond", versionId: v!.id });
    expect(await getEventPageUrl(handle.db, event.id, "nl-BE")).toBe(`${origin}/nl/events/jazz-avond`);
    expect(await getEventPageUrl(handle.db, event.id, "fr-BE")).toBe(`${origin}/fr/account/book/${event.id}`);
    const day = await makeSession(handle.db, { kind: "day" });
    expect(await getEventPageUrl(handle.db, day.id, "nl-BE")).toBeNull();
  });
});
