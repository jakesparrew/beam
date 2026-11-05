import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { demoStaffEmail, signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";

/**
 * ops-P7 end to end (beam_dev with the demo seed): with `ff_ops_retention` on for testers (the
 * owner listed), the owner opens `/admin/dashboard/retention`, rebuilds this week's list, finds the
 * test's own high-value inactive customer on it, clicks "Create task" and sees the task on the
 * person page. The person is reused across runs by its address and is a tester again after the
 * test (testers never appear on the list); the flag row, the list item and the task are reset
 * before and after (runbook 3.6). Selectors use test ids; the task title is read from the
 * catalogue of the owner's locale.
 */
test.describe.configure({ mode: "serial" });

const FLAG = "ff_ops_retention";
const EMAIL = "e2e-ops-retention@example.com";
const OWNER = demoStaffEmail("owner");
let personId = "";

const here = path.dirname(fileURLToPath(import.meta.url));
function taskTitle(locale: string): string {
  const file = path.join(here, `../../../packages/core/src/i18n/messages/${locale}/ops.json`);
  const ops = (JSON.parse(readFileSync(file, "utf8")) as { ops: { retention: { task_title: Record<string, string> } } }).ops;
  return ops.retention.task_title.high_value_inactive!;
}

async function reset(): Promise<void> {
  await e2eRows(sql`delete from feature_flags where key = ${FLAG}`);
  await e2eRows(sql`delete from retention_list_items where person_id in (select id from persons where email = ${EMAIL})`);
  await e2eRows(sql`delete from tasks where ref_type = 'retention_list_item' and person_id in (select id from persons where email = ${EMAIL})`);
  await e2eRows(sql`update persons set is_tester = true where email = ${EMAIL}`);
}

/** The test's customer: not a tester, high value (EUR 9,000) and inactive for 200 days, so it tops the list. */
async function seed(): Promise<void> {
  const [existing] = await e2eRows<{ id: string }>(sql`select id::text as id from persons where email = ${EMAIL}`);
  const [person] = existing
    ? [existing]
    : await e2eRows<{ id: string }>(
        sql`insert into persons (email, first_name, last_name, locale, acquisition, is_tester)
            values (${EMAIL}, 'Retention', 'Customer E2E', 'nl-BE', '{"source":"manual"}'::jsonb, false) returning id::text as id`,
      );
  personId = person!.id;
  await e2eRows(sql`update persons set is_tester = false where id = ${personId}::uuid`);
  await e2eRows(sql`insert into person_stats (person_id, revenue_cents, purchases, last_activity_at, last_purchase_at, b2c_stage)
    values (${personId}::uuid, 900000, 6, now() - interval '200 days', now() - interval '200 days', 'retention')
    on conflict (person_id) do update set revenue_cents = 900000, purchases = 6, last_activity_at = now() - interval '200 days',
      last_purchase_at = now() - interval '200 days', next_booking_at = null`);
  const [owner] = await e2eRows<{ id: string }>(sql`select id::text as id from users where lower(email) = lower(${OWNER})`);
  await e2eRows(sql`insert into feature_flags (key, state, user_ids) values (${FLAG}, 'testers', array[${owner!.id}::uuid])`);
}

/** Waits for the Server Action POST that the click triggers, so assertions never race it. */
async function clickAndWait(page: Page, click: () => Promise<void>): Promise<void> {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await click();
  await response;
}

test.beforeAll(async () => {
  await reset();
  await seed();
});
test.afterAll(async () => {
  await reset();
  await closeE2eDb();
});

test("the weekly list renders with the flag on for a tester, and Create task shows the task on the person page", async ({ page }) => {
  test.setTimeout(180_000);
  await signInStaff(page, "owner", { returnTo: "/admin/dashboard/retention" });
  // Flags are cached for 60 s per server instance: reload until the screen is on.
  await expect
    .poll(
      async () => {
        await page.goto("/admin/dashboard/retention");
        return page.getByTestId("retention-page").count();
      },
      { timeout: 90_000, intervals: [2_000, 5_000, 10_000] },
    )
    .toBe(1);

  await clickAndWait(page, () => page.getByTestId("retention-rebuild").click());
  await expect(page.getByTestId("retention-notice")).toBeVisible();
  const row = page.locator(`[data-testid="retention-item"][data-person-id="${personId}"]`);
  await expect(row).toBeVisible();

  await clickAndWait(page, () => row.getByTestId("retention-create-task").click());
  await expect(page.getByTestId("retention-notice")).toBeVisible();
  await expect(row.getByTestId("retention-open-task")).toBeVisible();

  const [task] = await e2eRows<{ id: string; title: string; source: string }>(
    sql`select t.id::text as id, t.title, t.source::text as source from tasks t join retention_list_items i on i.task_id = t.id where i.person_id = ${personId}::uuid`,
  );
  expect(task).toMatchObject({ source: "retention" });
  const [owner] = await e2eRows<{ locale: string }>(sql`select locale::text as locale from users where lower(email) = lower(${OWNER})`);
  expect(task!.title).toBe(taskTitle(owner!.locale));

  await row.getByTestId("retention-open-task").click();
  await page.waitForURL(new RegExp(`/admin/persons/${personId}`));
  await expect(page.getByText(task!.title).first()).toBeVisible();
});
