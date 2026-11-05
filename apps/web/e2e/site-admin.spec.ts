/**
 * The website back-office on beam_dev (site-P3, site spec section 12): the marketing user signs in
 * with TOTP, creates an offer page in three locales, sees the completeness issues, uploads an
 * image with alt text, fills the page and publishes it, opens it on the public site, renames the
 * Dutch path and the old path redirects to the new one. The rows it creates (pages with the slug
 * prefix `e2e-offer-`, their versions, routes and redirects, and the uploaded image) are removed
 * before and after the test.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { signInStaff } from "./support/auth";
import { closeE2eDb, e2eDb, e2eRows } from "./support/db";

const here = path.dirname(fileURLToPath(import.meta.url));
type Tree = { [k: string]: string | Tree };
const catalogues: Tree[] = (["nl-BE", "fr-BE", "en"] as const).map(
  (l) => ((JSON.parse(readFileSync(path.join(here, `../../../packages/core/src/i18n/messages/${l}/site.json`), "utf8")) as { site: { admin: Tree } }).site.admin),
);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A regex matching the `site.admin.<key>` label in any of the three locales. */
function label(key: string): RegExp {
  const values = catalogues.map((c) => key.split(".").reduce<string | Tree | undefined>((n, k) => (n && typeof n === "object" ? n[k] : undefined), c)).filter((v): v is string => typeof v === "string");
  return new RegExp(`^(${values.map(escapeRe).join("|")})$`);
}

const SLUG_PREFIX = "e2e-offer-";
const ALT = "E2E saunatuin";
/** A 1x1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function cleanup(): Promise<void> {
  const db = await e2eDb();
  await db.execute(sql`delete from redirects where to_page_id in (select id from pages where slug like ${`${SLUG_PREFIX}%`}) or from_path like '/nl/e2e-zomeractie-%'`);
  await db.execute(sql`delete from page_routes where page_id in (select id from pages where slug like ${`${SLUG_PREFIX}%`})`);
  await db.execute(sql`update pages set current_version_id = null, status = 'draft' where slug like ${`${SLUG_PREFIX}%`}`);
  await db.execute(sql`delete from page_versions where page_id in (select id from pages where slug like ${`${SLUG_PREFIX}%`})`);
  await db.execute(sql`delete from pages where slug like ${`${SLUG_PREFIX}%`}`);
  const media = await e2eRows<{ id: string; file_id: string }>(sql`select id, file_id from media_assets where alt->>'en' = ${ALT}`);
  for (const m of media) {
    await db.execute(sql`delete from media_assets where id = ${m.id}`);
    await db.execute(sql`delete from files where id = ${m.file_id}`);
  }
}

/** Clicks a button whose server action is awaited, and waits for the action's POST. */
async function clickAction(page: Page, name: RegExp): Promise<void> {
  const done = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/admin/site"));
  await page.getByRole("button", { name }).first().click();
  await done;
}

test.beforeAll(cleanup);
test.afterAll(async () => {
  await cleanup();
  await closeE2eDb();
});

test("marketing creates, publishes and renames an offer page", async ({ page }) => {
  test.setTimeout(180_000);
  const tag = Math.random().toString(36).slice(2, 8);
  const slug = `${SLUG_PREFIX}${tag}`;
  const titles = { "nl-BE": `E2E Zomeractie ${tag}`, "fr-BE": `E2E Action été ${tag}`, en: `E2E Summer offer ${tag}` };

  await signInStaff(page, "marketing", { returnTo: "/admin/site/media" });

  // Upload an image with alt text in the three locales.
  await page.goto("/admin/site/media");
  for (const l of ["nl-BE", "fr-BE", "en"]) await page.locator(`#upload-alt-${l}`).fill(ALT);
  const uploaded = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/admin/site/media"));
  await page.getByTestId("media-file").setInputFiles({ name: "e2e-sauna.png", mimeType: "image/png", buffer: PNG });
  await uploaded;
  await expect(page.locator(`img[alt="${ALT}"]`).first()).toBeVisible();

  // Create the offer page in three locales.
  await page.goto("/admin/site/pages/new");
  await page.locator("#new-kind").selectOption("offer");
  await page.locator("#new-slug").fill(slug);
  for (const [l, t] of Object.entries(titles)) await page.locator(`#new-title-${l}`).fill(t);
  await page.getByRole("button", { name: label("newPage.create") }).click();
  await page.waitForURL(/\/admin\/site\/pages\/[0-9a-f-]{36}$/);

  // A new page is incomplete: the issue list names what is missing before publishing.
  await expect(page.getByRole("heading", { name: label("editor.issues") })).toBeVisible();
  // Each issue line names its locale first ("nl-BE: Add at least one block.").
  const blocksEmpty = new RegExp(`^nl-BE: ${label("issue.blocks_empty").source.slice(1)}`);
  await expect(page.getByText(blocksEmpty).first()).toBeVisible();

  // Fill every locale: a hero, an image with the uploaded media, and the SEO texts.
  for (const l of ["nl-BE", "fr-BE", "en"] as const) {
    await page.getByRole("tab", { name: new RegExp(`^${escapeRe(l)}`) }).click();
    await page.getByRole("tab", { name: label("editor.tabContent") }).click();
    await page.getByLabel(label("editor.addBlock")).selectOption("hero");
    await page.getByRole("button", { name: label("editor.addBlock") }).click();
    await page.getByLabel(label("block.hero.heading")).last().fill(titles[l]);
    await page.getByLabel(label("editor.addBlock")).selectOption("image");
    await page.getByRole("button", { name: label("editor.addBlock") }).click();
    const imageSelect = page.getByLabel(label("block.image.mediaId")).last();
    const option = imageSelect.locator("option", { hasText: ALT }).first();
    await imageSelect.selectOption((await option.getAttribute("value")));
    await page.getByRole("tab", { name: label("editor.tabSeo") }).click();
    await page.getByLabel(label("editor.seoTitle")).fill(`${titles[l]} | BEAM`);
    await page.getByLabel(label("editor.seoDescription")).fill(`${titles[l]}: a summer offer at BEAM Vitality Center with sauna, pools and quiet rooms.`);
  }
  await clickAction(page, label("editor.save"));
  await expect(page.getByRole("heading", { name: label("editor.noIssues") })).toBeVisible();

  // Publish and open it on the public site.
  await clickAction(page, label("editor.publishNow"));
  await expect(page.getByText(label("status.published")).first()).toBeVisible();
  const [route] = await e2eRows<{ path: string }>(sql`select r.path from page_routes r join pages p on p.id = r.page_id where p.slug = ${slug} and r.locale = 'nl-BE'`);
  expect(route).toBeTruthy();
  const oldPath = `/nl/${route!.path}`;
  const res = await page.goto(oldPath);
  expect(res?.status()).toBe(200);
  await expect(page.locator("h1")).toHaveText(titles["nl-BE"]);

  // Rename the Dutch path: the old path redirects to the new one.
  await page.goBack();
  await page.getByRole("tab", { name: /^nl-BE/ }).click();
  await page.getByRole("tab", { name: label("editor.tabContent") }).click();
  const newPath = `${route!.path}-nieuw`;
  await page.getByLabel(label("editor.path")).fill(newPath);
  await clickAction(page, label("editor.publishNow"));
  await expect.poll(async () => (await e2eRows<{ path: string }>(sql`select r.path from page_routes r join pages p on p.id = r.page_id where p.slug = ${slug} and r.locale = 'nl-BE'`))[0]?.path).toBe(newPath);
  // Publish revalidates with `revalidateTag(tag, "max")` (site rule 19): the old path was rendered
  // above, so the first request after the rename may still get that stale copy while the page
  // regenerates in the background; the next ones redirect.
  await expect
    .poll(
      async () => {
        const moved = await page.goto(oldPath);
        return moved?.status() === 200 ? new URL(page.url()).pathname : `status ${moved?.status()}`;
      },
      { timeout: 30_000 },
    )
    .toBe(`/nl/${newPath}`);
  await expect(page.locator("h1")).toHaveText(titles["nl-BE"]);
});
