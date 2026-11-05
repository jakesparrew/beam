/**
 * webinar-P3 (spec section 12, rules 14 and 19): register on `/nl/webinars/<slug>`, the sink
 * mailbox has the access email, and its personal link opens `/nl/w/<token>`.
 *
 * Release 2: the spec skips itself while `ff_webinar_portal` is off or no published demo webinar
 * offered in Dutch exists (the demo seed's `demo-webinar-on-demand`, or any published one). Each
 * run registers a fresh `@example.com` address and removes its registration before and after.
 * The form's POST response is awaited (never a bare `role="alert"`, CONVENTIONS item 11).
 */
import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { closeE2eDb, e2eRows } from "./support/db";
import { latestEmail } from "./support/sink";

async function flagOn(): Promise<boolean> {
  const rows = await e2eRows<{ state: string }>(sql`select state::text as state from feature_flags where key = 'ff_webinar_portal'`);
  return rows[0]?.state === "on";
}

async function dutchWebinarSlug(): Promise<string | null> {
  const rows = await e2eRows<{ slug: string }>(sql`
    select slug from webinars
    where status = 'published' and 'nl-BE' = any(locales)
      and (mode = 'on_demand' or starts_at > now() + interval '1 hour')
    order by (slug = 'demo-webinar-on-demand') desc, created_at
    limit 1`);
  return rows[0]?.slug ?? null;
}

const removeRegistrations = (email: string) =>
  e2eRows(sql`delete from webinar_registrations where person_id in (select id from persons where lower(email) = ${email.toLowerCase()})`);

test.describe("webinar registration (webinar-P3)", () => {
  const email = `webinar-e2e-${Date.now()}@example.com`;

  test.afterAll(async () => {
    await removeRegistrations(email).catch(() => undefined);
    await closeE2eDb();
  });

  test("register on the landing page, receive the access email, open the personal link", async ({ page }) => {
    test.skip(!(await flagOn()), "ff_webinar_portal is off (Release 2)");
    const slug = await dutchWebinarSlug();
    test.skip(!slug, "no published webinar offered in Dutch");
    await removeRegistrations(email);
    const started = new Date();

    await page.goto(`/nl/webinars/${slug}`);
    await page.getByLabel("E-mailadres").fill(email);
    await page.getByLabel("Voornaam").fill("Eva");
    const posted = page.waitForResponse((r) => r.url().includes(`/api/public/webinars/${slug}/register`) && r.request().method() === "POST");
    await page.getByRole("button", { name: "Inschrijven" }).click();
    expect((await posted).status()).toBe(202);
    await expect(page.getByText("Kijk in je mailbox")).toBeVisible();

    const mail = await latestEmail(email, { after: started });
    expect(mail.subject).toContain("Je bent ingeschreven");
    const link = mail.links.find((l) => /\/nl\/w\/[0-9a-f-]{36}\.\d+\./.test(l));
    expect(link, "the access email carries the personal link").toBeTruthy();

    await page.goto(link!);
    await expect(page).toHaveURL(/\/nl\/w\/[0-9a-f-]{36}\.\d+\.[A-Za-z0-9_-]+$/);
  });
});
