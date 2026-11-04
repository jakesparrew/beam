/**
 * The portal home and the portal chrome (site-P6, rules 35, 47-49) on beam_dev. A seeded customer
 * signs in by magic link (email sink), sees account home with an upcoming booking and a balance,
 * follows "Book a day session" and opens "My details" (crm's profile page). After a material
 * terms version is published, the terms banner shows on another portal page and "Accept" makes it
 * go away. Axe finds no serious or critical violation on account home.
 *
 * The material terms version this spec publishes is removed again (with the acceptance it caused)
 * and the terms page points back at its previous version, before and after the test, so other
 * specs never see the banner.
 */
import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { expectAccessible } from "./support/a11y";
import { signInCustomer } from "./support/auth";
import { closeE2eDb, e2eDb, e2eRows } from "./support/db";

const E2E_TERMS_MARK = "e2e-site-portal-material-terms";

type Candidate = { email: string; person_id: string; session_title: string | null };

/** A customer with a portal user, an upcoming live booking and remaining credits (from the demo seed). */
async function seededCustomer(): Promise<Candidate | null> {
  const [row] = await e2eRows<Candidate>(sql`
    select u.email, p.id as person_id, s.title->>'nl-BE' as session_title
    from users u
    join persons p on p.id = u.person_id
    join bookings b on b.person_id = p.id and b.status = 'confirmed'
    join sessions s on s.id = b.session_id and s.starts_at > now() and s.status <> 'cancelled'
    join v_person_credits c on c.person_id = p.id and c.remaining_units > 0
    where u.audience = 'customer' and p.merged_into_person_id is null and p.erased_at is null
    order by (u.email = 'customer1@example.com') desc, u.email, s.starts_at
    limit 1`);
  return row ?? null;
}

/** Removes the spec's material terms version (and acceptances of it) and restores the live terms version. */
async function removeE2eTerms(): Promise<void> {
  const db = await e2eDb();
  const rowsOf = <T,>(result: unknown): T[] => (result as { rows?: T[] }).rows ?? [];
  await db.transaction(async (tx) => {
    const rows = rowsOf<{ id: string; page_id: string }>(await tx.execute(sql`select id, page_id from page_versions where change_summary = ${E2E_TERMS_MARK}`));
    if (rows.length === 0) return;
    // terms_acceptances is append-only; the documented bypass for cleanup (02-data-model rule 6).
    await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
    for (const v of rows) {
      const [previous] = rowsOf<{ id: string }>(
        await tx.execute(sql`
          select id from page_versions where page_id = ${v.page_id} and state = 'published' and id <> ${v.id}
          and coalesce(change_summary, '') <> ${E2E_TERMS_MARK} order by published_at desc limit 1`),
      );
      if (previous) {
        await tx.execute(sql`update pages set current_version_id = ${previous.id} where id = ${v.page_id}`);
        await tx.execute(sql`update page_routes set version_id = ${previous.id} where page_id = ${v.page_id}`);
      }
      await tx.execute(sql`delete from terms_acceptances where page_version_id = ${v.id}`);
      await tx.execute(sql`delete from page_versions where id = ${v.id}`);
    }
  });
}

/** Publishes a copy of the live terms version as a material change; null when no terms are live. */
async function publishMaterialTerms(): Promise<string | null> {
  const [live] = await e2eRows<{ page_id: string; version_id: string }>(sql`
    select p.id as page_id, p.current_version_id as version_id from pages p
    where p.legal_key = 'terms' and p.status = 'published' and p.current_version_id is not null limit 1`);
  if (!live) return null;
  const [created] = await e2eRows<{ id: string }>(sql`
    insert into page_versions (page_id, version, state, published_at, title, paths, blocks, seo, locales, is_material_change, change_summary)
    select page_id, (select max(version) + 1 from page_versions where page_id = ${live.page_id}), 'published', now(), title, paths, blocks, seo, locales, true, ${E2E_TERMS_MARK}
    from page_versions where id = ${live.version_id}
    returning id`);
  await e2eRows(sql`update pages set current_version_id = ${created!.id} where id = ${live.page_id}`);
  await e2eRows(sql`update page_routes set version_id = ${created!.id} where page_id = ${live.page_id}`);
  return created!.id;
}

test.beforeAll(async () => {
  await removeE2eTerms();
});

test.afterAll(async () => {
  await removeE2eTerms();
  await closeE2eDb();
});

test.describe("portal home and chrome", () => {
  test("customer signs in, sees the home cards and follows the quick actions", async ({ page }) => {
    const customer = await seededCustomer();
    test.skip(!customer, "the demo seed has no customer with a portal user, an upcoming booking and credits");
    await signInCustomer(page, customer!.email, "nl");
    await page.goto("/nl/account");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const bookingsCard = page.locator('[data-home-card="bookings"]');
    await expect(bookingsCard.locator("[data-booking-id]").first()).toBeVisible();
    if (customer!.session_title) await expect(bookingsCard).toContainText(customer!.session_title);
    await expect(page.locator('[data-home-card="balance"] [data-credit-kind]').first()).toBeVisible();
    await expect(page.locator("[data-card-unavailable]")).toHaveCount(0);
    await expect(page.locator("[data-cookie-settings]")).toBeVisible();
    await expectAccessible(page);

    await page.locator('[data-quick-action="bookDay"]').click();
    await page.waitForURL((u) => u.pathname === "/nl/account/book" && u.searchParams.get("kind") === "day");

    await page.goto("/nl/account");
    await page.locator('[data-quick-action="profile"]').click();
    await page.waitForURL(/\/nl\/account\/profile$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("the terms banner shows on another portal page after a material terms publish and goes away on Accept", async ({ page }) => {
    const customer = await seededCustomer();
    test.skip(!customer, "the demo seed has no customer with a portal user, an upcoming booking and credits");
    await signInCustomer(page, customer!.email, "nl");
    try {
      const versionId = await publishMaterialTerms();
      test.skip(!versionId, "no live terms page in the demo seed");
      await page.goto("/nl/account/preferences");
      const banner = page.locator("[data-terms-banner]");
      await expect(banner).toBeVisible();
      await expect(banner).toHaveAttribute("data-version-id", versionId!);
      const accepted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/nl/account/preferences");
      await banner.getByRole("button").click();
      await accepted;
      await expect(banner).toHaveCount(0);
      const [row] = await e2eRows<{ n: number | string }>(sql`
        select count(*) as n from terms_acceptances where person_id = ${customer!.person_id} and page_version_id = ${versionId!} and context = 'portal_prompt'`);
      expect(Number(row?.n ?? 0)).toBe(1);
      await page.reload();
      await expect(page.locator("[data-terms-banner]")).toHaveCount(0);
    } finally {
      await removeE2eTerms();
    }
  });
});
