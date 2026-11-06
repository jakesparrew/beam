import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";

/**
 * The visual workflow builder end to end (automation-P10, R4; runs at the wave checkpoint against
 * beam_dev with the demo seed). The demo marketing user opens the builder of a manual test
 * journey, builds Trigger -> Delay -> Branch with a Send email block in the Yes lane and a Create
 * task block in the No lane, saves and publishes it, switches it on, enrols a demo person from the
 * person page and sees the journey's run log.
 *
 * The journey `e2e-builder` is test data this spec owns: it is inserted when absent; before and
 * after the test its draft is put back to the starter flow, its active enrolments end (`manual`)
 * and the journey is paused, so the demo data stays quiet between runs.
 */
test.describe.configure({ mode: "serial" });

const SLUG = "e2e-builder";
/** Per run, so the flow differs from the version an earlier run published (publish refuses an unchanged draft). */
const RUN = Date.now().toString(36);
const TEMPLATE = "automation.voucher_expiry";
const STARTER = {
  schema_version: 1,
  trigger: { manual: true },
  anchor: "enrolment",
  re_entry: "always",
  exit_on: [],
  steps: [{ key: "email_1", type: "email", template: TEMPLATE, at: { from: "enrolment", minutes: 0 } }],
};

const here = path.dirname(fileURLToPath(import.meta.url));
type Catalogue = { automation: Record<string, Record<string, unknown>> };
const catalogues: Catalogue[] = (["nl-BE", "fr-BE", "en"] as const).map(
  (l) => JSON.parse(readFileSync(path.join(here, `../../../packages/core/src/i18n/messages/${l}/automation.json`), "utf8")) as Catalogue,
);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** An automation catalogue text in any of the three locales (staff accounts may use any). */
const anyLocale = (screen: string, key: string) => new RegExp(`^(${catalogues.map((c) => escapeRe(String(c.automation[screen]![key]))).join("|")})$`);

let automationId: string | null = null;
let personId: string | null = null;

async function reset(): Promise<void> {
  if (!automationId) return;
  await e2eRows(sql`update automation_enrolments set status = 'exited', ended_at = now(), end_reason = 'manual', next_step_at = null where automation_id = ${automationId} and status = 'active'`);
  await e2eRows(sql`update automations set draft_definition = ${JSON.stringify(STARTER)}::jsonb where id = ${automationId}`);
  await e2eRows(sql`update automations set status = 'paused', paused_at = now() where id = ${automationId} and status = 'active'`);
}

async function clickAndWait(page: Page, click: () => Promise<void>): Promise<void> {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await click();
  await response;
}

test.beforeAll(async () => {
  const [group] = await e2eRows<{ id: string }>(sql`select id from automation_groups where is_exclusive = false order by priority, key limit 1`);
  if (group) {
    await e2eRows(sql`
      insert into automations (slug, name, group_id, priority, status, is_marketing, purpose, draft_definition)
      values (${SLUG}, 'E2E builder', ${group.id}, 900, 'draft', false, null, ${JSON.stringify(STARTER)}::jsonb)
      on conflict (slug) do nothing`);
  }
  const [a] = await e2eRows<{ id: string }>(sql`select id from automations where slug = ${SLUG}`);
  automationId = a?.id ?? null;
  const [p] = await e2eRows<{ id: string }>(sql`select id from persons where email like '%@demo.beam.be' and erased_at is null and merged_into_person_id is null and processing_restricted_at is null order by created_at limit 1`);
  personId = p?.id ?? null;
  await reset();
});

test.afterAll(async () => {
  await reset();
  await closeE2eDb();
});

test("marketing builds trigger -> delay -> branch -> email and task, publishes, enrols a person and sees the run log", async ({ page }) => {
  test.skip(!automationId || !personId, "the demo seed has no automation group or demo person");
  const id = automationId!;

  await signInStaff(page, "marketing", { returnTo: `/admin/automations/${id}/builder` });
  await expect(page.getByTestId("builder-canvas")).toBeVisible();

  // Start from the Trigger block alone: remove the starter email block.
  await page.getByTestId("builder-remove-email_1").click();
  await expect(page.getByTestId("builder-block-email_1")).toHaveCount(0);

  // Delay (0 minutes, so the run log fills at once), then a Branch.
  await page.getByTestId("builder-palette-delay").click();
  await page.getByTestId("builder-panel").getByLabel(anyLocale("editor", "wait_minutes")).fill("0");
  await page.getByTestId("builder-palette-branch").click();
  const branchKey = await page.getByTestId("builder-step-key").inputValue();

  // Send email in the Yes lane.
  await page.getByTestId(`builder-add-${await laneId(page, branchKey, "then")}`).click();
  await page.getByTestId("builder-palette-email").click();
  await page.getByTestId("builder-panel").getByLabel(anyLocale("editor", "template")).selectOption(TEMPLATE);

  // Create task in the No lane.
  await page.getByTestId(`builder-add-${await laneId(page, branchKey, "else")}`).click();
  await page.getByTestId("builder-palette-task").click();
  await page.getByTestId("builder-panel").getByLabel(anyLocale("editor", "task_title")).fill(`E2E: call the person (${RUN})`);

  await expect(page.getByTestId(`builder-lane-${branchKey}-then`).locator('[data-block="email"]')).toHaveCount(1);
  await expect(page.getByTestId(`builder-lane-${branchKey}-else`).locator('[data-block="task"]')).toHaveCount(1);

  // Save: the draft is the same JSON as the form editor's.
  await clickAndWait(page, () => page.getByTestId("builder-save").click());
  await expect(page.getByTestId("builder-message")).toBeVisible();
  const [draft] = await e2eRows<{ types: string[] }>(sql`select array(select s->>'type' from jsonb_array_elements(draft_definition->'steps') s) as types from automations where id = ${id}`);
  expect(draft?.types).toEqual(["wait", "condition", "email", "task"]);

  // Publish.
  await page.getByTestId("publish-open").click();
  await page.locator('textarea[name="changeNote"]').fill("E2E: built in the visual builder");
  await clickAndWait(page, () => page.getByTestId("publish-submit").click());
  await expect(page.getByTestId("publish-done")).toBeVisible();

  // Switch it on (Activate the first time, Resume after an earlier run).
  await page.goto(`/admin/automations/${id}`);
  // Wait for whichever of the two the page renders: isVisible() does not wait, so checking it
  // before the page had rendered picked Resume on a first run.
  const switchOn = page.getByTestId("automation-activate").or(page.getByTestId("automation-resume"));
  await expect(switchOn).toBeVisible();
  await clickAndWait(page, () => switchOn.click());
  await expect(page.getByTestId("automation-status")).toHaveAttribute("data-status", "active");

  // Enrol a demo person from the person page.
  await page.goto(`/admin/persons/${personId}`);
  await page.getByTestId("automation-enrol-open").click();
  await page.getByTestId("automation-enrol-select").selectOption({ label: "E2E builder" });
  await clickAndWait(page, () => page.getByTestId("automation-enrol-submit").click());
  await expect.poll(async () => (await e2eRows<{ n: number }>(sql`select count(*)::int as n from automation_enrolments where automation_id = ${id} and person_id = ${personId}`))[0]?.n ?? 0).toBeGreaterThan(0);

  // The run log shows the journey's runs for the person.
  await expect
    .poll(async () => (await e2eRows<{ n: number }>(sql`select count(*)::int as n from automation_runs where automation_id = ${id} and person_id = ${personId}`))[0]?.n ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await page.goto(`/admin/automations/${id}/runs`);
  await expect(page.getByTestId("run-log")).toBeVisible();
  await expect(page.getByTestId("run-log").locator(`a[href="/admin/persons/${personId}"]`).first()).toBeVisible();
});

/** The lane key of a branch's lane as the canvas writes it (`<node id>.<lane>`). */
async function laneId(page: Page, branchKey: string, lane: "then" | "else"): Promise<string> {
  const key = await page.getByTestId(`builder-lane-${branchKey}-${lane}`).locator("ol").first().getAttribute("data-lane");
  return key ?? "main";
}
