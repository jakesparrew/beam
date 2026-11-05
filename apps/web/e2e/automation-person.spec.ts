/**
 * automation person controls end to end (automation-P6, A-38; runs at the wave checkpoint against
 * beam_dev with the demo seed). The demo marketing user (who holds `automations.move_person`)
 * opens the person page of a person the spec creates (unique `@example.com` address) who is in
 * the seeded `welcome-lead` journey, previews the next steps, moves the person to
 * `after-first-visit` with the "Move to..." dialog, and sees the old journey ended with "moved"
 * and the new one active, with one `automation.person_move` audit row naming both slugs.
 *
 * The seeded journeys are shared demo data and are never edited; the spec writes only its own
 * person and that person's enrolments, which it ends before and after the test.
 */
import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { emailHash } from "@beam/core/crm";
import { signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";
import { uniqueEmail } from "./support/ids";

test.describe.configure({ mode: "serial" });

const FROM = "welcome-lead";
const TO = "after-first-visit";
const RUN_MARK = "AutomationPerson";

type Journey = { id: string; status: string; version_id: string | null; first_step: string | null; group_id: string; domain: string | null };
let journeys: Record<string, Journey | undefined> = {};

const one = async <T>(query: Parameters<typeof e2eRows>[0]): Promise<T | undefined> => (await e2eRows<T>(query))[0];

/** Ends every active enrolment of the persons this spec created (ids by last name). */
async function resetRows(): Promise<void> {
  await e2eRows(sql`
    update automation_enrolments set status = 'exited', ended_at = now(), end_reason = 'manual', next_step_key = null, next_step_at = null, updated_at = now()
    where status = 'active' and person_id in (select id from persons where last_name = ${RUN_MARK})`);
}

async function journey(slug: string): Promise<Journey | undefined> {
  return one<Journey>(sql`
    select a.id, a.status::text as status, a.current_version_id as version_id, v.definition->'steps'->0->>'key' as first_step, a.group_id,
      case when g.is_exclusive then coalesce(g.lane, g.key) end as domain
    from automations a join automation_groups g on g.id = a.group_id left join automation_versions v on v.id = a.current_version_id
    where a.slug = ${slug}`);
}

test.beforeAll(async () => {
  await resetRows();
  journeys = { [FROM]: await journey(FROM), [TO]: await journey(TO) };
});

test.afterAll(async () => {
  await resetRows();
  await closeE2eDb();
});

test(`staff moves a person from ${FROM} to ${TO}`, async ({ page }) => {
  const from = journeys[FROM];
  const to = journeys[TO];
  test.skip(!from?.version_id || from.status !== "active" || !to?.version_id || to.status !== "active", `the demo seed lacks an active ${FROM} or ${TO}`);

  // A lead in welcome-lead, its first step a day away (no consent: nothing is ever sent to it).
  const email = uniqueEmail("automation-person");
  const person = (await one<{ id: string }>(sql`
    insert into persons (email, email_hash, first_name, last_name, locale, is_tester, acquisition)
    values (${email}, ${emailHash(email)}, 'E2E', ${RUN_MARK}, 'en', true, '{"source":"manual"}'::jsonb) returning id`))!;
  const plan = JSON.stringify([{ key: from!.first_step, type: "email", due_at: new Date(Date.now() + 86_400_000).toISOString(), state: "pending" }]);
  const enrolment = (await one<{ id: string }>(sql`
    insert into automation_enrolments (automation_id, automation_version_id, person_id, group_id, exclusive_domain, source, status, next_step_key, next_step_at, plan)
    values (${from!.id}, ${from!.version_id}, ${person.id}, ${from!.group_id}, ${from!.domain}, 'staff', 'active', ${from!.first_step}, now() + interval '1 day', ${plan}::jsonb)
    returning id`))!;
  await e2eRows(sql`
    insert into automation_runs (enrolment_id, person_id, automation_id, automation_version_id, outcome, reason, actor, dedupe_key)
    values (${enrolment.id}, ${person.id}, ${from!.id}, ${from!.version_id}, 'entered', 'staff', '{"kind":"system","id":null}'::jsonb, ${`run:${enrolment.id}::entered`})`);

  await signInStaff(page, "marketing", { returnTo: `/admin/persons/${person.id}` });
  await page.goto(`/admin/persons/${person.id}`);
  const panel = page.getByTestId("automation-panel");
  await expect(panel.locator(`[data-enrolment-id="${enrolment.id}"]`)).toBeVisible();

  // The preview drawer opens read-only.
  await panel.locator(`[data-preview-for="${enrolment.id}"]`).click();
  await expect(page.getByTestId("automation-preview")).toBeVisible();
  await page.keyboard.press("Escape");

  // Move to after-first-visit.
  await panel.getByTestId("automation-move-open").click();
  const dialog = page.getByTestId("automation-move-dialog");
  await dialog.getByTestId("automation-move-from").selectOption(enrolment.id);
  await dialog.getByTestId("automation-move-to").selectOption(to!.id);
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await dialog.getByTestId("automation-move-submit").click();
  await response;
  await expect(dialog).toBeHidden();

  const old = await one<{ status: string; end_reason: string | null }>(sql`select status::text as status, end_reason from automation_enrolments where id = ${enrolment.id}`);
  expect(old).toEqual({ status: "exited", end_reason: "moved" });
  const moved = await one<{ id: string; source: string }>(sql`
    select id, source::text as source from automation_enrolments where person_id = ${person.id} and automation_id = ${to!.id} and status in ('active', 'completed')`);
  expect(moved?.source).toBe("staff_move");
  const audits = await e2eRows<{ old_value: { automation: string }; new_value: { automation: string } }>(sql`
    select old_value, new_value from audit_log where action = 'automation.person_move' and person_id = ${person.id}`);
  expect(audits).toHaveLength(1);
  expect(audits[0]!.old_value.automation).toBe(FROM);
  expect(audits[0]!.new_value.automation).toBe(TO);

  // Both appear on the person page: the old journey ended "moved", the new one entered.
  await page.reload();
  await expect(panel.locator(`[data-enrolment-id="${enrolment.id}"][data-end-reason="moved"]`)).toBeVisible();
  await expect(panel.locator(`[data-enrolment-id="${moved!.id}"]`)).toBeVisible();
  await expect(page.getByTestId("automation-timeline").locator('[data-run-outcome="exited"]').first()).toBeVisible();
});
