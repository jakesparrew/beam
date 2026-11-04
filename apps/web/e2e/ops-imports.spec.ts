import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";

/**
 * ops-P4 end to end (beam_dev with the demo seed): the owner uploads a companies CSV of a little
 * over 6 MB (three 3 MB parts), maps it, sees the dry-run report, runs it and finds the rows
 * imported. Companies need no suppressions first (rule 53), so the shared checklist stays as it
 * is. The test's companies and imports are removed before and after (runbook 3.6). Selectors use
 * names, data attributes and test ids, not the copy (the demo accounts use any of the locales).
 */
test.describe.configure({ mode: "serial" });

const PREFIX = "E2E import company";
const IMPORT_NAME = "E2E ops-imports three parts";

/** Four companies, each with an unmapped 1.6 MB notes column, so the file needs three parts. */
function csv(): Buffer {
  const pad = "x".repeat(1_600_000);
  const rows = Array.from({ length: 4 }, (_, i) => `${PREFIX} ${i + 1},Gent,"${pad}"`);
  return Buffer.from(`name,city,notes\n${rows.join("\n")}\n`, "utf8");
}

async function reset(): Promise<void> {
  await e2eRows(sql`delete from import_external_ids where import_id in (select id from imports where name = ${IMPORT_NAME})`);
  await e2eRows(sql`delete from imports where name = ${IMPORT_NAME}`);
  await e2eRows(sql`delete from company_contacts where company_id in (select id from companies where name like ${`${PREFIX}%`})`);
  await e2eRows(sql`delete from companies where name like ${`${PREFIX}%`}`);
}

async function clickAction(page: Page, click: () => Promise<void>): Promise<void> {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await click();
  await response;
}

test.beforeAll(reset);
test.afterAll(async () => {
  await reset();
  await closeE2eDb();
});

test("upload a 3-part CSV, map it, see the dry-run report, run it and find the rows imported", async ({ page }) => {
  test.setTimeout(180_000);
  await signInStaff(page, "owner", { returnTo: "/admin/imports/new" });
  await expect(page).toHaveURL(/\/admin\/imports\/new/);

  await page.locator('select[name="kind"]').selectOption("companies");
  await page.locator('select[name="source"]').selectOption("b2b_list");
  await page.locator('input[name="name"]').fill(IMPORT_NAME);
  await page.locator('input[name="file"]').setInputFiles({ name: "companies.csv", mimeType: "text/csv", buffer: csv() });
  const uploads: number[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/admin/imports/upload") && r.request().method() === "POST") uploads.push(r.status());
  });
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/admin\/imports\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  expect(uploads).toEqual([200, 200, 200]);
  const [imp] = await e2eRows<{ id: string; parts: number }>(sql`select id, 1 + cardinality(part_file_ids) as parts from imports where name = ${IMPORT_NAME}`);
  expect(imp?.parts).toBe(3);

  const mapper = page.getByTestId("import-mapper");
  await mapper.locator('select[data-column="name"]').selectOption("name");
  await mapper.locator('select[data-column="city"]').selectOption("city");
  await mapper.locator('select[data-column="notes"]').selectOption("");
  await clickAction(page, () => mapper.locator("button").last().click());

  const dryRun = page.getByTestId("dry-run-report");
  await expect(dryRun).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("dry-run-report-imported")).toHaveText("4");

  await clickAction(page, () => page.getByTestId("import-report").locator("button").first().click());
  await expect(page.getByTestId("run-report")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("run-report-imported")).toHaveText("4");

  const rows = await e2eRows<{ status: string; n: number }>(sql`select status::text as status, count(*)::int as n from import_rows where import_id = ${imp!.id}::uuid group by 1`);
  expect(rows).toEqual([{ status: "imported", n: 4 }]);
  const companies = await e2eRows<{ n: number }>(sql`select count(*)::int as n from companies where name like ${`${PREFIX}%`}`);
  expect(companies[0]?.n).toBe(4);
  const [state] = await e2eRows<{ status: string }>(sql`select status::text as status from imports where id = ${imp!.id}::uuid`);
  expect(state?.status).toBe("done");
});
