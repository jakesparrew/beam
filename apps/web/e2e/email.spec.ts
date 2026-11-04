import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";

/**
 * email end to end, part 1 (email-P5; runs at the wave checkpoint against beam_dev with the demo
 * seed): marketing staff create a newsletter template, build it in the block editor with a
 * heading and a dynamic block (a member variant and a fallback for everyone else) in Dutch, copy
 * the blocks to French and English, preview it as a lead and as a member, and publish it.
 * email-P6 adds part 2 (campaigns). Selectors use test ids, data attributes and ids, never copy.
 * Templates this spec creates (slug `e2e-newsletter-*`) are removed before and after.
 */
test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
const NAME = `E2E newsletter ${RUN}`;
const MEMBER = `MEMBER-E2E-${RUN}`;
const EVERYONE = `EVERYONE-E2E-${RUN}`;
let templateId = "";

async function resetTemplates(): Promise<void> {
  const owned = sql`select id from email_templates where slug like 'e2e-newsletter-%'`;
  await e2eRows(sql`update email_templates set current_version_id = null where id in (${owned})`);
  await e2eRows(sql`delete from email_messages where template_version_id in (select id from email_template_versions where template_id in (${owned}))`);
  await e2eRows(sql`delete from email_template_versions where template_id in (${owned})`);
  await e2eRows(sql`delete from email_templates where slug like 'e2e-newsletter-%'`);
}

/** Waits for the Server Action POST a click starts (never on a bare alert, CONVENTIONS 11). */
async function clickAndWait(page: Page, click: () => Promise<void>): Promise<void> {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await click();
  await response;
}

test.beforeAll(resetTemplates);
test.afterAll(async () => {
  await resetTemplates();
  await closeE2eDb();
});

test("marketing builds a newsletter with a dynamic block, previews it as lead and member, and publishes it", async ({ page }) => {
  await signInStaff(page, "marketing", { returnTo: "/admin/templates?kind=marketing" });
  await page.goto("/admin/templates?kind=marketing");

  await page.locator("#new-template-name").fill(NAME);
  await page.locator("#new-template-purpose").selectOption("newsletter");
  await page.locator("#new-template-name").press("Enter");
  await page.waitForURL(/\/admin\/templates\/[0-9a-f-]{36}$/);
  templateId = page.url().split("/").pop()!;
  await expect(page.getByTestId("block-editor")).toBeVisible();

  const palette = page.getByTestId("block-palette");
  const inspector = page.getByTestId("block-inspector");

  // Dutch: a heading and a dynamic block with a member variant and a fallback.
  await palette.locator('[data-block-type="heading"]').click();
  await inspector.locator("input").first().fill(`Nieuws ${RUN}`);
  await palette.locator('[data-block-type="dynamic"]').click();
  const dynamic = page.getByTestId("dynamic-editor");
  await expect(dynamic).toBeVisible();
  const inline = dynamic.getByTestId("block-palette-inline");
  await inline.first().locator('[data-block-type="text"]').click();
  await inline.last().locator('[data-block-type="text"]').click();
  const rows = page.locator("button[data-block-id]");
  await expect(rows).toHaveCount(4);
  await rows.nth(2).click();
  await inspector.locator("textarea").fill(`${MEMBER} Hallo {{first_name|lid}}`);
  await rows.nth(3).click();
  await inspector.locator("textarea").fill(EVERYONE);

  for (const locale of ["nl-BE", "fr-BE", "en"] as const) {
    await page.locator(`[data-locale="${locale}"]`).click();
    if (locale !== "nl-BE") await page.getByTestId("copy-from-nl-BE").click();
    await page.locator("#field-subject").fill(`Nieuwsbrief ${locale} ${RUN}`);
    await page.locator("#field-preheader").fill(`Voorkop ${locale}`);
  }
  await clickAndWait(page, () => page.getByTestId("save-draft").click());

  // Preview as member, then as lead (the fallback).
  await page.goto(`/admin/templates/${templateId}/preview?locale=nl-BE&use=draft&as=member`);
  await expect(page.getByTestId("preview-iframe")).toHaveAttribute("srcdoc", new RegExp(MEMBER));
  await expect(page.getByTestId("preview-subject")).toHaveText(`Nieuwsbrief nl-BE ${RUN}`);
  await page.locator('[data-persona="lead"]').click();
  await page.waitForURL(/as=lead/);
  const leadHtml = (await page.getByTestId("preview-iframe").getAttribute("srcdoc")) ?? "";
  expect(leadHtml).toContain(EVERYONE);
  expect(leadHtml).not.toContain(MEMBER);

  // Publish.
  await page.goto(`/admin/templates/${templateId}`);
  await clickAndWait(page, () => page.getByTestId("publish").click());
  await expect
    .poll(async () => {
      const [row] = await e2eRows<{ status: string; locales: string[] | null }>(
        sql`select t.status, v.locales from email_templates t left join email_template_versions v on v.id = t.current_version_id where t.id = ${templateId}`,
      );
      return row ? `${row.status}:${[...(row.locales ?? [])].sort().join(",")}` : "";
    })
    .toBe("published:en,fr-BE,nl-BE");
  const [compiled] = await e2eRows<{ variants: number }>(
    sql`select count(*)::int as variants from email_templates t join email_template_versions v on v.id = t.current_version_id, jsonb_object_keys(v.html_by_locale -> 'nl-BE') where t.id = ${templateId}`,
  );
  expect(compiled!.variants).toBe(2);
});
