import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bookings, sessionTemplates, waitlistEntries } from "@beam/db/schema";
import { claimToken, deriveClaimKey, hashToken } from "@beam/core/booking";
import { makePerson, makeProduct, makeSession } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import { expectAccessible } from "./support/a11y";
import { demoStaffEmail, signInCustomer, signInStaff } from "./support/auth";
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
 * Sections "customer portal" and "V1 acceptance (booking)" (booking-P6): a new customer
 * registers by magic link, accepts the terms on the first booking, buys the 5-day package with
 * the fake provider, books a day session with a credit ("x sessions remaining"), cancels inside
 * the rules and gets the credit back, and the timeline holds both facts; a single session is
 * bought with a promotion code; a night is booked with a shared-bed guest after entering an
 * emergency contact; a booking is rescheduled; a lead is refused a member-only session;
 * `/account/book?template=<id>` opens that template's tab filtered to it; an order-paid booking
 * lands on `/account/checkout/<orderId>`; axe scans of the portal pages and the claim page.
 * The acceptance items "customer can book, pay and cancel", "administrator can change a
 * booking", "the same person cannot take a second seat", "claim window expires" and "confirmed
 * seat is protected" are covered here and referenced from `e2e/acceptance-v1.spec.ts`. Rows are
 * marked `E2E booking-portal` and reset before and after.
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
  // A day session running now: started 20 minutes ago, inside the default check-in window, but
  // never before Brussels midnight, since the desk lists the sessions starting on today's date.
  const now = Date.now();
  const brusselsTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now);
  const [h, m, s] = brusselsTime.split(":").map(Number);
  const sinceMidnight = ((h! * 60 + m!) * 60 + s!) * 1000;
  const startsAt = new Date(now - Math.min(20 * MIN, sinceMidnight));
  const session = await makeSession(db, { title, startsAt, publishedAt: new Date(now - 60 * MIN), capacitySeats: 10 });
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

// ---------------------------------------------------------------------------
// booking-P6: customer portal, claim page and the booking acceptance items
// ---------------------------------------------------------------------------

const PORTAL = "E2E booking-portal";
const DAY_MS = 24 * 60 * MIN;
const here = path.dirname(fileURLToPath(import.meta.url));

type Catalogue = { booking: Record<string, Record<string, string>> };
const catalogues: Catalogue[] = (["nl-BE", "fr-BE", "en"] as const).map(
  (l) => JSON.parse(readFileSync(path.join(here, `../../../packages/core/src/i18n/messages/${l}/booking.json`), "utf8")) as Catalogue,
);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A booking catalogue text in any of the three locales (staff accounts may use any). */
const anyLocale = (screen: string, key: string) => new RegExp(catalogues.map((c) => escapeRe(c.booking[screen]![key]!)).join("|"));

type Portal = {
  productId: string;
  templateId: string;
  creditDayId: string;
  creditDay2Id: string;
  paidDayId: string;
  nightId: string;
  memberOnlyId: string;
  templateSessionId: string;
  fullId: string;
  promoCode: string;
};
let pf: Portal;

const title = (tag: string) => ({ "nl-BE": `${PORTAL} ${tag}`, "fr-BE": `${PORTAL} ${tag}`, en: `${PORTAL} ${tag}` });

async function resetPortalRows(): Promise<void> {
  await e2eRows(sql`delete from waitlist_entries where session_id in (select id from sessions where title->>'en' like ${`${PORTAL}%`})`);
  await e2eRows(sql`update bookings set status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'staff', reserved_until = null, version = version + 1
    where status in ('reserved', 'confirmed') and session_id in (select id from sessions where title->>'en' like ${`${PORTAL}%`})`);
  await e2eRows(sql`update sessions set status = 'cancelled', cancelled_at = now(), cancel_reason = 'e2e reset' where status <> 'cancelled' and title->>'en' like ${`${PORTAL}%`}`);
  await e2eRows(sql`update session_templates set is_active = false where is_active and name->>'en' like ${`${PORTAL}%`}`);
  await e2eRows(sql`update promotions set is_active = false where is_active and code like 'E2EPORTAL%'`);
}

/** `d` days from now at `hourUtc`: inside the free cancellation window of day sessions. */
const inDays = (d: number, hourUtc = 10) => {
  const t = new Date(Date.now() + d * DAY_MS);
  t.setUTCHours(hourUtc, 0, 0, 0);
  return t;
};

async function createPortalFixture(): Promise<Portal> {
  const db = await e2eDb();
  const published = new Date(Date.now() - 60 * MIN);
  const product = await makeProduct(db, { kind: "session", priceCents: 2_500 });
  const creditDay = await makeSession(db, { title: title("credit day"), startsAt: inDays(3), publishedAt: published, capacitySeats: 8 });
  const creditDay2 = await makeSession(db, { title: title("credit day 2"), startsAt: inDays(4), publishedAt: published, capacitySeats: 8 });
  const paidDay = await makeSession(db, { title: title("paid day"), startsAt: inDays(5), publishedAt: published, capacitySeats: 8, creditKind: null, productId: product.id });
  const night = await makeSession(db, { kind: "night", title: title("night"), startsAt: inDays(6, 19), publishedAt: published, capacityBeds: 4, productId: product.id });
  const memberOnly = await makeSession(db, { title: title("members"), startsAt: inDays(7), publishedAt: published, isMemberOnly: true });
  const full = await makeSession(db, { title: title("full"), startsAt: inDays(8), publishedAt: published, capacitySeats: 1 });
  const holder = await makePerson(db, { firstName: "E2E", lastName: "Portal holder", email: uniqueEmail("booking-portal-holder") });
  await db.insert(bookings).values({ sessionId: full.id, personId: holder.id, status: "confirmed", paidWith: "free", source: "admin" });
  // An active template whose own occurrences start in 2099, so the scheduler materialises nothing.
  const [template] = await db
    .insert(sessionTemplates)
    .values({ kind: "night", name: title("template"), weekdays: [1, 2, 3, 4, 5, 6, 7], startTime: "21:00", durationMinutes: 720, capacityBeds: 4, creditKind: "night", activeFromOn: "2099-01-01" })
    .returning();
  const templateSession = await makeSession(db, { kind: "night", title: title("template night"), startsAt: inDays(9, 20), publishedAt: published, templateId: template!.id, templateVersion: 1 });
  const promoCode = `E2EPORTAL${Date.now().toString(36).toUpperCase()}`;
  // promotions.created_by_user_id is required: the demo owner creates the code.
  await e2eRows(sql`insert into promotions (code, name, kind, value, applies_to, starts_at, is_active, created_by_user_id)
    values (${promoCode}, ${JSON.stringify(title("promo"))}::jsonb, 'percent', 20, ${JSON.stringify({ product_ids: [product.id], product_kinds: [] })}::jsonb, now() - interval '1 hour', true,
      (select id from users where lower(email) = ${demoStaffEmail("owner").toLowerCase()}))`);
  return {
    productId: product.id,
    templateId: template!.id,
    creditDayId: creditDay.id,
    creditDay2Id: creditDay2.id,
    paidDayId: paidDay.id,
    nightId: night.id,
    memberOnlyId: memberOnly.id,
    templateSessionId: templateSession.id,
    fullId: full.id,
    promoCode,
  };
}

const personIdOf = async (email: string) => (await e2eRows<{ id: string }>(sql`select id from persons where email = ${email}`))[0]?.id;
const liveBookingOf = async (personId: string, sessionId: string) =>
  (
    await e2eRows<{ id: string; status: string; paid_with: string }>(sql`
    select id, status::text as status, paid_with::text as paid_with from bookings
    where person_id = ${personId} and session_id = ${sessionId} order by created_at desc limit 1`)
  )[0];

/** Ticks the terms box when the form shows it, submits the booking form and waits for the action's POST. */
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

async function payWithFake(page: Page): Promise<void> {
  await page.waitForURL(/\/api\/dev\/fake-pay\//);
  await page.getByTestId("fake-pay-paid").click();
  await page.waitForURL(/\/checkout\/return\//);
  await expect(page.locator('[data-return-phase="paid"]')).toBeVisible({ timeout: 35_000 });
}

async function payOrderPage(page: Page): Promise<void> {
  // The URL changes before the page renders: wait for Pay, so the terms box is counted on the page.
  const pay = page.getByRole("button", { name: /Pay/ });
  await expect(pay).toBeVisible();
  const terms = page.locator("#accept-terms");
  if ((await terms.count()) > 0) await terms.check();
  const posted = page.waitForResponse((r) => r.request().method() === "POST");
  await pay.click();
  await posted;
  await payWithFake(page);
}

test.describe("customer portal", () => {
  const email = uniqueEmail("booking-portal");

  test.beforeAll(async () => {
    await resetPortalRows();
    pf = await createPortalFixture();
  });

  test.afterAll(async () => {
    await resetPortalRows();
  });

  test("a new customer registers by magic link, buys a package, books with a credit, cancels and gets the credit back", async ({ page }) => {
    await signInCustomer(page, email, "en");
    await page.goto("/en/account/shop/PKG-5-DAYS");
    await page.getByRole("button", { name: /Buy now/i }).click();
    await page.waitForURL(/\/en\/account\/checkout\?checkout=/);
    await payOrderPage(page);

    await page.goto(`/en/account/book/${pf.creditDayId}`);
    await expect(page.getByTestId("book-form")).toBeVisible();
    await expect(page.getByText(/5 sessions remaining/)).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page);
    await page.getByTestId("pay-credit").check();
    await submitBooking(page);
    await page.waitForURL(/\/en\/account\/bookings\/[0-9a-f-]+\?done=booked/);
    await expect(page.getByTestId("booking-status")).toHaveText("Confirmed");
    await expect(page.getByTestId("qr-card")).toBeVisible();
    await expectAccessible(page);

    await page.goto(`/en/account/book/${pf.creditDay2Id}`);
    await expect(page.getByText(/4 sessions remaining/)).toBeVisible();

    await page.goto("/en/account/bookings");
    await expect(page.getByTestId("bookings-list")).toContainText(`${PORTAL} credit day`);
    await expectAccessible(page);

    const personId = (await personIdOf(email))!;
    const booking = (await liveBookingOf(personId, pf.creditDayId))!;
    await page.goto(`/en/account/bookings/${booking.id}`);
    await page.getByTestId("cancel-booking").locator("summary").click();
    await expect(page.getByTestId("cancel-outcome")).toHaveText(/goes back to your package/);
    const cancelled = page.waitForResponse((r) => r.request().method() === "POST");
    await page.getByTestId("cancel-confirm").click();
    await cancelled;
    await page.waitForURL(/\?done=cancelled/);
    await expect(page.getByTestId("booking-cancelled")).toBeVisible();
    expect((await liveBookingOf(personId, pf.creditDayId))?.status).toBe("cancelled");

    await page.goto(`/en/account/book/${pf.creditDay2Id}`);
    await expect(page.getByText(/5 sessions remaining/)).toBeVisible();
    // The timeline holds both facts.
    const facts = await e2eRows<{ kind: string }>(sql`select kind from activity_events where person_id = ${personId} and kind in ('booking.confirmed', 'booking.cancelled')`);
    expect(new Set(facts.map((f) => f.kind))).toEqual(new Set(["booking.confirmed", "booking.cancelled"]));
  });

  test("a single session is bought with a promotion code and the order-paid booking lands on /account/checkout/<orderId>", async ({ page }) => {
    await signInCustomer(page, email, "en");
    await page.goto(`/en/account/book/${pf.paidDayId}`);
    await page.getByTestId("pay-order").check();
    await page.locator("#promoCode").fill(pf.promoCode);
    await submitBooking(page);
    await page.waitForURL(/\/en\/account\/checkout\/[0-9a-f-]+$/);
    await expectAccessible(page);
    const orderId = new URL(page.url()).pathname.split("/").pop()!;
    const [order] = await e2eRows<{ discount_cents: number; total_cents: number }>(sql`select discount_cents, total_cents from orders where id = ${orderId}`);
    expect(Number(order!.discount_cents)).toBe(500);
    expect(Number(order!.total_cents)).toBe(2_000);
    await payOrderPage(page);
    const personId = (await personIdOf(email))!;
    await expect.poll(async () => (await liveBookingOf(personId, pf.paidDayId))?.status, { timeout: 30_000 }).toBe("confirmed");
  });

  test("a night is booked with a shared-bed guest after entering an emergency contact", async ({ page }) => {
    await signInCustomer(page, email, "en");
    await page.goto(`/en/account/book/${pf.nightId}`);
    if ((await page.getByTestId("emergency-fields").count()) > 0) {
      await page.locator("#ec-name").fill("E2E Contact");
      await page.locator("#ec-phone").fill("+32 470 00 00 00");
    }
    await page.getByTestId("add-guest").click();
    await page.locator('input[name="guests.0.firstName"]').fill("E2E");
    await page.locator('input[name="guests.0.lastName"]').fill("Bed guest");
    await page.locator('input[name="guests.0.sharesBed"]').check();
    await page.locator('input[name="guests.0.payWith"][value="order"]').check();
    await page.getByTestId("pay-order").check();
    await submitBooking(page);
    await page.waitForURL(/\/en\/account\/checkout\/[0-9a-f-]+$/);
    await payOrderPage(page);
    const personId = (await personIdOf(email))!;
    await expect.poll(async () => (await liveBookingOf(personId, pf.nightId))?.status, { timeout: 30_000 }).toBe("confirmed");
    const [guest] = await e2eRows<{ capacity_units: number }>(sql`
      select g.capacity_units from bookings g join bookings o on o.id = g.guest_of_booking_id
      where o.person_id = ${personId} and o.session_id = ${pf.nightId} and g.status = 'confirmed'`);
    expect(Number(guest?.capacity_units)).toBe(0);
    const [contact] = await e2eRows<{ ec: { name?: string } | null }>(sql`select emergency_contact as ec from persons where id = ${personId}`);
    expect(contact?.ec?.name).toBeTruthy();
  });

  test("a booking is rescheduled to another session inside the free window", async ({ page }) => {
    // Sign-in, a credit booking, an axe scan and the reschedule: about 60 s on a loaded machine.
    test.setTimeout(2 * 60_000);
    await signInCustomer(page, email, "en");
    await page.goto(`/en/account/book/${pf.creditDayId}`);
    await page.getByTestId("pay-credit").check();
    await submitBooking(page);
    await page.waitForURL(/\/account\/bookings\/[0-9a-f-]+\?done=booked/);
    await page.getByTestId("reschedule-link").click();
    await page.waitForURL(/\/reschedule$/);
    await expectAccessible(page);
    await page.getByTestId(`target-${pf.creditDay2Id}`).locator("input").check();
    const posted = page.waitForResponse((r) => r.request().method() === "POST");
    await page.getByTestId("reschedule-confirm").click();
    await posted;
    await page.waitForURL(/\?done=rescheduled/);
    const personId = (await personIdOf(email))!;
    expect((await liveBookingOf(personId, pf.creditDay2Id))?.status).toBe("confirmed");
    expect((await liveBookingOf(personId, pf.creditDayId))?.status).toBe("cancelled");
  });

  test("a lead is refused a member-only session", async ({ page }) => {
    await signInCustomer(page, uniqueEmail("booking-portal-lead"), "en");
    await page.goto(`/en/account/book/${pf.memberOnlyId}`);
    await expect(page.getByTestId("session-state")).toHaveText("For members");
    await expect(page.getByTestId("book-form")).toHaveCount(0);
    await expectAccessible(page);
  });

  test("/account/book?template=<id> opens the template's tab filtered to it", async ({ page }) => {
    await signInCustomer(page, email, "en");
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(inDays(9, 20));
    await page.goto(`/en/account/book?template=${pf.templateId}&day=${day}`);
    await expect(page.getByTestId("book-tab-night")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("template-filter")).toBeVisible();
    await expect(page.getByTestId(`session-card-${pf.templateSessionId}`)).toBeVisible();
    await expect(page.getByTestId(`session-card-${pf.nightId}`)).toHaveCount(0);
    await expectAccessible(page);
    // An unknown id is ignored: the default tab, no filter chip.
    await page.goto("/en/account/book?template=00000000-0000-4000-8000-000000000000");
    await expect(page.getByTestId("book-tab-day")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("template-filter")).toHaveCount(0);
  });
});

test.describe("V1 acceptance (booking)", () => {
  const email = uniqueEmail("booking-acceptance");

  test.beforeAll(async () => {
    await resetPortalRows();
    pf = await createPortalFixture();
  });

  test.afterAll(async () => {
    await resetPortalRows();
  });

  test("the same person cannot take a second seat", async ({ page }) => {
    await signInCustomer(page, email, "en");
    for (let i = 0; i < 2; i++) {
      await page.goto(`/en/account/book/${pf.paidDayId}`);
      await page.getByTestId("pay-order").check();
      await submitBooking(page);
      await page.waitForURL((u) => u.pathname.includes("/account/checkout/") || u.searchParams.has("error"));
    }
    // The second submit returns the existing checkout or is refused; never a second live row.
    const personId = (await personIdOf(email))!;
    const [live] = await e2eRows<{ n: number }>(sql`
      select count(*)::int as n from bookings where person_id = ${personId} and session_id = ${pf.paidDayId} and status in ('reserved', 'confirmed')`);
    expect(Number(live?.n)).toBe(1);
  });

  test("the claim window expires and a confirmed seat is protected", async ({ page }) => {
    const db = await e2eDb();
    const key = deriveClaimKey(process.env.AUTH_SECRET ?? "");
    const person = await makePerson(db, { firstName: "E2E", lastName: "Claimer", email: uniqueEmail("booking-claim") });
    const [expired] = await db
      .insert(waitlistEntries)
      .values({ sessionId: pf.fullId, personId: person.id, state: "offered", offersCount: 1, offeredAt: new Date(Date.now() - 3 * 60 * MIN), offerExpiresAt: new Date(Date.now() - 60 * MIN) })
      .returning();
    const token = claimToken(key, expired!.id, 1);
    await e2eRows(sql`update waitlist_entries set claim_token_hash = ${hashToken(token)} where id = ${expired!.id}`);
    await page.goto(`/en/claim/${token}`);
    await expect(page.getByText(anyLocale("claim", "expired"))).toBeVisible();
    await expectAccessible(page);

    // A confirmed entry (its booking confirmed) shows "already claimed" and keeps the seat.
    const [holder] = await e2eRows<{ id: string; person_id: string }>(sql`
      select id, person_id from bookings where session_id = ${pf.fullId} and status = 'confirmed' limit 1`);
    const [confirmedEntry] = await db
      .insert(waitlistEntries)
      .values({ sessionId: pf.fullId, personId: holder!.person_id, state: "confirmed", offersCount: 1, bookingId: holder!.id })
      .returning();
    const confirmedToken = claimToken(key, confirmedEntry!.id, 1);
    await e2eRows(sql`update waitlist_entries set claim_token_hash = ${hashToken(confirmedToken)} where id = ${confirmedEntry!.id}`);
    await page.goto(`/en/claim/${confirmedToken}`);
    await expect(page.getByText(anyLocale("claim", "already_claimed"))).toBeVisible();
    await expectAccessible(page);
    const [row] = await e2eRows<{ status: string }>(sql`select status::text as status from bookings where id = ${holder!.id}`);
    expect(row?.status).toBe("confirmed");
  });

  test("an administrator can change a booking", async ({ page }) => {
    const db = await e2eDb();
    const person = await makePerson(db, { firstName: "E2E", lastName: "Changed", email: uniqueEmail("booking-admin-change") });
    const [b] = await db.insert(bookings).values({ sessionId: pf.creditDay2Id, personId: person.id, status: "confirmed", paidWith: "free", source: "admin" }).returning();
    await signInStaff(page, "customer_service", { returnTo: `/admin/bookings/${b!.id}` });
    await page.getByRole("button", { name: anyLocale("session", "cancel_booking") }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('textarea[name="reason"]').fill("E2E staff change");
    const posted = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
    await dialog.locator('button[type="submit"]').click();
    await posted;
    await expect
      .poll(async () => (await e2eRows<{ status: string }>(sql`select status::text as status from bookings where id = ${b!.id}`))[0]?.status)
      .toBe("cancelled");
  });
});
