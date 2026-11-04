import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { AI_ALLOWED_FIELDS, toAiContext } from "@beam/core/ai";
import { emailHash } from "@beam/core/crm";
import { signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";
import { uniqueEmail } from "./support/ids";

/**
 * Scenario 6: sensitive AI exclusion (proposal section 11), crm-P7. Runs against beam_dev with
 * the demo seed. An assessment-style sensitive free-text answer and a sensitive staff note exist
 * for one person: the note is stored encrypted (the 360 shows the placeholder), `toAiContext`
 * over the person's profile (with the free text and the note body slipped in) returns neither,
 * and no stored `ai_requests.fields_sent` names a sensitive field. Enabling
 * `settings.ai.sensitive_enabled` is refused for a non-owner, needs a purpose and writes an
 * audit row. Shared rows touched here (the `ai` setting, the e2e person) are reset before and after.
 */
test.describe.configure({ mode: "serial" });

const email = uniqueEmail("scenario6");
const NOTE = `E2E sensitive note: panic attacks ${Date.now().toString(36)}`;
const FREE_TEXT = `E2E assessment free text: burn-out ${Date.now().toString(36)}`;
const PURPOSE = "E2E scenario 6: staff-reviewed wellbeing follow-up for assessment clients.";
const SENSITIVE_FIELD_NAMES = ["health_note", "sleep", "stress", "recovery", "wellbeing", "medical", "value_enc", "body_enc", "free_text", "note"];

let personId = "";

async function resetShared(): Promise<void> {
  await e2eRows(sql`update settings set value = jsonb_set(value, '{sensitive_enabled}', 'false'::jsonb) where key = 'ai'`);
  await e2eRows(sql`update persons set email = null, email_hash = null, erased_at = coalesce(erased_at, now()) where email like 'e2e+scenario6-%@example.com'`);
}

async function clickAndWait(page: Page, click: () => Promise<void>): Promise<void> {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await click();
  await response;
}

test.beforeAll(async () => {
  await resetShared();
  const [row] = await e2eRows<{ id: string }>(
    sql`insert into persons (email, email_hash, first_name, last_name, locale, acquisition, is_tester) values (${email}, ${emailHash(email)}, 'Scenario', 'Six', 'nl-BE', '{"source":"manual"}'::jsonb, true) returning id`,
  );
  personId = row!.id;
});

test.afterAll(async () => {
  await resetShared();
  await closeE2eDb();
});

test("a sensitive note is stored encrypted and shown only as a placeholder", async ({ page }) => {
  await signInStaff(page, "owner", { returnTo: `/admin/persons/${personId}` });
  await expect(page.getByTestId("person-360")).toBeVisible();
  const block = page.getByTestId("action-note");
  await block.locator("summary").click();
  const form = page.getByTestId("note-form");
  await form.locator("textarea").fill(NOTE);
  await form.getByRole("checkbox").check();
  await clickAndWait(page, () => form.locator('button[type="submit"]').click());

  const rows = await e2eRows<{ is_sensitive: boolean; data: string }>(sql`select is_sensitive, data::text as data from activity_events where person_id = ${personId} and kind = 'note.added'`);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.is_sensitive).toBe(true);
  expect(rows[0]!.data).not.toContain("panic attacks");
  await page.reload();
  await expect(page.getByTestId("sensitive-placeholder").first()).toBeVisible();
  await expect(page.getByText(NOTE)).toHaveCount(0);
});

test("toAiContext and stored ai_requests never carry the sensitive answer or the note", async () => {
  const [profile] = await e2eRows<Record<string, unknown>>(sql`select * from v_person_profile where person_id = ${personId}`);
  const context = toAiContext({ ...(profile ?? {}), free_text: FREE_TEXT, note: NOTE, sleep: "bad", medical: NOTE } as never);
  const json = JSON.stringify(context);
  expect(json).not.toContain(FREE_TEXT);
  expect(json).not.toContain(NOTE);
  for (const key of Object.keys(context)) expect(AI_ALLOWED_FIELDS as readonly string[]).toContain(key);

  const requests = await e2eRows<{ fields_sent: string[] | null }>(sql`select fields_sent from ai_requests`);
  for (const r of requests) for (const f of r.fields_sent ?? []) expect(SENSITIVE_FIELD_NAMES).not.toContain(f);
});

test("enabling sensitive processing needs the owner and a purpose, and is audited", async ({ page, browser }) => {
  // A technical admin sees the owner-only notice and no enable form.
  const other = await browser.newPage();
  await signInStaff(other, "technical_admin", { returnTo: "/admin/settings/ai" });
  const adminPanel = other.locator('section[aria-labelledby="ai-sensitive-title"]');
  await expect(adminPanel).toBeVisible();
  await expect(adminPanel.locator("textarea")).toHaveCount(0);
  await other.close();

  await signInStaff(page, "owner", { returnTo: "/admin/settings/ai" });
  const panel = page.locator('section[aria-labelledby="ai-sensitive-title"]');
  const enable = panel.locator("button").last();
  await panel.locator("textarea").fill("too short");
  await panel.locator("input").fill("DPIA-E2E-6");
  await expect(enable).toBeDisabled();
  await panel.locator("textarea").fill(PURPOSE);
  await clickAndWait(page, () => enable.click());

  const [setting] = await e2eRows<{ enabled: boolean; purpose: string }>(sql`select (value->>'sensitive_enabled')::boolean as enabled, value->>'purpose' as purpose from settings where key = 'ai'`);
  expect(setting).toEqual({ enabled: true, purpose: PURPOSE });
  const audit = await e2eRows<{ n: number }>(sql`select count(*)::int as n from audit_log where action = 'ai.sensitive_enabled' and new_value->>'purpose' = ${PURPOSE}`);
  expect(Number(audit[0]!.n)).toBeGreaterThan(0);
});
