import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { definitionHash } from "@beam/db/seed/automation";
import { signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";

/**
 * automation admin end to end (automation-P5; runs at the wave checkpoint against beam_dev with
 * the demo seed). The demo marketing user opens the seeded `review-request` journey, changes the
 * offset of its `ask` step in the form editor, saves, publishes the next version, pauses and
 * resumes it and opens the run log. The journey is shared demo data: before and after the test
 * its published definition, draft and status are put back (a version row is immutable, so the
 * original definition is re-published as a new version when it changed).
 */
test.describe.configure({ mode: "serial" });

const SLUG = "review-request";
type Snapshot = { id: string; definition: unknown; status: string };
let original: Snapshot | null = null;

async function snapshot(): Promise<Snapshot | null> {
  const [row] = await e2eRows<Snapshot>(
    sql`select a.id, v.definition, a.status::text as status from automations a join automation_versions v on v.id = a.current_version_id where a.slug = ${SLUG}`,
  );
  return row ?? null;
}

async function restore(): Promise<void> {
  if (!original) return;
  const now = await snapshot();
  if (now && definitionHash(now.definition as never) !== definitionHash(original.definition as never)) {
    const def = JSON.stringify(original.definition);
    await e2eRows(sql`
      with v as (
        insert into automation_versions (automation_id, version, definition, definition_hash, change_note)
        select ${original.id}, coalesce(max(version), 0) + 1, ${def}::jsonb, ${definitionHash(original.definition as never)}, 'E2E reset'
        from automation_versions where automation_id = ${original.id}
        returning id
      )
      update automations set current_version_id = (select id from v) where id = ${original.id}`);
  }
  await e2eRows(sql`update automations set draft_definition = ${JSON.stringify(original.definition)}::jsonb, status = 'active', paused_at = null where id = ${original.id}`);
}

async function clickAndWait(page: Page, click: () => Promise<void>): Promise<void> {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await click();
  await response;
}

test.beforeAll(async () => {
  original = await snapshot();
  await restore();
});

test.afterAll(async () => {
  await restore();
  await closeE2eDb();
});

test("marketing edits a seeded journey's step offset, publishes, pauses, resumes and opens the run log", async ({ page }) => {
  test.skip(!original, `the demo seed has no ${SLUG}`);
  const id = original!.id;
  const [{ version: before } = { version: 0 }] = await e2eRows<{ version: number }>(sql`select max(version)::int as version from automation_versions where automation_id = ${id}`);

  await signInStaff(page, "marketing", { returnTo: "/admin/automations" });
  await expect(page.getByTestId("automation-table")).toBeVisible();
  await page.locator(`tr[data-slug="${SLUG}"] a`).first().click();
  // The list shows a status badge per row: assert on the overview only once it has loaded.
  await page.waitForURL(new RegExp(`/admin/automations/${id}$`));
  await expect(page.getByTestId("automation-status")).toHaveAttribute("data-status", "active");

  // Form editor: move the first step by one hour and save the draft.
  await page.goto(`/admin/automations/${id}/edit`);
  const minutes = page.getByTestId("step-0-minutes");
  const current = Number(await minutes.inputValue());
  await minutes.fill(String(current + 60));
  await clickAndWait(page, () => page.getByTestId("editor-save").click());
  await expect(page.getByTestId("editor-message")).toBeVisible();
  const [draft] = await e2eRows<{ minutes: number }>(sql`select (draft_definition->'steps'->0->'at'->>'minutes')::int as minutes from automations where id = ${id}`);
  expect(draft?.minutes).toBe(current + 60);

  // Publish the next version.
  await page.getByTestId("publish-open").click();
  await page.locator('textarea[name="changeNote"]').fill("E2E: ask one hour later");
  await clickAndWait(page, () => page.getByTestId("publish-submit").click());
  await expect(page.getByTestId("publish-done")).toBeVisible();
  const [{ version: after } = { version: 0 }] = await e2eRows<{ version: number }>(
    sql`select v.version from automations a join automation_versions v on v.id = a.current_version_id where a.id = ${id}`,
  );
  expect(after).toBe(before + 1);

  // Pause and resume on the overview.
  await page.goto(`/admin/automations/${id}`);
  await clickAndWait(page, () => page.getByTestId("automation-pause").click());
  await expect(page.getByTestId("automation-status")).toHaveAttribute("data-status", "paused");
  await clickAndWait(page, () => page.getByTestId("automation-resume").click());
  await expect(page.getByTestId("automation-status")).toHaveAttribute("data-status", "active");

  // The run log opens (rows or the empty state).
  await page.goto(`/admin/automations/${id}/runs`);
  await expect(page.getByTestId("run-filters")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
