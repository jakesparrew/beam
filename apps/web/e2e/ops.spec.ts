import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";

/**
 * ops-P3 end to end (beam_dev with the demo seed): staff with MFA open the action dashboard and
 * its week view; a paid Mollie order (the rows the fake Mollie webhook leaves behind: a `paid`
 * order with its line and a `paid` mollie payment) appears in today's revenue tile, which is the
 * V1 acceptance item "reports reflect the transaction". The test's own person, order and
 * payment are removed before and after (runbook 3.6). Selectors use test ids and data
 * attributes, not the copy (the demo accounts use any of the locales).
 */
test.describe.configure({ mode: "serial" });

// A fresh person per run: paid orders, their payments and invoices are financial records the
// database protects from deletion, so the spec never cleans them up (it adds one more each run).
const EMAIL = `e2e-ops-revenue-${Date.now()}@example.com`;
const AMOUNT = 12_345;

async function reset(): Promise<void> {
  // Nothing to remove: EMAIL is new for every run.
}

/** A paid admin order of a new non-tester person with one package line, and its paid Mollie payment. */
async function payOrder(): Promise<string> {
  const [product] = await e2eRows<{ id: string; sku: string; name: unknown }>(sql`select id, sku, name from products where kind = 'package' and is_active order by sku limit 1`);
  expect(product, "a seeded package product").toBeTruthy();
  const [person] = await e2eRows<{ id: string }>(
    sql`insert into persons (email, first_name, last_name, locale, is_tester) values (${EMAIL}, 'E2E', 'Revenue', 'nl-BE', false) returning id`,
  );
  const vat = Math.round((AMOUNT * 21) / 121);
  const [order] = await e2eRows<{ id: string }>(sql`
    insert into orders (person_id, channel, status, subtotal_cents, vat_cents, total_cents, locale, client_key, paid_at)
    values (${person!.id}::uuid, 'admin', 'paid', ${AMOUNT}, ${vat}, ${AMOUNT}, 'nl-BE', gen_random_uuid(), now()) returning id`);
  await e2eRows(sql`
    insert into order_lines (order_id, line_no, product_id, product_kind, sku, description, quantity, unit_amount_cents, discount_cents,
                             line_total_cents, vat_rate_pct, vat_cents, pricing_trace)
    values (${order!.id}::uuid, 1, ${product!.id}::uuid, 'package', ${product!.sku}, ${JSON.stringify(product!.name)}::jsonb, 1, ${AMOUNT}, 0,
            ${AMOUNT}, 21, ${vat}, '{}'::jsonb)`);
  await e2eRows(sql`
    insert into payments (order_id, provider, provider_payment_id, status, amount_cents, paid_at)
    values (${order!.id}::uuid, 'mollie', ${`tr_e2eops${Date.now()}`}, 'paid', ${AMOUNT}, now())`);
  return order!.id;
}

const tileValue = async (page: Page) => Number(await page.getByTestId("revenue-tile-day").getAttribute("data-value"));

test.beforeAll(reset);
test.afterAll(async () => {
  await reset();
  await closeE2eDb();
});

test("staff with MFA open the action dashboard and switch to the week view", async ({ page }) => {
  await signInStaff(page, "owner", { returnTo: "/admin/dashboard" });
  await expect(page).toHaveURL(/\/admin\/dashboard/);
  await expect(page.locator('[data-testid^="action-card-"]').first()).toBeVisible();
  await expect(page.getByTestId("action-card-overdue_tasks")).toBeVisible();
  await page.getByTestId("dashboard-view").locator("a").nth(1).click();
  await expect(page).toHaveURL(/view=week/);
  await expect(page.locator('[data-testid^="action-card-"]').first()).toBeVisible();
});

test("a paid Mollie order appears in today's revenue (reports reflect the transaction)", async ({ page }) => {
  await signInStaff(page, "finance", { returnTo: "/admin/reports/revenue?period=day" });
  await expect(page).toHaveURL(/\/admin\/reports\/revenue/);
  const before = await tileValue(page);
  await payOrder();
  await page.reload();
  await expect.poll(() => tileValue(page)).toBe(before + AMOUNT);
  const csv = await page.request.get("/admin/reports/revenue/csv?period=day&vat=incl");
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain("package");
});
