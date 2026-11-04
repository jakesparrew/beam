import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { expectAccessible } from "./support/a11y";
import { demoStaffEmail, signInStaff, submitAndWait } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";
import { uniqueEmail } from "./support/ids";

/**
 * platform-P8 end to end (runs at the Wave 1 checkpoint against beam_dev with the demo seed):
 * the owner invites a reception user, changes its role, sets a flag to testers and finds the
 * audit rows; the demo reception user reports a problem from the user menu and the owner sees it
 * on `/admin/system/support`. Selectors use names, ids and data attributes, not the copy, because
 * the demo staff accounts may use any of the three locales. Shared demo rows touched here (the
 * flag and the reported problem) are reset before and after (runbook 3.6).
 */
test.describe.configure({ mode: "serial" });

const FLAG = "ff_booking_ticket_types";
const PROBLEM_TITLE = `E2E platform-admin problem ${Date.now().toString(36)}`;
const invitee = uniqueEmail("platform-admin-invite");

/** Waits for the Server Action POST that the click triggers, so assertions never race it. */
async function clickAndWait(page: Page, click: () => Promise<void>): Promise<void> {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await click();
  await response;
}

async function resetSharedRows(): Promise<void> {
  await e2eRows(sql`delete from feature_flags where key = ${FLAG}`);
  await e2eRows(sql`delete from support_requests where title like 'E2E platform-admin problem%'`);
  await e2eRows(sql`delete from auth_sessions where user_id in (select id from users where email like 'e2e+platform-admin-invite-%@example.com')`);
  await e2eRows(sql`update users set status = 'disabled' where email like 'e2e+platform-admin-invite-%@example.com'`);
}

test.beforeAll(async () => {
  await resetSharedRows();
});

test.afterAll(async () => {
  await resetSharedRows();
  await closeE2eDb();
});

test("the owner invites a reception user, changes its role, sets a flag to testers and finds the audit rows", async ({ page }) => {
  await signInStaff(page, "owner", { returnTo: "/admin/settings" });
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectAccessible(page);

  // Invite a reception user (the role select defaults to reception).
  await page.goto("/admin/settings/users");
  await expectAccessible(page);
  const invite = page.locator('form[aria-labelledby="invite-title"]');
  await invite.locator('input[name="name"]').fill("E2E Invitee");
  await invite.locator('input[name="email"]').fill(invitee);
  await expect(invite.locator('select[name="roleKey"]')).toHaveValue("reception");
  await submitAndWait(page, invite.locator('button[type="submit"]'));
  await expect(invite.locator('[role="status"]')).toContainText(invitee);
  const [created] = await e2eRows<{ id: string; role_key: string }>(sql`select id, role_key::text as role_key from users where email = ${invitee}`);
  expect(created?.role_key).toBe("reception");

  // Change its role to customer_service.
  await page.goto(`/admin/settings/users/${created!.id}`);
  await expectAccessible(page);
  const profile = page.locator("form").filter({ has: page.locator('select[name="roleKey"]') });
  await profile.locator('select[name="roleKey"]').selectOption("customer_service");
  await submitAndWait(page, profile.locator('button[type="submit"]'));
  await expect.poll(async () => (await e2eRows<{ role_key: string }>(sql`select role_key::text as role_key from users where id = ${created!.id}`))[0]?.role_key).toBe("customer_service");

  // Set a flag to testers.
  await page.goto("/admin/settings/flags");
  await expectAccessible(page);
  const flag = page.locator(`section[data-flag="${FLAG}"]`);
  await flag.locator(`[id="${FLAG}-testers"]`).click();
  // The flag's Save button is the last button of its section.
  await clickAndWait(page, () => flag.locator("button").last().click());
  await expect.poll(async () => (await e2eRows<{ state: string }>(sql`select state::text as state from feature_flags where key = ${FLAG}`))[0]?.state).toBe("testers");

  // The audit log has the three rows.
  for (const [action, entityId] of [
    ["users.invite", created!.id],
    ["users.role_change", created!.id],
    ["flags.update", FLAG],
  ] as const) {
    await page.goto(`/admin/system/audit?action=${encodeURIComponent(action)}&entityId=${encodeURIComponent(entityId)}`);
    await expect(page.locator("table tbody tr").first()).toContainText(action);
  }
  await expectAccessible(page);
});

test("the reception user reports a problem from the user menu and the owner sees it in the support register", async ({ browser }) => {
  const reception = await browser.newPage();
  await signInStaff(reception, "reception", { returnTo: "/admin/support" });
  await expectAccessible(reception);
  await reception.locator("header button[aria-haspopup]").last().click();
  await reception.getByRole("menuitem").first().click();
  const dialog = reception.getByRole("dialog");
  await dialog.locator('input[name="title"]').fill(PROBLEM_TITLE);
  await dialog.locator('textarea[name="description"]').fill("The booking calendar does not load on the reception tablet.");
  await dialog.locator('button[role="radio"][value="normal"]').click();
  await clickAndWait(reception, () => dialog.locator('button[type="submit"]').click());
  await expect(dialog.locator('[role="status"]')).toBeVisible();
  const [row] = await e2eRows<{ reference: string; channel: string; reporter: string }>(
    sql`select r.reference, r.channel::text as channel, u.email as reporter from support_requests r join users u on u.id = r.reported_by_user_id where r.title = ${PROBLEM_TITLE}`,
  );
  expect(row?.channel).toBe("in_app");
  expect(row?.reporter).toBe(demoStaffEmail("reception"));
  await reception.goto("/admin/support");
  await expect(reception.getByText(row!.reference)).toBeVisible();
  await expectAccessible(reception);
  await reception.close();

  const owner = await browser.newPage();
  await signInStaff(owner, "owner", { returnTo: "/admin/system/support" });
  await expect(owner.getByText(row!.reference)).toBeVisible();
  await expect(owner.getByText(PROBLEM_TITLE)).toBeVisible();
  await expectAccessible(owner);
  await owner.close();
});
