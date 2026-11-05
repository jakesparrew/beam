import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { deriveVoucherCode, hashVoucherCode, voucherCodeLast4 } from "@beam/core/commerce";
import { makeProduct, makeSession } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import { vouchers } from "@beam/db/schema";
import { expectAccessible } from "./support/a11y";
import { signInCustomer, signInStaff } from "./support/auth";
import { closeE2eDb, e2eDb, e2eRows } from "./support/db";
import { uniqueEmail } from "./support/ids";

/**
 * credits end to end (credits spec section 12, credits-P7) against `beam_dev` with the fake Mollie
 * adapter (`PAYMENTS_FAKE=1`). V1 acceptance items "package balance updates", "member discount
 * works", "customer can cancel", "reporting reflects the transaction" and "data can be exported"
 * for this module:
 * - a new customer buys the 10-session package → "10 sessions remaining"; books a day session →
 *   9; cancels inside the window → 10;
 * - customer service adjusts −1 with a reason on `/admin/credits/grants/<id>` → the portal shows 9
 *   and the audit row exists; `/admin/credits` tiles show the outstanding value, which grew;
 * - the customer buys the monthly membership → "Member" badge and the member price in the shop;
 *   cancels at period end → the dialog states the end date, the page shows it after;
 * - a € 50 gift voucher is redeemed → "€ 50,00 store credit" (nl); part of an order is paid
 *   with it → the store credit is lowered;
 * - the privacy export of the test person contains the credits tables;
 * - role queries: progress bars by name with their text value, dialogs by role with focus
 *   returned on close, status badges with text; axe on the three portal pages and the admin
 *   grant page.
 * The reception flow (desk badge, POS package sale, booking with the new grant) waits for the
 * POS screen (commerce) and the desk's `DeskCreditsBadge` (credits `api.ts` re-export and the
 * booking desk), both open requests; it is marked `fixme` until they land.
 * The spec creates its own sessions (titles `E2E credits …`), voucher and customer, and resets its
 * sessions before and after.
 */
test.describe.configure({ mode: "serial" });

const MARK = "E2E credits";
const DAY_MS = 86_400_000;
const PACKAGE_SKU = "PKG-10-DAYS";
const MEMBERSHIP_SKU = "MEMBER-MONTHLY";
const email = uniqueEmail("credits-portal");

const here = path.dirname(fileURLToPath(import.meta.url));
type Catalogue = { credits: { admin: Record<string, Record<string, string>> } };
const catalogues: Catalogue[] = (["nl-BE", "fr-BE", "en"] as const).map(
  (locale) => JSON.parse(readFileSync(path.join(here, `../../../packages/core/src/i18n/messages/${locale}/credits.json`), "utf8")) as Catalogue,
);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A staff label in any of the three locales (demo staff may use any). */
const adminText = (screen: string, key: string) => new RegExp(`^(${catalogues.map((c) => escapeRe(c.credits.admin[screen]![key]!)).join("|")})$`);

type Fixture = { day1Id: string; day2Id: string; voucherCode: string };
let fx: Fixture;

const title = (tag: string) => ({ "nl-BE": `${MARK} ${tag}`, "fr-BE": `${MARK} ${tag}`, en: `${MARK} ${tag}` });
const inDays = (d: number) => {
  const t = new Date(Date.now() + d * DAY_MS);
  t.setUTCHours(10, 0, 0, 0);
  return t;
};

async function resetRows(): Promise<void> {
  await e2eRows(sql`update bookings set status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'staff', reserved_until = null, version = version + 1
    where status in ('reserved', 'confirmed') and session_id in (select id from sessions where title->>'en' like ${`${MARK}%`})`);
  await e2eRows(sql`update sessions set status = 'cancelled', cancelled_at = now(), cancel_reason = 'e2e reset' where status <> 'cancelled' and title->>'en' like ${`${MARK}%`}`);
}

async function createFixture(): Promise<Fixture> {
  const db = await e2eDb();
  const published = new Date(Date.now() - 60 * 60_000);
  const day1 = await makeSession(db, { title: title("day 1"), startsAt: inDays(3), publishedAt: published, capacitySeats: 8 });
  const day2 = await makeSession(db, { title: title("day 2"), startsAt: inDays(4), publishedAt: published, capacitySeats: 8 });
  // An active € 50 gift voucher of a paid voucher order; the code is derived like commerce does.
  const product = await makeProduct(db, { kind: "voucher", priceCents: 5_000 });
  const order = await makeOrder(db, { status: "paid", subtotalCents: 5_000 });
  const line = await makeOrderLine(db, { orderId: order.id, productId: product.id, productKind: "voucher", unitAmountCents: 5_000 });
  const [v] = await db.insert(vouchers).values({ orderLineId: line.id, amountCents: 5_000, status: "active", activatedAt: new Date(), expiresAt: new Date(Date.now() + 365 * DAY_MS) }).returning();
  const code = await deriveVoucherCode(`e2e-credits-${v!.id}`, v!.id);
  await db.update(vouchers).set({ codeHash: await hashVoucherCode(code), codeLast4: voucherCodeLast4(code) }).where(sql`id = ${v!.id}`);
  return { day1Id: day1.id, day2Id: day2.id, voucherCode: code };
}

const personIdOf = async (address: string) => (await e2eRows<{ id: string }>(sql`select id from persons where email = ${address} limit 1`))[0]?.id;

const dayGrantOf = async (personId: string) =>
  (
    await e2eRows<{ id: string }>(sql`select g.id from credit_grants g join products p on p.id = g.product_id
      where g.person_id = ${personId} and p.sku = ${PACKAGE_SKU} and g.status = 'active' order by g.created_at desc limit 1`)
  )[0]?.id;

const liabilityCents = async () => Number((await e2eRows<{ v: string | number | null }>(sql`select coalesce(sum(remaining_value_cents), 0) as v from v_credit_liability`))[0]?.v ?? 0);

async function payWithFake(page: Page): Promise<void> {
  await page.waitForURL(/\/api\/dev\/fake-pay\//);
  await page.getByTestId("fake-pay-paid").click();
  await page.waitForURL(/\/checkout\/return\//);
  await expect(page.locator('[data-return-phase="paid"]')).toBeVisible({ timeout: 35_000 });
}

/** Buys a product from its shop page: "Buy now", the terms box, Pay and the fake provider. */
async function buy(page: Page, sku: string, opts: { expectProvider?: boolean } = {}): Promise<void> {
  await page.goto(`/en/account/shop/${sku}`);
  await page.getByRole("button", { name: /Buy now/i }).click();
  await page.waitForURL(/\/en\/account\/checkout\?checkout=/);
  // The URL changes before the basket renders: wait for Pay, so the terms box is counted on the basket.
  const pay = page.getByRole("button", { name: /Pay/ });
  await expect(pay).toBeVisible();
  const terms = page.locator("#accept-terms");
  if ((await terms.count()) > 0) await terms.check();
  const posted = page.waitForResponse((r) => r.request().method() === "POST");
  await pay.click();
  await posted;
  if (opts.expectProvider !== false) await payWithFake(page);
}

async function submitBooking(page: Page): Promise<void> {
  // Wait for the rendered form before counting its terms box (a soft navigation renders later).
  const submit = page.getByTestId("book-submit");
  await expect(submit).toBeVisible();
  const terms = page.getByTestId("accept-terms");
  if ((await terms.count()) > 0) await terms.check();
  const posted = page.waitForResponse((r) => r.request().method() === "POST");
  await submit.click();
  await posted;
}

/** The progress bar of a package card, found by its accessible name. */
const packageBar = (page: Page) => page.getByRole("progressbar", { name: /^Usage of / }).first();

test.beforeAll(async () => {
  await resetRows();
  fx = await createFixture();
});

test.afterAll(async () => {
  await resetRows();
  await closeE2eDb();
});

test("package balance updates: buy 10 sessions, book one, cancel it", async ({ page }) => {
  // Sign-in, a purchase on the fake provider, a booking, a cancellation and two axe scans.
  test.setTimeout(2 * 60_000);
  const before = await liabilityCents();
  await signInCustomer(page, email, "en");
  await buy(page, PACKAGE_SKU);

  await page.goto("/en/account/packages");
  await expect(page.getByRole("heading", { level: 1, name: "My packages" })).toBeVisible();
  await expect(page.getByText("10 sessions remaining").first()).toBeVisible({ timeout: 30_000 });
  await expect(packageBar(page)).toHaveAttribute("aria-valuetext", "10 of 10 sessions remaining");
  await expectAccessible(page);
  expect(await liabilityCents()).toBeGreaterThan(before);

  await page.goto(`/en/account/book/${fx.day1Id}`);
  await page.getByTestId("pay-credit").check();
  await submitBooking(page);
  await page.waitForURL(/\/en\/account\/bookings\/[0-9a-f-]+\?done=booked/);
  await page.goto("/en/account/packages");
  await expect(packageBar(page)).toHaveAttribute("aria-valuetext", "9 of 10 sessions remaining");

  const personId = (await personIdOf(email))!;
  const grantId = (await dayGrantOf(personId))!;
  await page.goto(`/en/account/packages/${grantId}`);
  await expect(page.getByRole("table", { name: "Usage history of this package" })).toContainText(`${MARK} day 1`);
  await expect(page.getByRole("table").getByText("You")).toBeVisible();
  // The badge holds an aria-hidden glyph before its word, so match the badge, then its text.
  await expect(page.getByRole("table").locator('[data-attendance="upcoming"]')).toHaveText(/^\W*Upcoming$/);
  await expectAccessible(page);

  const [booking] = await e2eRows<{ id: string }>(sql`select id from bookings where person_id = ${personId} and session_id = ${fx.day1Id} order by created_at desc limit 1`);
  await page.goto(`/en/account/bookings/${booking!.id}`);
  await page.getByTestId("cancel-booking").locator("summary").click();
  const cancelled = page.waitForResponse((r) => r.request().method() === "POST");
  await page.getByTestId("cancel-confirm").click();
  await cancelled;
  await page.waitForURL(/\?done=cancelled/);
  await page.goto("/en/account/packages");
  await expect(packageBar(page)).toHaveAttribute("aria-valuetext", "10 of 10 sessions remaining");
  await page.goto(`/en/account/packages/${grantId}`);
  await expect(page.getByText("Returned on cancellation")).toBeVisible();
});

test("staff adjusts −1 with a reason: the portal shows 9, the audit row exists and the tiles show the value", async ({ page, browser }) => {
  const personId = (await personIdOf(email))!;
  const grantId = (await dayGrantOf(personId))!;
  const reason = `${MARK} correction ${Date.now()}`;
  await signInStaff(page, "customer_service", { returnTo: `/admin/credits/grants/${grantId}` });
  await page.goto(`/admin/credits/grants/${grantId}`);
  await expectAccessible(page);
  const trigger = page.getByRole("button", { name: adminText("adjust", "open") });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.locator('input[name="quantity"]').fill("-1");
  await dialog.locator('textarea[name="reason"]').fill(reason);
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await dialog.locator('button[type="submit"]').click();
  await posted;
  await expect(dialog).toBeHidden();
  await expect(page.getByText(reason)).toBeVisible();
  const audits = await e2eRows<{ n: number | string }>(sql`select count(*) as n from audit_log where action = 'credits.adjusted' and entity_id = ${grantId}`);
  expect(Number(audits[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);

  await page.goto("/admin/credits");
  const tiles = page.locator("section[aria-label]").first();
  await expect(tiles).toContainText(new RegExp(catalogues.map((c) => escapeRe(c.credits.admin.tiles!.value!)).join("|")));
  expect(await liabilityCents()).toBeGreaterThan(0);

  const customer = await browser.newPage();
  await signInCustomer(customer, email, "en");
  await customer.goto("/en/account/packages");
  await expect(packageBar(customer)).toHaveAttribute("aria-valuetext", "9 of 10 sessions remaining");
  await customer.goto(`/en/account/packages/${grantId}`);
  await expect(customer.getByText("Adjusted by BEAM")).toBeVisible();
  await expect(customer.getByText(reason)).toHaveCount(0);
  await customer.close();
});

test("member discount works and the customer can cancel at period end", async ({ page }) => {
  await signInCustomer(page, email, "en");
  await buy(page, MEMBERSHIP_SKU);
  await page.goto("/en/account/membership");
  await expect(page.getByRole("heading", { level: 1, name: "My membership" })).toBeVisible();
  await expect(page.getByTestId("member-badge")).toHaveText("Member", { timeout: 30_000 });
  await expect(page.getByTestId("membership-card").getByText("Active")).toBeVisible();
  await expectAccessible(page);

  await page.goto("/en/account/shop");
  await expect(page.getByText("Member price").first()).toBeVisible();

  await page.goto("/en/account/membership");
  const [m] = await e2eRows<{ end: Date }>(sql`select m.current_period_end_at as "end" from memberships m join persons p on p.id = m.person_id where p.email = ${email} and m.status = 'active'`);
  const endText = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "Europe/Brussels" }).format(new Date(m!.end));
  const cancel = page.getByRole("button", { name: "Cancel membership" });
  await cancel.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(endText);
  await dialog.getByRole("button", { name: "Keep my membership" }).click();
  await expect(dialog).toBeHidden();
  await expect(cancel).toBeFocused();

  await cancel.click();
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await page.getByRole("dialog").getByRole("button", { name: "Yes, cancel" }).click();
  await posted;
  await expect(page.getByTestId("membership-ends")).toHaveText(`Your membership ends on ${endText}.`);
  await expect(page.getByRole("button", { name: "Keep my membership" })).toBeVisible();
});

test("a gift voucher becomes store credit and pays part of an order", async ({ page }) => {
  await signInCustomer(page, email, "nl");
  await page.goto("/nl/account/packages");
  const card = page.getByTestId("store-credit-card");
  await card.getByLabel("Code van de cadeaubon").fill(fx.voucherCode);
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await card.getByRole("button", { name: "Inwisselen" }).click();
  await posted;
  await expect(page.getByTestId("store-credit-amount")).toHaveText(/€\s?50,00 tegoed/, { timeout: 30_000 });
  await expectAccessible(page);

  await page.goto("/en/account/packages");
  await expect(page.getByTestId("store-credit-amount")).toHaveText(/€\s?50\.00 store credit|€\s?50,00 store credit/);
  // The basket uses the store credit by default; the fake provider pays the rest.
  await buy(page, "PKG-5-DAYS");
  await page.goto("/en/account/packages");
  await expect(page.getByTestId("store-credit-amount")).not.toHaveText(/50[.,]00/, { timeout: 30_000 });
});

test("data can be exported: the privacy export of the test person contains the credits tables", async ({ page }) => {
  await signInCustomer(page, email, "en");
  await page.goto("/en/account/privacy");
  const posted = page.waitForResponse((r) => r.request().method() === "POST");
  await page.locator('form:has(input[name="op"][value="export"]) button[type="submit"]').click();
  await posted;
  const personId = (await personIdOf(email))!;
  let requestId: string | undefined;
  await expect
    .poll(
      async () => {
        const [r] = await e2eRows<{ id: string; status: string }>(sql`select id, status::text as status from privacy_requests where person_id = ${personId} and kind = 'export' order by created_at desc limit 1`);
        requestId = r?.id;
        return r?.status;
      },
      { timeout: 120_000 },
    )
    .toBe("done");
  const res = await page.request.get(`/en/account/privacy/${requestId}/download`);
  expect(res.status()).toBe(200);
  const body = await res.body();
  // The zip holds one CSV per key of credits' privacy export (`grants`, `entries`, ...), not per table.
  expect(body.subarray(0, 2).toString()).toBe("PK");
  expect(body.includes(Buffer.from("credits/grants.csv"))).toBe(true);
});

test("reception: the desk shows the credit badge, a package sold at the POS books at once", async ({ page }) => {
  test.fixme(true, "waits for commerce's POS screen and DeskCreditsBadge on booking's check-in desk (open requests)");
  await signInStaff(page, "reception", { returnTo: "/admin/bookings/checkin" });
  await expect(page.getByLabel(adminText("desk", "label"))).toBeVisible();
});
