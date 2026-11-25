import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { makeProduct, makeSession } from "@beam/db/testing";
import { expectAccessible } from "./support/a11y";
import { payCheckout } from "./support/acceptance-fixtures";
import { closeE2eDb, e2eDb, e2eRows } from "./support/db";
import { uniqueEmail } from "./support/ids";

/**
 * Booking without an account (owner's review 8): a visitor opens a day session on the site, gives
 * email, full name and phone (no password, no account), continues to the review-and-pay step
 * (`/checkout/pay/<orderId>`), pays on the fake provider page and lands on the guest return page,
 * which offers an account without requiring one. The booking is confirmed for the person of that
 * email. The spec creates its own session (title marked `E2E booking-guest`) and cancels it
 * before and after, so shared demo rows are never touched.
 */
test.describe.configure({ mode: "serial" });

const MARK = "E2E booking-guest";
let sessionId = "";

async function reset(): Promise<void> {
  await e2eRows(sql`update bookings set status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'staff', version = version + 1
    where status in ('reserved', 'confirmed') and session_id in (select id from sessions where title->>'en' like ${`${MARK}%`})`);
  await e2eRows(sql`update sessions set status = 'cancelled', cancelled_at = now(), cancel_reason = 'e2e reset' where status <> 'cancelled' and title->>'en' like ${`${MARK}%`}`);
}

test.beforeAll(async () => {
  await reset();
  const db = await e2eDb();
  const product = await makeProduct(db, { kind: "session", priceCents: 12_000 });
  const startsAt = new Date(Date.now() + 2 * 24 * 3_600_000);
  const session = await makeSession(db, {
    title: { "nl-BE": `${MARK} sessie`, "fr-BE": `${MARK} séance`, en: `${MARK} session` },
    startsAt,
    publishedAt: new Date(Date.now() - 3_600_000),
    productId: product.id,
    capacitySeats: 14,
  });
  sessionId = session.id;
});

test.afterAll(async () => {
  await reset();
  await closeE2eDb();
});

test("a visitor books and pays a session without an account", async ({ page }) => {
  const email = uniqueEmail("booking-guest");
  await page.goto(`/en/book/${sessionId}`);
  await expect(page.getByTestId("guest-book-form")).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("First name").fill("Guest");
  await page.getByLabel("Last name").fill("Booker");
  await page.getByLabel("Phone number").fill("+32 470 12 34 56");
  await page.getByTestId("pay-order").check();
  const terms = page.getByTestId("accept-terms");
  if ((await terms.count()) > 0) await terms.check();
  await page.getByTestId("guest-book-submit").click();
  await page.waitForURL(/\/en\/checkout\/pay\//);
  await expect(page.getByText("€120.00").first()).toBeVisible();
  await expectAccessible(page);
  await payCheckout(page);
  await expect(page.getByRole("link", { name: "Create my account" })).toBeVisible();

  await expect
    .poll(async () => {
      const [row] = await e2eRows<{ status: string }>(sql`
        select b.status::text as status from bookings b join persons p on p.id = b.person_id where p.email = ${email} and b.session_id = ${sessionId}`);
      return row?.status ?? null;
    }, { timeout: 30_000 })
    .toBe("confirmed");
});
