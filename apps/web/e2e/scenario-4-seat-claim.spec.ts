/**
 * Scenario 4: seat claim expiry (proposal section 11, booking spec R40-R47, booking-P5).
 *
 * A one-off free session with one seat, created by the spec with its own persons (unique
 * `@example.com` addresses), so no demo row is touched: B holds the seat, A and then B2 wait.
 * B cancels, the waitlist jobs (the local tick of DR-13 runs `waitlist.expire_offers` every
 * minute, whose safety net enqueues `waitlist.offer_next`) offer the seat to A by email; A's link
 * expires with a fake clock (its `offer_expires_at` is moved into the past), so B2 gets the offer
 * and claims it from the email link; A's old link shows "expired"; the confirmed seat survives a
 * forced `waitlist.expire_offers` run. The spec removes its rows before and after.
 */
import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { closeE2eDb, e2eRows } from "./support/db";
import { uniqueEmail } from "./support/ids";
import { latestEmail } from "./support/sink";
import { newCheckinCode } from "@beam/core/booking";

const TITLE = { "nl-BE": "Scenario 4 sessie", "fr-BE": "Scénario 4 séance", en: "Scenario 4 session" };
const TICK_WAIT = 150_000;

type Ids = { sessionId: string; a: string; b: string; b2: string; emails: { a: string; b: string; b2: string } };
let ids: Ids | null = null;

async function person(email: string, firstName: string): Promise<string> {
  const [row] = await e2eRows<{ id: string }>(sql`
    insert into persons (email, first_name, last_name, locale, is_tester, acquisition)
    values (${email}, ${firstName}, 'Scenario4', 'nl-BE', true, '{"source":"manual"}'::jsonb) returning id`);
  return row!.id;
}

async function cleanup(): Promise<void> {
  if (!ids) return;
  const { sessionId } = ids;
  await e2eRows(sql`delete from waitlist_entries where session_id = ${sessionId}`);
  await e2eRows(sql`update sessions set status = 'cancelled', cancelled_at = now(), cancel_reason = 'e2e scenario 4 cleanup' where id = ${sessionId} and status <> 'cancelled'`);
}

const entryOf = async (personId: string) =>
  (await e2eRows<{ id: string; state: string; ended_reason: string | null; booking_id: string | null }>(sql`
    select id, state, ended_reason, booking_id from waitlist_entries where session_id = ${ids!.sessionId} and person_id = ${personId}`))[0]!;

/** The claim link of the newest `booking.seat_offered` email to `to`. */
async function claimLink(to: string, after: Date): Promise<string> {
  const mail = await latestEmail(to, { after, timeoutMs: TICK_WAIT });
  const link = mail.links.find((l) => l.includes("/api/public/claim/"));
  expect(link, "seat_offered carries the claim link").toBeTruthy();
  return link!;
}

async function openClaim(page: Page, link: string): Promise<void> {
  const url = new URL(link);
  await page.goto(url.pathname);
  await page.waitForURL(/\/claim\//);
}

test.describe("Scenario 4: seat claim expiry (proposal section 11)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const emails = { a: uniqueEmail("s4-a"), b: uniqueEmail("s4-b"), b2: uniqueEmail("s4-b2") };
    const [session] = await e2eRows<{ id: string }>(sql`
      insert into sessions (kind, title, starts_at, ends_at, capacity_seats, credit_kind, credit_cost, published_at, claim_window_minutes)
      values ('day', ${JSON.stringify(TITLE)}::jsonb, now() + interval '2 days', now() + interval '2 days 2 hours', 1, null, 0, now() - interval '1 day', 120)
      returning id`);
    ids = { sessionId: session!.id, a: await person(emails.a, "Anna"), b: await person(emails.b, "Bert"), b2: await person(emails.b2, "Bea"), emails };
    await e2eRows(sql`insert into bookings (session_id, person_id, status, paid_with, source, checkin_code) values (${ids.sessionId}, ${ids.b}, 'confirmed', 'free', 'admin', ${newCheckinCode()})`);
    await e2eRows(sql`insert into waitlist_entries (session_id, person_id, joined_at) values (${ids.sessionId}, ${ids.a}, now() - interval '10 minutes')`);
    await e2eRows(sql`insert into waitlist_entries (session_id, person_id, joined_at) values (${ids.sessionId}, ${ids.b2}, now() - interval '5 minutes')`);
  });

  test.afterAll(async () => {
    await cleanup();
    await closeE2eDb();
  });

  test("B cancels, A is offered, A's link expires, B2 claims, A's old link is expired, the confirmed seat is protected", async ({ page }) => {
    test.setTimeout(6 * 60_000);
    const s = ids!;

    // B cancels: the seat is free, the waitlist offers it to A (first in the queue).
    const cancelledAt = new Date();
    await e2eRows(sql`update bookings set status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'customer' where session_id = ${s.sessionId} and person_id = ${s.b}`);
    const linkA = await claimLink(s.emails.a, cancelledAt);
    expect((await entryOf(s.a)).state).toBe("offered");
    expect((await entryOf(s.b2)).state).toBe("waiting");

    // Opening the link (as a mail scanner would) changes nothing.
    await openClaim(page, linkA);
    await expect(page.getByTestId("claim-live")).toBeVisible();
    expect((await entryOf(s.a)).state).toBe("offered");

    // Fake clock: A's claim window has passed. expire_offers expires it and B2 is offered.
    const expiredAt = new Date();
    await e2eRows(sql`update waitlist_entries set offer_expires_at = now() - interval '1 minute' where session_id = ${s.sessionId} and person_id = ${s.a}`);
    const linkB2 = await claimLink(s.emails.b2, expiredAt);
    await expect.poll(async () => (await entryOf(s.a)).state, { timeout: TICK_WAIT }).toBe("expired");
    expect((await entryOf(s.a)).ended_reason).toBe("offer_timeout");

    // A's old link shows "expired" and offers no claim button.
    await openClaim(page, linkA);
    await expect(page.getByTestId("claim-expired-text")).toBeVisible();
    await expect(page.getByTestId("claim-confirm")).toHaveCount(0);

    // B2 claims from the email link (a free seat: the token proves the person, no sign-in).
    await openClaim(page, linkB2);
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/claim/")),
      page.getByTestId("claim-confirm").click(),
    ]);
    expect(response.status()).toBeLessThan(500);
    await expect.poll(async () => (await entryOf(s.b2)).state, { timeout: 30_000 }).toBe("confirmed");
    const claimed = await entryOf(s.b2);
    const [booking] = await e2eRows<{ status: string; source: string }>(sql`select status, source from bookings where id = ${claimed.booking_id}`);
    expect(booking).toEqual({ status: "confirmed", source: "waitlist" });

    // A second open of B2's link says the seat is already claimed (one seat per person).
    await openClaim(page, linkB2);
    await expect(page.getByTestId("claim-claimed")).toBeVisible();

    // A forced expire_offers run (the confirmed entry's offer time is in the past) changes nothing.
    await e2eRows(sql`update waitlist_entries set offer_expires_at = now() - interval '1 hour' where id = ${claimed.id}`);
    const before = new Date();
    await expect
      .poll(async () => (await e2eRows<{ n: number }>(sql`select count(*)::int as n from jobs where kind = 'waitlist.expire_offers' and finished_at > ${before.toISOString()}::timestamptz`))[0]!.n, {
        timeout: TICK_WAIT,
      })
      .toBeGreaterThan(0);
    expect(await entryOf(s.b2)).toMatchObject({ state: "confirmed", booking_id: claimed.booking_id });
    const [still] = await e2eRows<{ status: string }>(sql`select status from bookings where id = ${claimed.booking_id}`);
    expect(still!.status).toBe("confirmed");
  });
});
