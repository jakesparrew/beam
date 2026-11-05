/**
 * Scenario 3: lead vs customer event access (proposal section 11, booking spec 3.4, R20-R27;
 * booking-P7). Runs with `ff_booking_lead_priority` on for testers (the spec's own persons are
 * testers; the flag row is restored afterwards).
 *
 * The spec creates its own free Lead Magnet event (3 seats, 2 reserved for leads, the general
 * seat already taken) and its own persons with unique `@example.com` addresses, so no demo row is
 * touched:
 * 1. status comes from paid transactions (`v_person_status`), and a staff override is kept;
 * 2. during the lead window the lead books a reserved seat in the portal;
 * 3. a customer sees "Opens for you on <date and time>" and the customer-queue button instead of
 *    a booking button that fails, and joins the customer queue;
 * 4. at window end (fake clock: `lead_window_end_at` moved into the past) the local tick's
 *    `waitlist.expire_offers` releases the remaining reserved seat to the customer queue with the
 *    `booking.lead_window_open` email; at `opens_for_public_at` the rest opens to everyone.
 * The spec removes its rows before and after.
 */
import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { closeE2eDb, e2eRows, pgArray } from "./support/db";
import { uniqueEmail } from "./support/ids";
import { signInCustomer } from "./support/auth";
import { latestEmail } from "./support/sink";
import { newCheckinCode } from "@beam/core/booking";

const TITLE = { "nl-BE": "Scenario 3 lezing", "fr-BE": "Scénario 3 conférence", en: "Scenario 3 lecture" };
const FLAG = "ff_booking_lead_priority";
const TICK_WAIT = 150_000;

type Ids = { sessionId: string; lead: string; customer: string; other: string; publicLead: string; emails: Record<"lead" | "customer" | "other" | "publicLead", string> };
let ids: Ids | null = null;
let previousFlag: { state: string; user_ids: string[]; person_ids: string[] } | null = null;

async function person(email: string, firstName: string): Promise<string> {
  const [row] = await e2eRows<{ id: string }>(sql`
    insert into persons (email, first_name, last_name, locale, is_tester, acquisition)
    values (${email}, ${firstName}, 'Scenario3', 'nl-BE', true, '{"source":"manual"}'::jsonb) returning id`);
  return row!.id;
}

/** A paid portal order with one package line: the person becomes a customer (D28). */
async function buyPackage(personId: string): Promise<void> {
  const [product] = await e2eRows<{ id: string; sku: string }>(sql`select id, sku from products where kind = 'package' order by created_at limit 1`);
  expect(product, "the demo data has a package product").toBeTruthy();
  const [order] = await e2eRows<{ id: string }>(sql`
    insert into orders (person_id, channel, status, subtotal_cents, vat_cents, total_cents, locale, client_key, paid_at, terms_version_id)
    values (${personId}, 'admin', 'paid', 9000, 1562, 9000, 'nl-BE', gen_random_uuid()::text, now(), null) returning id`);
  await e2eRows(sql`
    insert into order_lines (order_id, line_no, product_id, product_kind, sku, description, quantity, unit_amount_cents, line_total_cents, vat_rate_pct, vat_cents, pricing_trace)
    values (${order!.id}, 1, ${product!.id}, 'package', ${product!.sku}, '{"nl-BE":"Pakket","fr-BE":"Forfait","en":"Package"}'::jsonb, 1, 9000, 9000, 21.00, 1562, '{"e2e":true}'::jsonb)`);
}

const statusOf = async (personId: string) => (await e2eRows<{ status: string }>(sql`select status from v_person_status where person_id = ${personId}`))[0]!.status;
const entryOf = async (personId: string) =>
  (await e2eRows<{ id: string; queue: string; state: string }>(sql`select id, queue, state from waitlist_entries where session_id = ${ids!.sessionId} and person_id = ${personId}`))[0];

async function cleanup(): Promise<void> {
  if (!ids) return;
  await e2eRows(sql`update waitlist_entries set booking_id = null where session_id = ${ids.sessionId}`);
  await e2eRows(sql`delete from waitlist_entries where session_id = ${ids.sessionId}`);
  await e2eRows(sql`update sessions set status = 'cancelled', cancelled_at = now(), cancel_reason = 'e2e scenario 3 cleanup' where id = ${ids.sessionId} and status <> 'cancelled'`);
}

test.describe("Scenario 3: lead vs customer event access (proposal section 11)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const [flag] = await e2eRows<{ state: string; user_ids: string[]; person_ids: string[] }>(sql`select state, user_ids, person_ids from feature_flags where key = ${FLAG}`);
    previousFlag = flag ?? null;
    await e2eRows(sql`
      insert into feature_flags (key, state) values (${FLAG}, 'testers')
      on conflict (key) do update set state = case when feature_flags.state = 'on' then 'on'::feature_flags_state else 'testers'::feature_flags_state end`);

    const emails = { lead: uniqueEmail("s3-lead"), customer: uniqueEmail("s3-customer"), other: uniqueEmail("s3-other"), publicLead: uniqueEmail("s3-public") };
    const [session] = await e2eRows<{ id: string }>(sql`
      insert into sessions (kind, event_category, title, starts_at, ends_at, capacity_seats, credit_kind, credit_cost, published_at,
                            is_lead_magnet, lead_reserved_seats, lead_window_start_at, lead_window_end_at, lead_release_rule, public_release_at, claim_window_minutes)
      values ('event', 'lecture', ${JSON.stringify(TITLE)}::jsonb, now() + interval '5 days', now() + interval '5 days 2 hours', 3, null, 0, now() - interval '1 day',
              true, 2, now() - interval '1 hour', now() + interval '2 days', 'customers_then_public', now() + interval '3 days', 120)
      returning id`);
    ids = {
      sessionId: session!.id,
      lead: await person(emails.lead, "Lena"),
      customer: await person(emails.customer, "Carl"),
      other: await person(emails.other, "Olga"),
      publicLead: await person(emails.publicLead, "Pim"),
      emails,
    };
    await buyPackage(ids.customer);
    await buyPackage(ids.other);
    // The general seat is taken: only the two lead seats are left.
    await e2eRows(sql`insert into bookings (session_id, person_id, status, paid_with, source, checkin_code) values (${ids.sessionId}, ${ids.other}, 'confirmed', 'free', 'admin', ${newCheckinCode()})`);
  });

  test.afterAll(async () => {
    await cleanup();
    if (previousFlag) {
      await e2eRows(sql`update feature_flags set state = ${previousFlag.state}::feature_flags_state, user_ids = ${pgArray(previousFlag.user_ids)}::uuid[], person_ids = ${pgArray(previousFlag.person_ids)}::uuid[] where key = ${FLAG}`);
    } else {
      await e2eRows(sql`delete from feature_flags where key = ${FLAG}`);
    }
    await closeE2eDb();
  });

  test("Status is derived from paid transactions; a staff override is never overwritten", async () => {
    const s = ids!;
    expect(await statusOf(s.lead)).toBe("lead");
    expect(await statusOf(s.customer)).toBe("customer");
    const overridden = await person(uniqueEmail("s3-override"), "Otto");
    await e2eRows(sql`update persons set status_override = 'lead', status_override_reason = 'e2e scenario 3 correction' where id = ${overridden}`);
    await buyPackage(overridden);
    expect(await statusOf(overridden)).toBe("lead");
  });

  test("On a Lead Magnet event, reserved seats are bookable only by leads during the lead window", async ({ page }) => {
    const s = ids!;
    await signInCustomer(page, s.emails.lead, "nl");
    await page.goto(`/nl/account/book/${s.sessionId}`);
    await expect(page.getByTestId("book-form")).toBeVisible();
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/account/book/${s.sessionId}`)),
      page.getByTestId("book-submit").click(),
    ]);
    expect(response.status()).toBeLessThan(500);
    await page.waitForURL(/\/account\/bookings\//);
    const [row] = await e2eRows<{ status: string; used_lead_seat: boolean }>(sql`select status, used_lead_seat from bookings where session_id = ${s.sessionId} and person_id = ${s.lead}`);
    expect(row).toEqual({ status: "confirmed", used_lead_seat: true });
  });

  test("Customers see 'Opens for you on <date and time>' instead of a failing button", async ({ page }) => {
    const s = ids!;
    await signInCustomer(page, s.emails.customer, "nl");
    await page.goto(`/nl/account/book/${s.sessionId}`);
    await expect(page.getByTestId("session-state")).toContainText("Opent voor jou op");
    await expect(page.getByTestId("book-submit")).toHaveCount(0);
    const join = page.getByTestId("join-waitlist");
    await expect(join).toHaveText(/klantenwachtrij|wachtrij voor klanten/i);
    const [response] = await Promise.all([page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/account/book/${s.sessionId}`)), join.click()]);
    expect(response.status()).toBeLessThan(500);
    await expect(page.getByTestId("waitlist-joined")).toBeVisible();
    expect(await entryOf(s.customer)).toMatchObject({ queue: "customer", state: "waiting" });
  });

  test("At the release moment the remaining seats open to the customer queue, then to the public", async () => {
    test.setTimeout(6 * 60_000);
    const s = ids!;
    // A lead without a seat waits in the public part of the order (staff-added, lead queue).
    await e2eRows(sql`insert into waitlist_entries (session_id, person_id, queue, joined_at) values (${s.sessionId}, ${s.publicLead}, 'lead', now() - interval '30 minutes')`);

    // Fake clock: the lead window has ended; the public opening is still ahead.
    const releasedAt = new Date();
    await e2eRows(sql`update sessions set lead_window_end_at = now() - interval '1 minute', public_release_at = now() + interval '1 day' where id = ${s.sessionId}`);
    const mail = await latestEmail(s.emails.customer, { after: releasedAt, timeoutMs: TICK_WAIT });
    expect(mail.links.some((l) => l.includes("/api/public/claim/"))).toBe(true);
    await expect.poll(async () => (await entryOf(s.customer))?.state, { timeout: TICK_WAIT }).toBe("offered");
    expect((await entryOf(s.publicLead))?.state).toBe("waiting");

    // Fake clock: the public opening has passed, so the waiting lead gets the next free seat.
    await e2eRows(sql`update waitlist_entries set state = 'released', ended_reason = 'declined' where session_id = ${s.sessionId} and person_id = ${s.customer}`);
    await e2eRows(sql`update sessions set public_release_at = now() - interval '1 minute' where id = ${s.sessionId}`);
    await expect.poll(async () => (await entryOf(s.publicLead))?.state, { timeout: TICK_WAIT }).toBe("offered");
  });
});
