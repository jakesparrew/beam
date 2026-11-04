/**
 * commerce-P5 customer shop and checkout against `beam_dev` with `PAYMENTS_FAKE=1` (the runtime
 * payments fake and its hosted page `/api/dev/fake-pay/<id>`):
 * - a customer buys the 5-day package and gets 5 day sessions ("customer can pay", "package
 *   balance updates");
 * - a member sees the member price automatically ("member discount works");
 * - a guest buys a gift voucher on the site;
 * - a booking-created order is paid on `/account/checkout/[orderId]`;
 * - axe finds no serious or critical issue on the shop, checkout and return pages (rule 56).
 * Demo customers `customer1..5@example.com` have portal users; the member is the person with an
 * active membership in the demo seed. Rows this spec creates are its own orders and checkouts.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { expectAccessible } from "./support/a11y";
import { signInCustomer } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";
import { uniqueEmail } from "./support/ids";

const PACKAGE_SKU = "PKG-5-DAYS";
const BUYER = "customer2@example.com";

test.afterAll(async () => {
  await closeE2eDb();
});

/** Pays on the fake provider page and waits for the return page to show the paid state. */
async function payWithFake(page: Page): Promise<void> {
  await page.waitForURL(/\/api\/dev\/fake-pay\//);
  await page.getByTestId("fake-pay-paid").click();
  await page.waitForURL(/\/checkout\/return\//);
  await expect(page.locator('[data-return-phase="paid"]')).toBeVisible({ timeout: 35_000 });
}

/** Fills the terms checkbox and clicks Pay, waiting for the action's POST to finish. */
async function acceptAndPay(page: Page): Promise<void> {
  await page.locator("#accept-terms").check();
  const posted = page.waitForResponse((r) => r.request().method() === "POST");
  await page.getByRole("button", { name: /Betaal|Pay|Payer/ }).click();
  await posted;
}

async function dayUnits(email: string): Promise<number> {
  const [row] = await e2eRows<{ units: number | string | null }>(sql`
    select coalesce(sum(g.units_granted), 0) as units from credit_grants g join persons p on p.id = g.person_id
    where p.email = ${email} and g.credit_kind = 'day' and g.source = 'purchase'`);
  return Number(row?.units ?? 0);
}

test.describe("customer shop and checkout", () => {
  test("customer buys the 5-day package with the fake provider and gets 5 sessions", async ({ page }) => {
    const before = await dayUnits(BUYER);
    await signInCustomer(page, BUYER, "nl");
    await page.goto(`/nl/account/shop/${PACKAGE_SKU}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Nu kopen" }).click();
    await page.waitForURL(/\/nl\/account\/checkout\?checkout=/);
    await expectAccessible(page);
    await acceptAndPay(page);
    await payWithFake(page);
    await expectAccessible(page);
    await expect.poll(() => dayUnits(BUYER), { timeout: 30_000 }).toBe(before + 5);
    const credits = await page.goto("/nl/account/credits");
    if (credits?.status() === 200) await expect(page.getByText(/5/).first()).toBeVisible();
  });

  test("a member sees the member price automatically", async ({ page }) => {
    const [member] = await e2eRows<{ email: string }>(sql`
      select p.email from memberships m join persons p on p.id = m.person_id join users u on u.person_id = p.id
      where m.status = 'active' and p.email is not null order by p.email limit 1`);
    test.skip(!member, "no demo member with a portal user");
    const [prices] = await e2eRows<{ base: number }>(sql`
      select v.amount_cents as base from price_versions v join products pr on pr.id = v.product_id
      where pr.sku = ${PACKAGE_SKU} and v.audience = 'public' order by v.version desc limit 1`);
    await signInCustomer(page, member!.email, "en");
    await page.goto("/en/account/shop");
    await expectAccessible(page);
    const tile = page.locator("li", { has: page.getByRole("link", { name: /5 day sessions package/i }) });
    await expect(tile.getByText("Member price")).toBeVisible();
    await expect(tile.getByText(`Normal price €${(Number(prices!.base) / 100).toFixed(2)}`)).toBeVisible();
  });

  test("a guest buys a gift voucher on the site", async ({ page }) => {
    const buyer = uniqueEmail("gift-buyer");
    await page.goto("/en/gift");
    await expectAccessible(page);
    await page.getByLabel("Amount in euro").fill("40");
    await page.getByLabel("Recipient's name").fill("Gift Recipient");
    await page.getByLabel(/Recipient's email/).fill(uniqueEmail("gift-recipient"));
    await page.getByLabel("Your email address").fill(buyer);
    await page.getByRole("button", { name: "Buy voucher" }).click();
    await page.waitForURL(/\/en\/checkout\?checkout=/);
    await expect(page.getByText("€40.00").first()).toBeVisible();
    await expectAccessible(page);
    await acceptAndPay(page);
    await payWithFake(page);
    await expect.poll(async () => {
      const [row] = await e2eRows<{ status: string }>(sql`
        select v.status::text as status from vouchers v join persons p on p.id = v.purchaser_person_id where p.email = ${buyer}`);
      return row?.status ?? null;
    }, { timeout: 30_000 }).toBe("active");
  });

  test("a booking-created order is paid on /account/checkout/[orderId]", async ({ page }) => {
    // The order booking would create: a pending portal order with the current terms version.
    const [person] = await e2eRows<{ id: string }>(sql`select id from persons where email = ${BUYER}`);
    const [terms] = await e2eRows<{ id: string }>(sql`
      select v.version_id as id from v_legal_versions v where v.legal_key = 'terms' order by v.ordinal desc limit 1`);
    const [product] = await e2eRows<{ id: string; sku: string }>(sql`select id, sku from products where sku = 'MERCH-BOTTLE'`);
    test.skip(!person || !terms || !product, "demo person, terms or product missing");
    const orderId = randomUUID();
    await e2eRows(sql`
      insert into orders (id, reference, person_id, channel, status, subtotal_cents, discount_cents, vat_cents, total_cents, locale, client_key, expires_at, terms_version_id)
      values (${orderId}, ${`E2E-${orderId.slice(0, 8)}`}, ${person!.id}, 'portal', 'pending_payment', 2500, 0, 434, 2500, 'nl-BE', ${randomUUID()}, now() + interval '20 minutes', ${terms!.id})`);
    await e2eRows(sql`
      insert into order_lines (order_id, line_no, product_id, product_kind, sku, description, quantity, unit_amount_cents, discount_cents, line_total_cents, vat_rate_pct, vat_cents, pricing_trace, data)
      values (${orderId}, 1, ${product!.id}, 'item', ${product!.sku}, '{"nl-BE":"Drinkfles","fr-BE":"Gourde","en":"Water bottle"}'::jsonb, 1, 2500, 0, 2500, 21, 434, '{}'::jsonb, '{}'::jsonb)`);
    await signInCustomer(page, BUYER, "nl");
    await page.goto(`/nl/account/checkout/${orderId}`);
    await expect(page.getByText(/vastgehouden tot/)).toBeVisible();
    await expect(page.locator("#accept-terms")).toHaveCount(0);
    await expectAccessible(page);
    const posted = page.waitForResponse((r) => r.request().method() === "POST");
    await page.getByRole("button", { name: /Betaal/ }).click();
    await posted;
    await payWithFake(page);
    const [order] = await e2eRows<{ status: string }>(sql`select status::text as status from orders where id = ${orderId}`);
    expect(order?.status).toBe("paid");
  });
});
