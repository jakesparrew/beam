/**
 * The accessibility gate of the public site (site-P5, rule 50, PL-90): axe with `wcag2a`,
 * `wcag2aa` and `wcag21aa` finds no serious or critical violation on home, offer, pricing,
 * events, event detail, contact, legal and 404 (with the cookie banner showing, as a first
 * visitor sees them), and a keyboard-only visitor can use the skip link, the mobile menu, the
 * cookie banner and the focus-trapped settings dialog. Paths come from the seeded `page_routes`.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { expectAccessible } from "./support/a11y";
import { closeE2eDb, e2eRows } from "./support/db";

type Route = { kind: string; path: string };

async function nlPath(kind: string): Promise<string | null> {
  const [row] = await e2eRows<Route>(sql`
    select p.kind::text as kind, r.path from page_routes r join pages p on p.id = r.page_id
    where p.status = 'published' and r.locale = 'nl-BE' and p.kind = ${kind}
    order by p.slug limit 1`);
  if (!row) return null;
  return row.path ? `/nl/${row.path}` : "/nl";
}

test.afterAll(async () => {
  await closeE2eDb();
});

/** Presses Tab until `predicate` holds for the focused element (at most `max` presses). */
async function tabUntil(page: Page, predicate: string, max = 60): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    // `predicate` is a selector the focused element must match.
    if (await page.evaluate((sel) => !!document.activeElement?.matches(sel), predicate)) return true;
  }
  return false;
}

test.describe("accessibility of the public site", () => {
  for (const kind of ["home", "offer", "pricing", "events_index", "event", "contact", "legal"]) {
    test(`${kind} has no serious or critical axe violation`, async ({ page }) => {
      const path = await nlPath(kind);
      test.skip(!path, `no seeded ${kind} page in nl-BE`);
      const res = await page.goto(path!);
      expect(res?.status()).toBe(200);
      await expect(page.locator("[data-cookie-banner]")).toBeVisible();
      await expectAccessible(page);
    });
  }

  test("the 404 page has no serious or critical axe violation", async ({ page }) => {
    const res = await page.goto(`/nl/bestaat-niet-${randomUUID().slice(0, 8)}`);
    expect(res?.status()).toBe(404);
    await expectAccessible(page);
  });
});

test.describe("keyboard only", () => {
  test("skip link, mobile menu, cookie banner and settings dialog work with the keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/nl");

    // The first Tab reaches the skip link, which moves focus to the main landmark.
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveAttribute("href", "#main-content");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main-content$/);

    // The mobile menu opens with Enter and closes with Escape, returning focus to its button.
    await page.goto("/nl");
    if (await page.locator("header button[aria-expanded]").count()) {
      expect(await tabUntil(page, "header button[aria-expanded]")).toBe(true);
      await page.keyboard.press("Enter");
      await expect(page.locator("header button[aria-expanded]")).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(page.locator("header button[aria-expanded]")).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator("header button[aria-expanded]")).toBeFocused();
    }

    // The banner's "Choose" opens the modal dialog; focus stays inside until Escape.
    expect(await tabUntil(page, '[data-cookie-banner] [data-consent="choose"]', 120)).toBe(true);
    await page.keyboard.press("Enter");
    const dialog = page.locator("dialog[data-cookie-dialog]");
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => !!document.activeElement?.closest("dialog[data-cookie-dialog]") || document.activeElement === document.body);
      expect(inside).toBe(true);
    }
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // "Reject all" by keyboard records the choice and removes the banner.
    expect(await tabUntil(page, '[data-cookie-banner] [data-consent="reject_all"]', 120)).toBe(true);
    const posted = page.waitForResponse((res) => res.url().endsWith("/api/public/cookie-consent") && res.request().method() === "POST");
    await page.keyboard.press("Enter");
    expect((await posted).status()).toBe(200);
    await expect(page.locator("[data-cookie-banner]")).toHaveCount(0);
  });
});
