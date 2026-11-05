/**
 * site-P9 landing insights (site spec section 5, 12): rows per landing path and UTM campaign
 * merge forms' conversions and commerce's orders (both mocked to their R3 contracts), paths match
 * the live page that holds them, totals match the fixtures, the period is in Brussels days, and
 * the read needs `reports.read` and `site.edit`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { pageRoutes, pages, pageVersions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import type { Actor } from "@/lib/ctx";
import { staffActor } from "@/lib/testing";

vi.mock("@/modules/forms/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), countLandingConversions: vi.fn() }));
vi.mock("@/modules/commerce/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), countOrdersByLanding: vi.fn() }));

const forms = await import("@/modules/forms/api");
const commerce = await import("@/modules/commerce/api");
const { getLandingInsights, getLandingInsightsFor, insightsCsv, insightsPeriod, normaliseLandingPath } = await import("./insights");

let h: DbHandle;
let landingId: string;
beforeAll(async () => {
  h = await createTestDb();
  const [page] = await h.db.insert(pages).values({ kind: "landing", slug: "lente-actie", status: "draft" }).returning({ id: pages.id });
  landingId = page!.id;
  const [v] = await h.db
    .insert(pageVersions)
    .values({ pageId: landingId, version: 1, state: "published", publishedAt: new Date(), title: { "nl-BE": "Lente-actie", en: "Spring offer" }, paths: { "nl-BE": "actie/lente" }, locales: ["nl-BE"] })
    .returning({ id: pageVersions.id });
  await h.db.update(pages).set({ status: "published", currentVersionId: v!.id }).where((await import("@/lib/ctx")).eq(pages.id, landingId));
  await h.db.insert(pageRoutes).values({ pageId: landingId, locale: "nl-BE", path: "actie/lente", versionId: v!.id });
});
afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  vi.mocked(forms.countLandingConversions).mockResolvedValue([
    { landingPath: "/nl/actie/lente", utmCampaign: "spring", submissions: 5, newPersons: 3 },
    { landingPath: "/nl/actie/lente", utmCampaign: null, submissions: 2, newPersons: 1 },
    { landingPath: "/fr/inconnu", utmCampaign: "printemps", submissions: 1, newPersons: 0 },
  ]);
  vi.mocked(commerce.countOrdersByLanding).mockResolvedValue([
    { landingPath: "/nl/actie/lente/", utmCampaign: "Spring", orders: 2, revenueCents: 9000 },
    { landingPath: null, utmCampaign: null, orders: 4, revenueCents: 12000 },
    { landingPath: "/en/gift", utmCampaign: "xmas", orders: 1, revenueCents: 5000 },
  ]);
});

const staff = (permissions: string[]): Actor => staffActor({ roleKey: "marketing", permissions });

describe("getLandingInsights", () => {
  it("merges conversions and orders per landing path and campaign, and totals match the fixtures", async () => {
    const from = new Date("2026-10-01T00:00:00+02:00");
    const to = new Date("2026-11-01T00:00:00+01:00");
    const data = await getLandingInsights({ from, to }, h.db);
    expect(forms.countLandingConversions).toHaveBeenCalledWith(h.db, { from, to });
    expect(commerce.countOrdersByLanding).toHaveBeenCalledWith(h.db, { from, to });
    expect(data.totals).toEqual({ submissions: 8, newPersons: 4, orders: 7, revenueCents: 26000 });
    const spring = data.rows.find((r) => r.landingPath === "/nl/actie/lente" && r.utmCampaign === "spring")!;
    expect(spring).toMatchObject({ submissions: 5, newPersons: 3, orders: 2, revenueCents: 9000 });
    expect(spring.page).toEqual({ pageId: landingId, kind: "landing", slug: "lente-actie", title: "Lente-actie" });
    expect(data.rows.find((r) => r.landingPath === "/nl/actie/lente" && r.utmCampaign === null)).toMatchObject({ submissions: 2, orders: 0 });
    expect(data.rows.find((r) => r.landingPath === "/fr/inconnu")!.page).toBeNull();
    expect(data.rows.find((r) => r.landingPath === null)).toMatchObject({ orders: 4, revenueCents: 12000, page: null });
    expect(data.rows).toHaveLength(5);
    // Largest revenue first.
    expect(data.rows.map((r) => r.revenueCents)).toEqual([...data.rows.map((r) => r.revenueCents)].sort((a, b) => b - a));
    expect(data.fromDay).toBe("2026-10-01");
    expect(data.toDay).toBe("2026-10-31");
  });

  it("an empty period has no rows and zero totals", async () => {
    vi.mocked(forms.countLandingConversions).mockResolvedValue([]);
    vi.mocked(commerce.countOrdersByLanding).mockResolvedValue([]);
    const data = await getLandingInsights({ from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-01-02T00:00:00Z") }, h.db);
    expect(data.rows).toEqual([]);
    expect(data.totals).toEqual({ submissions: 0, newPersons: 0, orders: 0, revenueCents: 0 });
  });
});

describe("permission", () => {
  it("requires reports.read (and site.edit)", async () => {
    await expect(getLandingInsightsFor(staff(["site.edit"]), {}, { db: h.db })).rejects.toThrow(/forbidden/);
    await expect(getLandingInsightsFor(staff(["reports.read"]), {}, { db: h.db })).rejects.toThrow(/forbidden/);
    const data = await getLandingInsightsFor(staff(["reports.read", "site.edit"]), { from: "2026-10-01", to: "2026-10-31" }, { db: h.db });
    expect(data.totals.submissions).toBe(8);
  });
});

describe("period and paths", () => {
  it("reads Brussels days inclusive, across the DST change", () => {
    const p = insightsPeriod({ from: "2026-10-01", to: "2026-10-31" });
    expect(p.from.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });

  it("defaults to the last 30 days, swaps a reversed range and caps it at 366 days", () => {
    const now = new Date("2026-11-05T23:30:00Z"); // 00:30 on 6 November in Brussels
    expect(insightsPeriod({}, now)).toMatchObject({ fromDay: "2026-10-08", toDay: "2026-11-06" });
    expect(insightsPeriod({ from: "2026-10-31", to: "2026-10-01" }, now)).toMatchObject({ fromDay: "2026-10-01", toDay: "2026-10-31" });
    expect(insightsPeriod({ from: "2020-01-01", to: "2026-10-31" }, now).fromDay).toBe("2025-10-31");
    expect(insightsPeriod({ from: "2026-02-30", to: "nope" }, now)).toMatchObject({ toDay: "2026-11-06", fromDay: "2026-10-08" });
  });

  it("normalises landing paths", () => {
    expect(normaliseLandingPath("/NL/Actie/Lente/?utm_source=x")).toBe("/nl/actie/lente");
    expect(normaliseLandingPath("https://www.beam.be/nl/actie#form")).toBe("/nl/actie");
    expect(normaliseLandingPath("")).toBeNull();
    expect(normaliseLandingPath(null)).toBeNull();
  });

  it("exports CSV with escaped cells and euro amounts", async () => {
    const data = await getLandingInsights({ from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") }, h.db);
    const csv = insightsCsv(data, { landingPath: "Path", page: "Page", campaign: "Campaign", submissions: "Submissions", newPersons: "New", orders: "Orders", revenue: "Revenue" });
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("Path;Page;Campaign;Submissions;New;Orders;Revenue");
    expect(lines).toContain("/nl/actie/lente;Lente-actie;spring;5;3;2;90,00");
    expect(lines).toHaveLength(6);
  });
});
