/**
 * Claude-assisted editing on beam_dev with fake Claude (site-P4, site spec section 12): the
 * marketing user asks Claude for an FAQ on a published page, waits for the proposal, sees the
 * inserted block highlighted on the review screen, publishes it, and the public page shows the FAQ.
 * The fake's default `site.propose_page` answer keeps the base content and appends an FAQ block per
 * target locale. The page (slug prefix `e2e-claude-`), its versions, routes and edit requests are
 * removed before and after the test.
 */
import { randomUUID } from "node:crypto";
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
  (l) => (JSON.parse(readFileSync(path.join(here, `../../../packages/core/src/i18n/messages/${l}/site.json`), "utf8")) as { site: { admin: Tree } }).site.admin,
);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A regex matching the `site.admin.<key>` label in any of the three locales. */
function label(key: string): RegExp {
  const values = catalogues.map((c) => key.split(".").reduce<string | Tree | undefined>((n, k) => (n && typeof n === "object" ? n[k] : undefined), c)).filter((v): v is string => typeof v === "string");
  return new RegExp(`^(${values.map(escapeRe).join("|")})$`);
}

const SLUG_PREFIX = "e2e-claude-";
const LOCALES = ["nl-BE", "fr-BE", "en"] as const;

async function cleanup(): Promise<void> {
  const db = await e2eDb();
  const mine = sql`(select id from pages where slug like ${`${SLUG_PREFIX}%`})`;
  await db.execute(sql`delete from redirects where to_page_id in ${mine}`);
  await db.execute(sql`delete from page_routes where page_id in ${mine}`);
  await db.execute(sql`update pages set current_version_id = null, status = 'draft' where slug like ${`${SLUG_PREFIX}%`}`);
  await db.execute(sql`update page_edit_requests set result_version_id = null, base_version_id = null where page_id in ${mine}`);
  await db.execute(sql`update page_versions set based_on_version_id = null, edit_request_id = null where page_id in ${mine}`);
  await db.execute(sql`delete from page_versions where page_id in ${mine}`);
  await db.execute(sql`delete from page_edit_requests where page_id in ${mine}`);
  await db.execute(sql`delete from pages where slug like ${`${SLUG_PREFIX}%`}`);
}

/** A published standard page in three locales with one text block per locale. */
async function publishedPage(tag: string): Promise<{ pageId: string; paths: Record<(typeof LOCALES)[number], string> }> {
  const db = await e2eDb();
  const slug = `${SLUG_PREFIX}${tag}`;
  const paths = { "nl-BE": `e2e-claude-${tag}`, "fr-BE": `e2e-claude-fr-${tag}`, en: `e2e-claude-en-${tag}` };
  const title = { "nl-BE": `E2E Over BEAM ${tag}`, "fr-BE": `E2E À propos ${tag}`, en: `E2E About BEAM ${tag}` };
  const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const blocks = Object.fromEntries(LOCALES.map((l) => [l, [{ id: randomUUID(), type: "rich_text", doc: doc(`Welkom bij BEAM (${l}).`) }]]));
  const seo = Object.fromEntries(LOCALES.map((l) => [l, { title: `${title[l]} | BEAM`, description: `${title[l]}: sauna, pools and quiet rooms at BEAM Vitality Center in Belgium.` }]));
  const [page] = await e2eRows<{ id: string }>(sql`insert into pages (kind, slug) values ('standard', ${slug}) returning id`);
  const [version] = await e2eRows<{ id: string }>(sql`
    insert into page_versions (page_id, version, state, title, paths, blocks, seo, locales, published_at)
    values (${page!.id}, 1, 'published', ${JSON.stringify(title)}::jsonb, ${JSON.stringify(paths)}::jsonb, ${JSON.stringify(blocks)}::jsonb, ${JSON.stringify(seo)}::jsonb, '{nl-BE,fr-BE,en}', now())
    returning id`);
  await db.execute(sql`update pages set status = 'published', current_version_id = ${version!.id}, first_published_at = now() where id = ${page!.id}`);
  for (const l of LOCALES) await db.execute(sql`insert into page_routes (page_id, locale, path, version_id) values (${page!.id}, ${l}, ${paths[l]}, ${version!.id})`);
  return { pageId: page!.id, paths };
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

test("marketing asks Claude for an FAQ, reviews the diff and publishes it", async ({ page }) => {
  test.setTimeout(180_000);
  const tag = Math.random().toString(36).slice(2, 8);
  const { pageId, paths } = await publishedPage(tag);

  await signInStaff(page, "marketing", { returnTo: `/admin/site/pages/${pageId}` });
  await page.goto(`/admin/site/pages/${pageId}`);
  const panel = page.getByTestId("claude-panel");
  await expect(panel).toBeVisible();
  await panel.locator("#claude-instruction").fill("Add an FAQ about the opening hours at the end of the page.");
  await clickAction(page, label("claude.ask"));

  // The job runs right after the request commits; the panel polls every 2 s.
  const ready = panel.getByRole("link", { name: label("claude.ready") });
  await expect(ready).toBeVisible({ timeout: 90_000 });
  const [request] = await e2eRows<{ status: string; result_version_id: string }>(sql`select status, result_version_id from page_edit_requests where page_id = ${pageId} order by created_at desc limit 1`);
  expect(request).toMatchObject({ status: "succeeded" });
  await ready.click();
  await page.waitForURL(new RegExp(`/admin/site/pages/${pageId}/versions/${request!.result_version_id}$`));

  // The inserted FAQ block is highlighted; the kept text block is unchanged.
  await page.getByRole("button", { name: /^nl-BE/ }).click();
  const inserted = page.getByTestId("block-inserted");
  await expect(inserted.first()).toBeVisible();
  await expect(inserted.first().getByText(label("block.faq.name"))).toBeVisible();
  await expect(page.getByTestId("block-unchanged").first()).toBeVisible();

  // Publish the proposal and open the public page.
  await clickAction(page, label("diff.publish"));
  await expect.poll(async () => (await e2eRows<{ current_version_id: string }>(sql`select current_version_id from pages where id = ${pageId}`))[0]?.current_version_id).toBe(request!.result_version_id);
  const [live] = await e2eRows<{ blocks: Record<string, { type: string; items?: { question: string }[] }[]> }>(sql`select blocks from page_versions where id = ${request!.result_version_id}`);
  const faq = live!.blocks["nl-BE"]!.find((b) => b.type === "faq");
  expect(faq?.items?.length).toBeGreaterThan(0);
  const res = await page.goto(`/nl/${paths["nl-BE"]}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByText(faq!.items![0]!.question).first()).toBeVisible();
});
