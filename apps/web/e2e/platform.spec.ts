import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { expectAccessible } from "./support/a11y";
import { demoStaffEmail, formError, signInCustomer, signInStaff, staffLoginMessages, submitAndWait } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";

/**
 * platform-P6 end to end (runs at the Wave 0 checkpoint against beam_dev with the demo seed).
 * The 10-wrong-passwords case uses the `reception` demo account and restores it afterwards
 * through the database, because the demo seed is shared (runbook 3.6).
 */
test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await closeE2eDb();
});

test("the login page is accessible and sends signed-out admins there", async ({ page }) => {
  await page.goto("/admin/system/jobs");
  await expect(page).toHaveURL(/\/admin\/login\?returnTo=%2Fadmin%2Fsystem%2Fjobs/);
  await expectAccessible(page);
});

test("the demo owner signs in with password and TOTP, sees the jobs and signs out", async ({ page }) => {
  await page.goto("/admin/login");
  await page.getByLabel(/e-?mail/i).fill(demoStaffEmail("owner"));
  await page.locator('input[name="password"]').fill(process.env.DEMO_STAFF_PASSWORD ?? "");
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/admin\/mfa\/verify/);
  await expectAccessible(page);

  await signInStaff(page, "owner", { returnTo: "/admin/system/jobs" });
  await expect(page).toHaveURL(/\/admin\/system\/jobs/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectAccessible(page);

  await page.goto("/admin/account");
  await page.locator("#sign-out").click();
  await page.waitForURL(/\/admin\/login/);
  await page.goto("/admin/system/jobs");
  await expect(page).toHaveURL(/\/admin\/login/);
});

test("ten wrong passwords lock the account", async ({ page }) => {
  const email = demoStaffEmail("reception");
  // The per-IP login limit (10 per minute, PL-68) would answer rate_limited before the lock.
  const clearLoginLimits = () => e2eRows(sql`delete from rate_limits where key like 'login:%'`);
  // Restore before as well as after, so a run that died half-way cannot break the next one.
  const restore = async () => {
    await e2eRows(sql`update users set failed_logins = 0, locked_until = null where email = ${email}`);
    await clearLoginLimits();
  };
  const attempt = async (password: string) => {
    await page.goto("/admin/login");
    await page.getByLabel(/e-?mail/i).fill(email);
    await page.locator('input[name="password"]').fill(password);
    // Each attempt waits for its server action to answer, so no attempt overlaps the next one,
    // the counter read below or the restore step.
    await submitAndWait(page);
  };
  try {
    await restore();
    for (let i = 0; i < 10; i++) {
      await attempt(`Wrong-password-${i}-x!`);
      await expect(formError(page)).toContainText(staffLoginMessages.invalidCredentials);
    }
    const [row] = await e2eRows<{ failed_logins: number; locked: boolean }>(
      sql`select failed_logins, (locked_until > now()) as locked from users where email = ${email}`,
    );
    expect(row?.failed_logins).toBeGreaterThanOrEqual(10);
    expect(row?.locked).toBe(true);

    await clearLoginLimits();
    await attempt(process.env.DEMO_STAFF_PASSWORD ?? "");
    await expect(formError(page)).toContainText(staffLoginMessages.locked);
    await expect(page).toHaveURL(/\/admin\/login/);
  } finally {
    await restore();
  }
});

test("the seeded customer signs in with a magic link from the sink", async ({ page }) => {
  await page.goto("/nl/account/login");
  await expectAccessible(page);
  await signInCustomer(page, "customer1@example.com", "nl");
  await expect(page).toHaveURL(/\/nl\/account/);
  await page.goto("/nl/account/login/check-email");
  await expectAccessible(page);
});
