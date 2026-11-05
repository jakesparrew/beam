import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { emailHash } from "@beam/core/crm";
import { newLinkToken } from "@beam/core/email";
import { expectAccessible } from "./support/a11y";
import { signInCustomer, signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows, e2eRewrite } from "./support/db";
import { uniqueEmail } from "./support/ids";

/**
 * crm end to end (crm-P7; runs at the wave checkpoint against beam_dev with the demo seed).
 * Staff: create a person and see the duplicate warning, add a note and a task, set an override
 * and see the banner, merge two persons and see both histories on the 360 timeline. Customer
 * (demo `customer1@example.com`): edit the profile and toggle a preference (restored at the end).
 * One-click unsubscribe POST on the preference URL. axe scans of `/nl/account/profile`,
 * `/nl/account/preferences` and `/nl/preferences/<token>`. Selectors use names, test ids and
 * roles, not copy. Shared rows touched here are reset before and after (runbook 3.6).
 */
test.describe.configure({ mode: "serial" });

const CUSTOMER = "customer1@example.com";
const RUN = Date.now().toString(36);
const LAST = `E2E-crm-${RUN}`;
const PHONE = `+3247${String(Date.now()).slice(-7)}`;
const TASK = `E2E crm task ${RUN}`;
const NOTE = `E2E crm note ${RUN}`;
let existingId = "";
let createdId = "";
let loserId = "";
let customerFirstName: string | null = null;
let token = "";

async function clickAndWait(page: Page, click: () => Promise<void>): Promise<void> {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await click();
  await response;
}

async function resetShared(): Promise<void> {
  await e2eRows(sql`update persons set email = null, email_hash = null, phone = null, phone_e164 = null, erased_at = coalesce(erased_at, now()) where last_name like 'E2E-crm-%'`);
  await e2eRows(sql`update tasks set status = 'cancelled' where title like 'E2E crm task %' and status = 'open'`);
  await e2eRewrite([sql`delete from email_messages where idempotency_key like 'e2e:crm:%'`]);
}

test.beforeAll(async () => {
  await resetShared();
  const email = uniqueEmail("crm-existing");
  const [row] = await e2eRows<{ id: string }>(
    sql`insert into persons (email, email_hash, phone, phone_e164, first_name, last_name, locale, acquisition, is_tester)
        values (${email}, ${emailHash(email)}, ${PHONE}, ${PHONE}, 'Existing', ${LAST}, 'nl-BE', '{"source":"manual"}'::jsonb, true) returning id`,
  );
  existingId = row!.id;
  const [cust] = await e2eRows<{ first_name: string | null }>(sql`select first_name from persons where email = ${CUSTOMER} and erased_at is null`);
  customerFirstName = cust?.first_name ?? null;
});

test.afterAll(async () => {
  if (customerFirstName !== null) await e2eRows(sql`update persons set first_name = ${customerFirstName} where email = ${CUSTOMER} and erased_at is null`);
  await resetShared();
  await closeE2eDb();
});

test("staff creates a person and sees the duplicate warning", async ({ page }) => {
  await signInStaff(page, "owner", { returnTo: "/admin/persons/new" });
  await page.locator('input[name="firstName"]').fill("Created");
  await page.locator('input[name="lastName"]').fill(LAST);
  await page.locator('input[name="phone"]').fill(PHONE);
  await clickAndWait(page, () => page.locator('form button[type="submit"]').first().click());
  const panel = page.getByTestId("duplicate-panel");
  await expect(panel).toBeVisible();
  await clickAndWait(page, () => panel.getByRole("button").last().click());
  await page.waitForURL(/\/admin\/persons\/[0-9a-f-]{36}$/);
  createdId = page.url().split("/").pop()!;
  expect(createdId).not.toBe(existingId);
  await expect(page.getByTestId("person-360")).toBeVisible();
});

test("staff adds a note and a task on the 360", async ({ page }) => {
  await signInStaff(page, "owner", { returnTo: `/admin/persons/${createdId}` });
  await page.getByTestId("action-note").locator("summary").click();
  const note = page.getByTestId("note-form");
  await note.locator("textarea").fill(NOTE);
  await clickAndWait(page, () => note.locator('button[type="submit"]').click());
  await page.reload();
  await expect(page.getByTestId("timeline").getByText(NOTE)).toBeVisible();

  const tasks = page.locator('section[aria-labelledby="tasks-heading"]');
  await tasks.getByRole("button").first().click();
  await tasks.locator("input").first().fill(TASK);
  await clickAndWait(page, () => tasks.locator('button[type="submit"]').first().click());
  const [task] = await e2eRows<{ n: number }>(sql`select count(*)::int as n from tasks where title = ${TASK} and person_id = ${createdId}`);
  expect(Number(task!.n)).toBe(1);
});

test("staff sets an override and sees the banner", async ({ page }) => {
  await signInStaff(page, "owner", { returnTo: `/admin/persons/${createdId}` });
  await page.getByTestId("action-override").locator("summary").click();
  const form = page.getByTestId("status-override-form");
  await form.locator("select").selectOption("member");
  await form.locator("input").fill("E2E override reason");
  await clickAndWait(page, () => form.locator('button[type="submit"]').click());
  await page.reload();
  await expect(page.getByTestId("override-banner")).toBeVisible();
});

test("staff merges two persons and sees both histories", async ({ page }) => {
  const email = uniqueEmail("crm-loser");
  const [row] = await e2eRows<{ id: string }>(
    sql`insert into persons (email, email_hash, first_name, last_name, locale, acquisition, is_tester) values (${email}, ${emailHash(email)}, 'Loser', ${LAST}, 'nl-BE', '{"source":"manual"}'::jsonb, true) returning id`,
  );
  loserId = row!.id;
  await e2eRows(sql`insert into activity_events (kind, person_id, actor, data) values ('interaction.logged', ${loserId}, '{"kind":"system","id":null}'::jsonb, ${JSON.stringify({ channel: "call", purpose: "service", summary: `E2E loser history ${RUN}` })}::jsonb)`);

  await signInStaff(page, "owner", { returnTo: `/admin/persons/${createdId}/merge?with=${loserId}` });
  await page.locator("#merge-confirm").fill("MERGE");
  await clickAndWait(page, () => page.locator("#merge-confirm").locator("xpath=following-sibling::button[1]").click());
  const [merged] = await e2eRows<{ merged_into_person_id: string | null }>(sql`select merged_into_person_id from persons where id = ${loserId}`);
  expect(merged!.merged_into_person_id).toBe(createdId);

  await page.goto(`/admin/persons/${loserId}`);
  await page.waitForURL(new RegExp(`/admin/persons/${createdId}$`));
  const timeline = page.getByTestId("timeline");
  await expect(timeline.getByText(`E2E loser history ${RUN}`)).toBeVisible();
  await expect(timeline.getByText(NOTE)).toBeVisible();
});

test("customer edits the profile and changes a preference; pages pass axe", async ({ page }) => {
  await signInCustomer(page, CUSTOMER, "nl");
  await page.goto("/nl/account/profile");
  await expectAccessible(page);
  await page.locator('input[name="firstName"]').fill(`E2E${RUN}`);
  await clickAndWait(page, () => page.locator('form button[type="submit"]').first().click());
  const [after] = await e2eRows<{ first_name: string }>(sql`select first_name from persons where email = ${CUSTOMER} and erased_at is null`);
  expect(after!.first_name).toBe(`E2E${RUN}`);

  await page.goto("/nl/account/preferences");
  await expectAccessible(page);
  // The save button is the first non-switch button of the preference form (in <main>).
  const save = () => clickAndWait(page, () => page.locator('main button:not([role="switch"])').first().click());
  const newsletter = () => page.getByRole("switch").first();
  if ((await newsletter().getAttribute("aria-checked")) !== "true") {
    await newsletter().click();
    await save();
    await page.reload();
  }
  await newsletter().click();
  await save();
  const [withdrawn] = await e2eRows<{ status: string }>(
    sql`select c.status from v_consent_current c join persons p on p.id = c.person_id where p.email = ${CUSTOMER} and p.erased_at is null and c.purpose = 'newsletter'`,
  );
  expect(withdrawn!.status).toBe("withdrawn");
  // restore: a fresh portal grant lifts the scoped unsubscribe (rule 3.19)
  await page.reload();
  await newsletter().click();
  await save();
});

test("one-click POST on the preference URL answers 200, GET only redirects; the preference page passes axe", async ({ page, request }) => {
  const [cust] = await e2eRows<{ id: string }>(sql`select id from persons where email = ${CUSTOMER} and erased_at is null`);
  const link = newLinkToken();
  token = link.token;
  await e2eRows(
    sql`insert into email_messages (kind, locale, to_email, person_id, idempotency_key, status, sent_at, link_token_hash)
        values ('transactional', 'nl-BE', ${CUSTOMER}, ${cust!.id}, ${`e2e:crm:${RUN}`}, 'sent', now(), ${link.hash})`,
  );
  const get = await request.get(`/api/public/unsubscribe/${token}`, { maxRedirects: 0 });
  expect(get.status()).toBe(303);
  expect(get.headers().location).toContain(`/preferences/${token}`);

  const post = await request.post(`/api/public/unsubscribe/${token}`, { form: { "List-Unsubscribe": "One-Click" } });
  expect(post.status()).toBe(200);
  expect(await post.text()).toBe("");
  const unknown = await request.post(`/api/public/unsubscribe/${"x".repeat(43)}`, { form: { "List-Unsubscribe": "One-Click" } });
  expect(unknown.status()).toBe(200);

  await page.goto(`/nl/preferences/${token}`);
  await expect(page.getByRole("switch").first()).toBeVisible();
  await expectAccessible(page);
});
