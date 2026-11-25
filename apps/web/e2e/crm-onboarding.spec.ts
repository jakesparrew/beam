import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { expectAccessible } from "./support/a11y";
import { signInCustomer } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";
import { distinctEmail } from "./support/ids";

/**
 * Portal onboarding at first sign-in (owner requirements item 10): the home opens it once, one
 * question per screen with Enter to continue, Skip and Later; a VAT number makes a corporate
 * client; the home shows "Complete your profile (2 of 4)" until hidden. A fresh customer per run.
 */
const EMAIL = distinctEmail("onboarding");
const VAT = `BE0${String(Date.now() % 1e9).padStart(9, "0")}`;

test.afterAll(async () => {
  await e2eRows(sql`delete from company_contacts where company_id in (select id from companies where vat_number = ${VAT})`);
  await e2eRows(sql`delete from companies where vat_number = ${VAT}`);
  await closeE2eDb();
});

test("first sign-in opens the onboarding; answers save per screen; the home card shows until hidden", async ({ page }) => {
  await signInCustomer(page, EMAIL, "en");
  // signInCustomer marks the onboarding as seen for every other spec: reset it to a first sign-in.
  await e2eRows(sql`update persons set onboarding = null where lower(email) = ${EMAIL}`);
  await page.goto("/en/account");
  await page.waitForURL(/\/en\/account\/welcome$/);
  await page.locator('[data-cookie-banner] [data-consent="reject_all"]').click();
  await expectAccessible(page);

  const step = (name: string) => page.locator(`[data-onboarding-step="${name}"]`);
  await step("emergency").locator('input[name="name"]').fill("Jan Peeters");
  await step("emergency").locator('input[name="phone"]').fill("0470 11 22 33");
  await step("emergency").locator('input[name="phone"]').press("Enter");

  await expect(step("communication")).toBeVisible();
  await expect(step("communication").locator('input[type="checkbox"]:checked')).toHaveCount(0);
  await step("communication").getByRole("button", { name: "Skip" }).click();

  await step("company").locator('input[name="vat"]').fill(VAT);
  await step("company").locator('input[name="company_name"]').fill("E2E Onboarding BV");
  await step("company").locator('input[name="company_name"]').press("Enter");

  await expect(step("about")).toBeVisible();
  await step("about").getByRole("button", { name: "Later" }).click();
  await page.waitForURL(/\/en\/account$/);

  const card = page.locator('[data-home-card="onboarding"]');
  await expect(card).toContainText("2 of 4");
  const [row] = await e2eRows<{ emergency: { name: string } | null; corporate: boolean }>(
    sql`select p.emergency_contact as emergency,
               exists (select 1 from company_contacts cc join companies c on c.id = cc.company_id where cc.person_id = p.id and c.vat_number = ${VAT}) as corporate
          from persons p where lower(p.email) = ${EMAIL}`,
  );
  expect(row).toMatchObject({ emergency: { name: "Jan Peeters" }, corporate: true });

  const hidden = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/en/account");
  await card.getByRole("button", { name: "Hide" }).click();
  await hidden;
  await expect(card).toHaveCount(0);
});
