import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { bookings } from "@beam/db/schema";
import { makePerson, makeProduct, makeSession } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import { expectAccessible } from "./support/a11y";
import { signInStaff } from "./support/auth";
import { closeE2eDb, e2eDb, e2eRows } from "./support/db";
import { uniqueEmail } from "./support/ids";

/**
 * booking end to end (booking spec 4.8, 5.4, 12): part of the post-deploy smoke suite.
 *
 * Section "reception check-in" (booking-P4): the demo reception user opens the QR URL of a
 * booking (`/admin/bookings/checkin?c=<code>`), checks the guest in, scans a second code through
 * the desk's field, sees "To pay" with the POS link on an unpaid pay-at-desk row, and the desk
 * passes an axe scan. The spec creates its own session, people, order and bookings (titles and
 * emails marked `E2E booking-checkin`) and cancels its sessions before and after, so shared demo
 * rows are never touched. Selectors use ids and data attributes, not the copy, because the demo
 * staff accounts may use any of the three locales.
 *
 * The portal, claim-page and waitlist sections are added by booking-P5 and booking-P6.
 */
test.describe.configure({ mode: "serial" });

const MARK = "E2E booking-checkin";
const MIN = 60_000;

type Fixture = { sessionId: string; confirmedId: string; confirmedCode: string; scannedId: string; scannedCode: string; deskId: string; deskOrderId: string };
let fx: Fixture;

/** Cancels every session this spec created earlier (their bookings then leave the desk). */
async function resetSharedRows(): Promise<void> {
  await e2eRows(sql`update bookings set status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'staff', version = version + 1
    where status in ('reserved', 'confirmed', 'attended', 'no_show') and session_id in (select id from sessions where title->>'en' like ${`${MARK}%`})`);
  await e2eRows(sql`update sessions set status = 'cancelled', cancelled_at = now(), cancel_reason = 'e2e reset' where status <> 'cancelled' and title->>'en' like ${`${MARK}%`}`);
}

async function createFixture(): Promise<Fixture> {
  const db = await e2eDb();
  const title = { "nl-BE": `${MARK} sessie`, "fr-BE": `${MARK} séance`, en: `${MARK} session` };
  // A day session running now: started 20 minutes ago, inside the default check-in window.
  const session = await makeSession(db, { title, startsAt: new Date(Date.now() - 20 * MIN), publishedAt: new Date(Date.now() - 60 * MIN), capacitySeats: 10 });
  const person = (tag: string) => makePerson(db, { firstName: "E2E", lastName: `Checkin ${tag}`, email: uniqueEmail(`booking-checkin-${tag}`) });
  const confirmed = (await db.insert(bookings).values({ sessionId: session.id, personId: (await person("qr")).id, status: "confirmed", paidWith: "free", source: "admin" }).returning())[0]!;
  const scanned = (await db.insert(bookings).values({ sessionId: session.id, personId: (await person("scan")).id, status: "confirmed", paidWith: "free", source: "admin" }).returning())[0]!;
  // An unpaid pay-at-desk row: an admin order of 45.00 expiring at the session's end (R63).
  const deskPerson = await person("desk");
  const product = await makeProduct(db, { kind: "session", priceCents: 4_500 });
  const order = await makeOrder(db, { personId: deskPerson.id, channel: "admin", status: "pending_payment", expiresAt: session.endsAt, subtotalCents: 4_500 });
  const line = await makeOrderLine(db, { orderId: order.id, productId: product.id, productKind: "session", sessionId: session.id, unitAmountCents: 4_500 });
  const desk = (
    await db
      .insert(bookings)
      .values({ sessionId: session.id, personId: deskPerson.id, status: "reserved", paidWith: "order", orderLineId: line.id, reservedUntil: session.endsAt, isPayAtDesk: true, source: "admin" })
      .returning()
  )[0]!;
  return { sessionId: session.id, confirmedId: confirmed.id, confirmedCode: confirmed.checkinCode, scannedId: scanned.id, scannedCode: scanned.checkinCode, deskId: desk.id, deskOrderId: order.id };
}

const statusOf = async (id: string) => (await e2eRows<{ status: string }>(sql`select status::text as status from bookings where id = ${id}`))[0]?.status;

/** Clicks a button that runs a Server Action and waits for the action's POST response. */
async function clickAndWait(page: Page, selector: string): Promise<void> {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await page.locator(selector).click();
  await response;
}

test.beforeAll(async () => {
  await resetSharedRows();
  fx = await createFixture();
});

test.afterAll(async () => {
  await resetSharedRows();
  await closeE2eDb();
});

test.describe("reception check-in", () => {
  test("the QR URL opens the booking on the desk and the guest is checked in", async ({ page }) => {
    await signInStaff(page, "reception", { returnTo: `/admin/bookings/checkin?c=${fx.confirmedCode}` });
    await expect(page).toHaveURL(/\/admin\/bookings\/checkin\?c=/);
    const card = page.locator(`section[data-booking-id="${fx.confirmedId}"]`);
    await expect(card).toHaveAttribute("data-status", "confirmed");
    await expectAccessible(page);

    await clickAndWait(page, `section[data-booking-id="${fx.confirmedId}"] [data-action="check-in"]`);
    await expect.poll(() => statusOf(fx.confirmedId)).toBe("attended");
    await expect(card).toHaveAttribute("data-status", "attended");
    // A checked-in row offers the undo, never a second check-in.
    await expect(card.locator('[data-action="check-in"]')).toHaveCount(0);
    await expect(card.locator('[data-action="undo"]')).toBeVisible();
  });

  test("a code typed or scanned into the desk field opens its card and keeps the field focused", async ({ page }) => {
    await signInStaff(page, "reception", { returnTo: "/admin/bookings/checkin" });
    const field = page.locator("#checkin-scan");
    await expect(field).toBeFocused();
    await field.fill(fx.scannedCode.toLowerCase());
    await field.press("Enter");
    await expect(page).toHaveURL(/\?q=/);
    await expect(page.locator(`section[data-booking-id="${fx.scannedId}"]`)).toHaveAttribute("data-status", "confirmed");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("");
    await clickAndWait(page, `section[data-booking-id="${fx.scannedId}"] [data-action="check-in"]`);
    await expect.poll(() => statusOf(fx.scannedId)).toBe("attended");
  });

  test("an unpaid pay-at-desk row shows To pay with the POS link and no check-in button", async ({ page }) => {
    await signInStaff(page, "reception", { returnTo: `/admin/bookings/checkin?b=${fx.deskId}` });
    const card = page.locator(`section[data-booking-id="${fx.deskId}"]`);
    await expect(card).toHaveAttribute("data-status", "reserved");
    await expect(card.locator('[data-testid="to-pay"]')).toContainText(/45[.,]00/);
    await expect(card.locator('[data-action="take-payment"]')).toHaveAttribute("href", `/admin/pos?order=${fx.deskOrderId}`);
    await expect(card.locator('[data-action="check-in"]')).toHaveCount(0);
    expect(await statusOf(fx.deskId)).toBe("reserved");
    await expectAccessible(page);
  });

  test("the desk lists today's session with the people not yet arrived and passes axe", async ({ page }) => {
    await signInStaff(page, "reception", { returnTo: "/admin/bookings/checkin" });
    const session = page.locator(`[data-session-id="${fx.sessionId}"]`);
    await expect(session).toBeVisible();
    await expect(session.locator(`a[data-booking-id="${fx.deskId}"]`)).toBeVisible();
    await expect(session.locator(`a[data-booking-id="${fx.confirmedId}"]`)).toHaveCount(0);
    await expectAccessible(page);
  });
});
