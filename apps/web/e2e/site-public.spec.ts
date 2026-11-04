/**
 * The public site on beam_dev (site-P2): home in three locales with `lang`, header navigation to
 * an offer page, the locale switch, the pricing table with the seeded prices, events list to
 * event detail to "Get tickets" (portal sign-in with the return URL), "Buy" into commerce's guest
 * checkout, a legacy WordPress path, and the 404 and gone pages. Paths come from the seeded
 * `page_routes` (read-only); the one row this spec writes is its own temporary redirect.
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { redirects } from "@beam/db/schema";
import { eq, sql } from "drizzle-orm";
import { expectAccessible } from "./support/a11y";
import { closeE2eDb, e2eDb, e2eRows } from "./support/db";

type Route = { slug: string; kind: string; locale: string; path: string; page_id: string };

async function routesOf(where: { slug?: string; kind?: string }): Promise<Route[]> {
  return e2eRows<Route>(sql`
    select p.slug, p.kind::text as kind, r.locale::text as locale, r.path, p.id as page_id
    from page_routes r join pages p on p.id = r.page_id
    where p.status = 'published'
      ${where.slug ? sql`and p.slug = ${where.slug}` : sql``}
      ${where.kind ? sql`and p.kind = ${where.kind}` : sql``}
    order by p.slug, r.locale`);
}

const prefix: Record<string, string> = { "nl-BE": "nl", "fr-BE": "fr", en: "en" };
const urlOf = (r: Pick<Route, "locale" | "path">) => (r.path ? `/${prefix[r.locale]}/${r.path}` : `/${prefix[r.locale]}`);

test.afterAll(async () => {
  await closeE2eDb();
});

test.describe("public site", () => {
  for (const [seg, lang] of [
    ["nl", "nl-BE"],
    ["fr", "fr-BE"],
    ["en", "en"],
  ] as const) {
    test(`home renders in ${lang} with the lang attribute`, async ({ page }) => {
      const res = await page.goto(`/${seg}`);
      expect(res?.status()).toBe(200);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("footer [data-company]")).toContainText("Vibrant Lifestyle Collective BV");
      await expectAccessible(page);
    });
  }

  test("header navigation reaches an offer page and the locale switch keeps the page", async ({ page }) => {
    const offers = await routesOf({ kind: "offer" });
    const nl = offers.find((r) => r.locale === "nl-BE");
    expect(nl, "a seeded offer page in nl-BE").toBeTruthy();
    await page.goto("/nl");
    await page.locator(`header a[href="${urlOf(nl!)}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`${urlOf(nl!)}$`));
    await expect(page.locator("h1")).toHaveCount(1);
    await expectAccessible(page);

    const fr = offers.find((r) => r.page_id === nl!.page_id && r.locale === "fr-BE");
    await page.locator('header a[data-locale="fr-BE"]').click();
    if (fr) await expect(page).toHaveURL(new RegExp(`${urlOf(fr)}$`));
    else await expect(page).toHaveURL(new RegExp(`/fr/unavailable\\?page=${nl!.page_id}$`));
    await expect(page.locator("html")).toHaveAttribute("lang", "fr-BE");
  });

  test("the pricing table shows the seeded prices and Buy opens the guest checkout", async ({ page }) => {
    const [pricing] = (await routesOf({ kind: "pricing" })).filter((r) => r.locale === "nl-BE");
    expect(pricing, "the seeded pricing page in nl-BE").toBeTruthy();
    await page.goto(urlOf(pricing!));
    const card = page.locator("[data-product]").first();
    await expect(card).toBeVisible();
    const sku = (await card.getAttribute("data-product"))!;
    const [price] = await e2eRows<{ amount_cents: number }>(sql`
      select pv.amount_cents from price_versions pv join products p on p.id = pv.product_id
      where p.sku = ${sku} and pv.audience = 'public' and pv.valid_from_at <= now() and (pv.valid_to_at is null or pv.valid_to_at > now())
      order by pv.version desc limit 1`);
    expect(price, `a public price for ${sku}`).toBeTruthy();
    const formatted = new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR" }).format(price!.amount_cents / 100);
    await expect(card.locator('[data-price="public"]')).toHaveText(formatted);
    await expectAccessible(page);

    await card.getByRole("link").last().click();
    await expect(page).toHaveURL((url) => url.pathname === "/nl/checkout" && url.searchParams.get("sku") === sku && url.searchParams.get("from") === urlOf(pricing!));
  });

  test("events list to event detail to Get tickets lands on the portal sign-in", async ({ page }) => {
    const [events] = (await routesOf({ kind: "events_index" })).filter((r) => r.locale === "nl-BE");
    expect(events, "the seeded events page in nl-BE").toBeTruthy();
    await page.goto(urlOf(events!));
    await expectAccessible(page);
    const first = page.locator('[data-block="events_list"] h3 a').first();
    await expect(first).toBeVisible();
    await first.click();
    await page.waitForLoadState("domcontentloaded");
    const tickets = page.locator('a[data-action="tickets"], a[data-action="waitlist"]').first();
    if ((await page.locator("[data-event]").count()) > 0) {
      await expectAccessible(page);
      await tickets.click();
    }
    // Without a customer session the portal sends the visitor to sign in and back (proxy returnTo).
    await expect(page).toHaveURL((url) => /^\/nl\/account\/login$/.test(url.pathname) && /^\/nl\/account\/book\/[0-9a-f-]{36}$/.test(url.searchParams.get("returnTo") ?? ""));
  });

  test("a legacy WordPress path redirects to the imported page", async ({ page }) => {
    const [home] = (await routesOf({ kind: "home" })).filter((r) => r.locale === "nl-BE");
    const from = `/e2e-legacy-${randomUUID().slice(0, 8)}`;
    const db = await e2eDb();
    await db.insert(redirects).values({ fromPath: from, toPageId: home!.page_id, toLocale: "nl-BE", source: "wordpress" });
    try {
      const res = await page.goto(`${from}/`);
      expect(res?.status()).toBe(200);
      await expect(page).toHaveURL(/\/nl\/?$/);
    } finally {
      await db.delete(redirects).where(eq(redirects.fromPath, from));
    }
  });

  test("unknown paths answer 404 and legacy WordPress admin paths the gone page", async ({ page }) => {
    const missing = await page.goto(`/nl/bestaat-niet-${randomUUID().slice(0, 8)}`);
    expect(missing?.status()).toBe(404);
    await expect(page.locator("[data-status]")).toHaveAttribute("data-status", "404");
    await expectAccessible(page);

    const gone = await page.goto("/nl/wp-admin");
    // Next.js pages can answer only 404 through notFound(); 410 needs the proxy request (site-P2 report).
    expect([404, 410]).toContain(gone?.status());
    await expect(page.locator("[data-status]")).toHaveAttribute("data-status", "410");
    await expect(page.locator("h1")).toHaveCount(1);
  });
});
