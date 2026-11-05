import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { demoStaffEmail, signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";

/**
 * ops-P8 end to end (beam_dev with the demo seed): with `ff_ops_marketing` on for testers (the
 * owner listed), the owner opens `/admin/dashboard/management` and sees every tile group
 * (revenue, customers, sales mix, retention, B2B), then `/admin/reports/attribution` and finds
 * the test's own fake ad campaign with ROAS 3.00 (EUR 120 linear revenue over EUR 40 spend two
 * days ago). The person and the order are reused across runs (the person is a tester again
 * afterwards, so no report counts it); the flag row, the campaign's spend row and its
 * attribution credits are reset before and after (runbook 3.6).
 */
test.describe.configure({ mode: "serial" });

const FLAG = "ff_ops_marketing";
const EMAIL = "e2e-ops-marketing@example.com";
const OWNER = demoStaffEmail("owner");
const CAMPAIGN_ID = "e2e_meta_roas";
const KEY = `meta|${CAMPAIGN_ID}`;
const CLIENT_KEY = "6f0f3f8e-7f53-4c3e-9a51-0e2e0e2e0e2e";

async function reset(): Promise<void> {
  await e2eRows(sql`delete from feature_flags where key = ${FLAG}`);
  await e2eRows(sql`delete from attribution_credits where campaign_key = ${KEY}`);
  await e2eRows(sql`delete from ad_spend_daily where platform = 'meta' and campaign_external_id = ${CAMPAIGN_ID}`);
  await e2eRows(sql`update persons set is_tester = true where email = ${EMAIL}`);
}

async function seed(): Promise<void> {
  const [existing] = await e2eRows<{ id: string }>(sql`select id::text as id from persons where email = ${EMAIL}`);
  const [person] = existing
    ? [existing]
    : await e2eRows<{ id: string }>(
        sql`insert into persons (email, first_name, last_name, locale, acquisition, is_tester)
            values (${EMAIL}, 'Marketing', 'Customer E2E', 'nl-BE', ${JSON.stringify({ source: "paid_meta", campaign: CAMPAIGN_ID, medium: "cpc" })}::jsonb, false)
            returning id::text as id`,
      );
  await e2eRows(sql`update persons set is_tester = false where id = ${person!.id}::uuid`);
  const [order] =
    (await e2eRows<{ id: string }>(sql`select id::text as id from orders where client_key = ${CLIENT_KEY}::uuid`)).length > 0
      ? await e2eRows<{ id: string }>(sql`select id::text as id from orders where client_key = ${CLIENT_KEY}::uuid`)
      : await e2eRows<{ id: string }>(
          sql`insert into orders (person_id, channel, status, subtotal_cents, discount_cents, vat_cents, total_cents, locale, client_key, paid_at)
              values (${person!.id}::uuid, 'admin', 'paid', 12000, 0, 2083, 12000, 'nl-BE', ${CLIENT_KEY}::uuid, now() - interval '2 days')
              returning id::text as id`,
        );
  await e2eRows(sql`insert into attribution_credits (order_id, person_id, model, campaign_key, source, medium, campaign, weight, revenue_cents, paid_at, computed_at)
    select ${order!.id}::uuid, ${person!.id}::uuid, m::attribution_credits_model, ${KEY}, 'meta', 'cpc', ${CAMPAIGN_ID}, 1, 12000, now() - interval '2 days', now()
    from unnest(array['first_touch', 'linear']) m`);
  await e2eRows(sql`insert into ad_spend_daily (platform, account_id, campaign_external_id, campaign_name, day_on, spend_cents, impressions, clicks, leads, raw, pulled_at)
    values ('meta', 'act_e2e', ${CAMPAIGN_ID}, 'E2E ROAS campaign', ((now() at time zone 'Europe/Brussels')::date - 2), 4000, 1000, 40, 2, '{}'::jsonb, now())`);
  const [owner] = await e2eRows<{ id: string }>(sql`select id::text as id from users where lower(email) = lower(${OWNER})`);
  await e2eRows(sql`insert into feature_flags (key, state, user_ids) values (${FLAG}, 'testers', array[${owner!.id}::uuid])`);
}

/** Flags are cached for 60 s per server instance: reload until the screen is on. */
async function openWhenOn(page: Page, path: string, testId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto(path);
        return page.getByTestId(testId).count();
      },
      { timeout: 90_000, intervals: [2_000, 5_000, 10_000] },
    )
    .toBe(1);
}

test.beforeAll(async () => {
  await reset();
  await seed();
});
test.afterAll(async () => {
  await reset();
  await closeE2eDb();
});

test("the management dashboard renders every tile group", async ({ page }) => {
  test.setTimeout(180_000);
  await signInStaff(page, "owner", { returnTo: "/admin/dashboard/management" });
  await openWhenOn(page, "/admin/dashboard/management", "management-dashboard");
  for (const group of ["revenue", "customers", "sales", "retention", "b2b"]) {
    await expect(page.getByTestId(`mgmt-group-${group}`)).toBeVisible();
  }
  await expect(page.getByTestId("mgmt-tile-net")).toBeVisible();
  await expect(page.getByTestId("mgmt-tile-customers-new")).toBeVisible();
  await expect(page.getByTestId("mgmt-tile-retention-repeat_purchase_rate")).toBeVisible();
  await expect(page.getByTestId("mgmt-tile-b2b-pipeline")).toBeVisible();
});

test("attribution shows the fake campaign's ROAS", async ({ page }) => {
  test.setTimeout(180_000);
  await signInStaff(page, "owner", { returnTo: "/admin/reports/attribution" });
  await openWhenOn(page, "/admin/reports/attribution", "attribution-report");
  const row = page.locator(`[data-testid="attribution-row"][data-campaign-key="${KEY}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("attribution-roas")).toHaveAttribute("data-value", "3");
  await expect(page.getByTestId("attribution-data-as-of")).toBeVisible();
});
