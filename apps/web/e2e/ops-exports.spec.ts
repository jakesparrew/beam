import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { demoStaffEmail, signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";

/**
 * ops-P6 end to end, acceptance "data can be exported" (beam_dev with the demo seed): the owner
 * creates a persons export on `/admin/reports/exports`, the chunk and finalise jobs run, and the
 * downloaded zip contains `persons-1.csv`. The owner's exports are removed before and after the
 * test (runbook 3.6). Selectors use names and test ids, not the copy.
 */
test.describe.configure({ mode: "serial" });

const OWNER = demoStaffEmail("owner");

async function reset(): Promise<void> {
  await e2eRows(sql`delete from data_exports where created_by_user_id in (select id from users where lower(email) = lower(${OWNER}))`);
}

test.beforeAll(reset);
test.afterAll(async () => {
  await reset();
  await closeE2eDb();
});

test("create a persons export, download the zip, it contains persons-1.csv", async ({ page }) => {
  test.setTimeout(180_000);
  await signInStaff(page, "owner", { returnTo: "/admin/reports/exports" });
  await expect(page).toHaveURL(/\/admin\/reports\/exports/);

  const form = page.getByTestId("new-export");
  await form.locator('input[name="kind"][value="entity"]').check();
  await form.locator('select[name="entity"]').selectOption("persons");
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await form.locator('button[type="submit"]').click();
  await posted;

  // the chunk and finalise jobs run after the action and on the local tick
  await expect
    .poll(
      async () => {
        const rows = await e2eRows<{ status: string }>(
          sql`select status::text as status from data_exports where created_by_user_id in (select id from users where lower(email) = lower(${OWNER})) order by created_at desc limit 1`,
        );
        return rows[0]?.status ?? "missing";
      },
      { timeout: 120_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe("done");

  await page.reload();
  const link = page.getByTestId("export-download").first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/admin\/reports\/exports\/[0-9a-f-]{36}\/download$/);
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/zip");
  const body = await res.body();
  expect(body.subarray(0, 4).toString("hex")).toBe("504b0304");
  expect(body.includes(Buffer.from("persons-1.csv"))).toBe(true);
});
