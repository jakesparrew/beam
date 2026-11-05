import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { demoStaffEmail, signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";

/**
 * ops-P10 end to end (beam_dev with the demo seed and the fake Claude gateway, rule 77): with
 * `ff_ops_ai` on for testers (the owner listed), the owner opens `/admin/dashboard/ask`, asks
 * "Which customers generated the most revenue this year?" and sees the answer table with the
 * customers as links to their person pages.
 *
 * The fake gateway's answer for `ai.answer_question` must be a person-level query (for example
 * `select o.person_id, sum(o.total_cents) as revenue_cents from ai.orders o ... group by o.person_id`):
 * see the platform request of ops-P10 in `docs/build/requests.md`. The test's own customer (not a
 * tester, since the `ai` schema leaves testers out) has one paid order today; it is reused by its
 * address, made a tester again afterwards, and the flag row and the owner's questions are reset
 * before and after (runbook 3.6).
 */
test.describe.configure({ mode: "serial" });

const FLAG = "ff_ops_ai";
const EMAIL = "e2e-ops-ai@example.com";
const OWNER = demoStaffEmail("owner");
const QUESTION = "Which customers generated the most revenue this year?";
let personId = "";

async function reset(): Promise<void> {
  await e2eRows(sql`delete from feature_flags where key = ${FLAG}`);
  await e2eRows(sql`delete from nl_questions where question = ${QUESTION} and user_id in (select id from users where lower(email) = lower(${OWNER}))`);
  await e2eRows(sql`update persons set is_tester = true where email = ${EMAIL}`);
}

/** The test's customer with one paid order of EUR 950 today, so it tops this year's revenue. */
async function seed(): Promise<void> {
  const [existing] = await e2eRows<{ id: string }>(sql`select id::text as id from persons where email = ${EMAIL}`);
  const [person] = existing
    ? [existing]
    : await e2eRows<{ id: string }>(
        sql`insert into persons (email, first_name, last_name, locale, acquisition, is_tester)
            values (${EMAIL}, 'Vraag', 'Klant E2E', 'nl-BE', '{"source":"manual"}'::jsonb, false) returning id::text as id`,
      );
  personId = person!.id;
  await e2eRows(sql`update persons set is_tester = false where id = ${personId}::uuid`);
  await e2eRows(sql`insert into orders (person_id, channel, status, subtotal_cents, vat_cents, total_cents, locale, client_key, paid_at)
    select ${personId}::uuid, 'admin', 'paid', 95000, 16488, 95000, 'nl-BE', gen_random_uuid(), now()
    where not exists (select 1 from orders where person_id = ${personId}::uuid and paid_at >= date_trunc('year', now()))`);
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

test("asking for this year's top customers renders a table with person links", async ({ page }) => {
  test.setTimeout(180_000);
  await signInStaff(page, "owner", { returnTo: "/admin/dashboard/ask" });
  // Flags are cached for 60 s per server instance: reload until the screen is on.
  await expect
    .poll(
      async () => {
        await page.goto("/admin/dashboard/ask");
        return page.getByTestId("ops-ask").count();
      },
      { timeout: 90_000, intervals: [2_000, 5_000, 10_000] },
    )
    .toBe(1);

  await page.locator("#ask-question").fill(QUESTION);
  await clickAndWait(page, () => page.getByTestId("ask-form").getByRole("button").click());
  await page.waitForURL(/\/admin\/dashboard\/ask\?id=[0-9a-f-]{36}/);

  const answer = page.getByTestId("ask-answer");
  await expect(answer).toHaveAttribute("data-status", "answered");
  await expect(page.getByTestId("ask-table")).toBeVisible();
  const links = page.getByTestId("ask-person-link");
  await expect(links.first()).toBeVisible();
  await expect(page.locator(`[data-testid="ask-person-link"][href="/admin/persons/${personId}"]`)).toHaveText("Vraag Klant E2E");

  const [stored] = await e2eRows<{ status: string; n: number }>(
    sql`select status::text as status, cardinality(ai_request_ids)::int as n from nl_questions where question = ${QUESTION} order by created_at desc limit 1`,
  );
  expect(stored).toMatchObject({ status: "answered" });
  expect(stored!.n).toBeGreaterThanOrEqual(1);
});
