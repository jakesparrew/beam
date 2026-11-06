/**
 * commerce-P5 customer shop and checkout against `beam_dev` with `PAYMENTS_FAKE=1` (the runtime
 * payments fake and its hosted page `/api/dev/fake-pay/<id>`):
 * - a customer buys the 5-day package and gets 5 day sessions ("customer can pay", "package
 *   balance updates");
 * - a member sees the member price automatically ("member discount works");
 * - a guest buys a gift voucher on the site;
 * - a booking-created order is paid on `/account/checkout/[orderId]`;
 * - axe finds no serious or critical issue on the shop, checkout and return pages (rule 56).
 * commerce-P7 front desk and refunds:
 * - reception sells the 5-day package at `/admin/pos` by cash and prints the receipt (axe on the
 *   POS screen, rule 56);
 * - finance refunds that unused package from `/admin/orders/[id]/refund`;
 * - a customer withdraws an unused online package within 14 days (rule 54).
 * The buyer is a fresh customer per run, registered by the magic link of the first sign-in: a
 * shared demo customer runs into the magic-link limit (5 an hour, PL-68) across runs and
 * parallel servers. The demo seed has no member either, so the member test buys the monthly
 * membership as another fresh customer. Rows this spec creates are its own people, orders and
 * checkouts.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { expectAccessible } from "./support/a11y";
import { signInCustomer, signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";
import { uniqueEmail } from "./support/ids";

const PACKAGE_SKU = "PKG-5-DAYS";
const MEMBERSHIP_SKU = "MEMBER-MONTHLY";
const BUYER = uniqueEmail("commerce-buyer");

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
    // The demo seed has no member, so a fresh customer becomes one by buying the monthly membership.
    const member = uniqueEmail("commerce-member");
    const [prices] = await e2eRows<{ base: number }>(sql`
      select v.amount_cents as base from price_versions v join products pr on pr.id = v.product_id
      where pr.sku = ${PACKAGE_SKU} and v.audience = 'public' order by v.version desc limit 1`);
    expect(prices, `a public price for ${PACKAGE_SKU}`).toBeTruthy();
    await signInCustomer(page, member, "en");
    await page.goto(`/en/account/shop/${MEMBERSHIP_SKU}`);
    await page.getByRole("button", { name: "Buy now" }).click();
    await page.waitForURL(/\/en\/account\/checkout\?checkout=/);
    await acceptAndPay(page);
    await payWithFake(page);
    await expect
      .poll(async () => {
        const [row] = await e2eRows<{ n: number }>(sql`
          select count(*)::int as n from memberships m join persons p on p.id = m.person_id where p.email = ${member} and m.status = 'active'`);
        return Number(row?.n ?? 0);
      }, { timeout: 30_000 })
      .toBe(1);
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
    // Signing in first registers the fresh buyer.
    await signInCustomer(page, BUYER, "nl");
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

test.describe.serial("front desk and refunds", () => {
  const POS_BUYER = "customer3@example.com";
  let posOrderId: string | null = null;

  test("reception sells a package by cash and prints the receipt", async ({ page }) => {
    const [buyer] = await e2eRows<{ id: string }>(sql`select id from persons where email = ${POS_BUYER}`);
    const [product] = await e2eRows<{ id: string; amount: number }>(sql`
      select pr.id, v.amount_cents as amount from products pr join v_product_current_prices v on v.product_id = pr.id and v.audience = 'public'
      where pr.sku = ${PACKAGE_SKU}`);
    test.skip(!buyer || !product, "demo buyer or package missing");
    const before = await dayUnits(POS_BUYER);
    await signInStaff(page, "reception", { returnTo: "/admin/pos" });
    await page.goto("/admin/pos?tab=package");
    await expectAccessible(page);
    await page.locator(`a[href*="${product!.id}"]`).first().click();
    await page.waitForURL(/items=/);
    await page.getByLabel(/Zoek op naam|Search by name|Rechercher par nom/).fill(POS_BUYER);
    await page.getByRole("button", { name: /^(Zoeken|Search|Rechercher)$/ }).click();
    await page.getByRole("link", { name: new RegExp(POS_BUYER.replace(/[.]/g, "\\.")) }).click();
    await page.waitForURL(/personId=/);
    await page.getByRole("radio", { name: /^(Contant|Cash|Espèces)$/ }).check();
    await page.getByLabel(/Ontvangen contant geld|Cash received|Espèces reçues/).fill(String(Number(product!.amount) / 100));
    await expectAccessible(page);
    const posted = page.waitForResponse((r) => r.request().method() === "POST");
    await page.getByRole("button", { name: /Betaling ontvangen|Take payment|Encaisser/ }).click();
    await posted;
    await page.waitForURL(/\/admin\/pos\?done=/);
    await expect(page.locator('[data-pos-result="paid"]')).toBeVisible();
    posOrderId = new URL(page.url()).searchParams.get("done");
    const [order] = await e2eRows<{ status: string; channel: string }>(sql`select status::text as status, channel::text as channel from orders where id = ${posOrderId}`);
    expect(order).toEqual({ status: "paid", channel: "pos" });
    await expect.poll(() => dayUnits(POS_BUYER), { timeout: 30_000 }).toBe(before + 5);

    await page.getByRole("link", { name: /Kasticket afdrukken|Print receipt|Imprimer le ticket/ }).click();
    await page.waitForURL(/\/admin\/pos\/receipt\//);
    await expect(page.locator("#receipt-title")).toBeVisible();
    await expectAccessible(page);
  });

  test("staff refunds an unused package", async ({ page }) => {
    test.skip(!posOrderId, "the POS sale did not run");
    await signInStaff(page, "finance", { returnTo: `/admin/orders/${posOrderId}/refund` });
    await page.goto(`/admin/orders/${posOrderId}/refund`);
    await page.locator('input[name^="include_"]').first().check();
    await page.locator('input[name="reason"]').fill("Customer changed their mind");
    const posted = page.waitForResponse((r) => r.request().method() === "POST");
    await page.getByRole("button", { name: /Terugbetaling bevestigen|Confirm refund|Confirmer le remboursement/ }).click();
    await posted;
    await expect.poll(async () => {
      const [row] = await e2eRows<{ status: string }>(sql`select status::text as status from orders where id = ${posOrderId}`);
      return row?.status ?? null;
    }, { timeout: 30_000 }).toBe("refunded");
    const [refund] = await e2eRows<{ status: string; amount: number }>(sql`select status::text as status, amount_cents as amount from refunds where order_id = ${posOrderId}`);
    // A cash refund is paid at the counter at once.
    expect(refund?.status).toBe("refunded");
  });

  test("customer withdraws an unused package within 14 days", async ({ page }) => {
    await signInCustomer(page, BUYER, "nl");
    await page.goto(`/nl/account/shop/${PACKAGE_SKU}`);
    await page.getByRole("button", { name: "Nu kopen" }).click();
    await page.waitForURL(/\/nl\/account\/checkout\?checkout=/);
    await acceptAndPay(page);
    await payWithFake(page);
    const orderId = page.url().match(/\/checkout\/return\/([0-9a-f-]{36})/)?.[1];
    expect(orderId).toBeTruthy();
    await expect.poll(async () => {
      const [row] = await e2eRows<{ status: string }>(sql`select status::text as status from orders where id = ${orderId}`);
      return row?.status ?? null;
    }, { timeout: 30_000 }).toBe("paid");

    await page.goto(`/nl/account/orders/${orderId}#withdrawal`);
    await expect(page.getByRole("heading", { name: "Deze aankoop herroepen" })).toBeVisible();
    await expectAccessible(page);
    await page.locator('input[name="confirm"]').check();
    const posted = page.waitForResponse((r) => r.request().method() === "POST");
    await page.getByRole("button", { name: "Herroepen" }).click();
    await posted;
    await expect(page.getByText("Je herroeping is geregistreerd.", { exact: false })).toBeVisible();
    const [refund] = await e2eRows<{ n: number }>(sql`select count(*)::int as n from refunds where order_id = ${orderId}`);
    expect(Number(refund?.n ?? 0)).toBeGreaterThan(0);
  });
});
