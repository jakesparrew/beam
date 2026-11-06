/**
 * Scenario 1: late-entry email skip (proposal section 11; automation A-16 to A-19, A-39, A-41,
 * decision 15; automation-P6). Runs at the wave checkpoint against beam_dev with the demo seed.
 *
 * A new customer (unique `@example.com` address) books a free event session that starts 48 hours
 * later, the same gap as a Friday 10:00 booking for a Sunday 10:00 event. The server runs on the
 * real clock (it cannot be frozen from the browser), so the spec sets the gap instead of the
 * weekday: every due time is relative to the session start. The local tick (DR-13) runs the
 * evaluator every minute; the seeded `event-registration` journey (reminders 7 days, 3 days and
 * 3 hours before the start) enrols the person on `booking.confirmed`, which proves:
 *
 * - the sink holds booking's `booking.booking_confirmed` email (key `booking:<id>:confirmed`);
 * - the automation log has `entered`, then `skipped_late_entry` for `reminder_7d` and
 *   `reminder_3d` with their due times (start minus 7 and 3 days) and `scheduled` for
 *   `reminder_day_of` at start minus 3 hours; the person page timeline shows the same rows;
 * - with a fake clock (the enrolment's `next_step_at` moved to now, as scenario 4 moves an offer
 *   expiry; the session start and the anchor stay), the day-of reminder is `sent` and its email
 *   reaches the sink;
 * - no other email reaches that person after the booking.
 *
 * The spec creates its own session (title marked `E2E scenario 1`) and person, cancels its
 * sessions before and after, and never edits a demo row.
 */
import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { makeSession } from "@beam/db/testing";
import { signInCustomer, signInStaff } from "./support/auth";
import { closeE2eDb, e2eDb, e2eRows } from "./support/db";
import { uniqueEmail } from "./support/ids";
import { latestEmail } from "./support/sink";

const MARK = "E2E scenario 1";
const TICK_WAIT = 150_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test.describe.configure({ mode: "serial" });

type Fixture = { sessionId: string; startsAt: Date };
let fx: Fixture | null = null;
let journeyActive = false;

async function resetRows(): Promise<void> {
  await e2eRows(sql`update bookings set status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'staff', version = version + 1
    where status in ('reserved', 'confirmed') and session_id in (select id from sessions where title->>'en' like ${`${MARK}%`})`);
  await e2eRows(sql`update sessions set status = 'cancelled', cancelled_at = now(), cancel_reason = 'e2e reset' where status <> 'cancelled' and title->>'en' like ${`${MARK}%`}`);
}

const one = async <T>(query: Parameters<typeof e2eRows>[0]): Promise<T | undefined> => (await e2eRows<T>(query))[0];

async function poll<T>(read: () => Promise<T | undefined>, timeout = TICK_WAIT): Promise<T> {
  let value: T | undefined;
  await expect
    .poll(
      async () => {
        value = await read();
        return value !== undefined;
      },
      { timeout, intervals: [1000] },
    )
    .toBe(true);
  return value!;
}

type Run = { step_key: string | null; outcome: string; reason: string | null; due_at: string | null; occurred_at: string };
const runsOf = (enrolmentId: string) =>
  e2eRows<Run>(sql`select step_key, outcome::text as outcome, reason, data->>'due_at' as due_at, occurred_at from automation_runs where enrolment_id = ${enrolmentId} order by occurred_at, created_at`);

test.beforeAll(async () => {
  await resetRows();
  const [journey] = await e2eRows<{ status: string }>(sql`select status::text as status from automations where slug = 'event-registration'`);
  journeyActive = journey?.status === "active";
  const db = await e2eDb();
  const startsAt = new Date(Math.ceil((Date.now() + 2 * DAY) / 60_000) * 60_000);
  const title = { "nl-BE": `${MARK} event`, "fr-BE": `${MARK} événement`, en: `${MARK} event` };
  const session = await makeSession(db, { kind: "event", title, startsAt, endsAt: new Date(startsAt.getTime() + 2 * HOUR), publishedAt: new Date(Date.now() - HOUR), capacitySeats: 20, creditKind: null, productId: null });
  fx = { sessionId: session.id, startsAt };
});

test.afterAll(async () => {
  await resetRows();
  await closeE2eDb();
});

test("a registrant 48 hours before an event gets the confirmation and the day-of reminder only; 7d and 3d are logged as skipped_late_entry", async ({ page, browser }) => {
  test.setTimeout(8 * 60_000);
  test.skip(!journeyActive, "the demo seed has no active event-registration journey");
  const { sessionId, startsAt } = fx!;
  const email = uniqueEmail("scenario-1");

  // The customer books the free event in the portal.
  await signInCustomer(page, email, "en");
  // The cut-off on the database clock, after the sign-in: "now minus 1 s" on this process's clock
  // still counted the magic-link email when the sign-in took under a second.
  const [{ at: bookedAtRaw }] = (await e2eRows<{ at: string | Date }>(sql`select now() as at`)) as [{ at: string | Date }];
  const bookedAt = new Date(bookedAtRaw);
  await page.goto(`/en/account/book/${sessionId}`);
  await expect(page.getByTestId("book-form")).toBeVisible();
  await page.getByTestId("pay-free").check();
  const terms = page.getByTestId("accept-terms");
  if ((await terms.count()) > 0) await terms.check();
  const posted = page.waitForResponse((r) => r.request().method() === "POST");
  await page.getByTestId("book-submit").click();
  await posted;
  await expect(page.getByTestId("booking-status")).toBeVisible({ timeout: 30_000 });

  const person = await poll(() => one<{ id: string }>(sql`select id from persons where lower(email) = ${email.toLowerCase()}`));
  const booking = await poll(() => one<{ id: string; status: string }>(sql`select id, status::text as status from bookings where person_id = ${person.id} and session_id = ${sessionId}`));
  expect(booking.status).toBe("confirmed");

  // Booking's confirmation is in the sink.
  await poll(() => one<{ id: string }>(sql`select id from email_messages where idempotency_key = ${`booking:${booking.id}:confirmed`} and rendered_file_id is not null`));
  await latestEmail(email, { after: bookedAt, timeoutMs: TICK_WAIT });

  // The evaluator enrols the person in event-registration with the session start as anchor.
  const enrolment = await poll(() =>
    one<{ id: string; anchor_at: string; next_step_key: string | null; next_step_at: string | null }>(sql`
      select e.id, e.anchor_at, e.next_step_key, e.next_step_at from automation_enrolments e join automations a on a.id = e.automation_id
      where a.slug = 'event-registration' and e.person_id = ${person.id} and e.subject_key = ${`booking:${booking.id}`}`),
  );
  expect(new Date(enrolment.anchor_at).getTime()).toBe(startsAt.getTime());
  expect(enrolment.next_step_key).toBe("reminder_day_of");
  expect(new Date(enrolment.next_step_at!).getTime()).toBe(startsAt.getTime() - 3 * HOUR);

  const entryRuns = await runsOf(enrolment.id);
  // The entry runs share one timestamp (A-19), so they are compared as a set.
  expect(entryRuns.map((r) => `${r.step_key ?? "-"}:${r.outcome}`).sort()).toEqual(
    ["-:entered", "reminder_3d:skipped_late_entry", "reminder_7d:skipped_late_entry", "reminder_day_of:scheduled"].sort(),
  );
  const due = (key: string) => new Date(entryRuns.find((r) => r.step_key === key)!.due_at!).getTime();
  expect(due("reminder_7d")).toBe(startsAt.getTime() - 7 * DAY);
  expect(due("reminder_3d")).toBe(startsAt.getTime() - 3 * DAY);
  expect(due("reminder_day_of")).toBe(startsAt.getTime() - 3 * HOUR);

  // The person page timeline shows the entry and both skips with their due times.
  const staff = await browser.newPage();
  await signInStaff(staff, "marketing", { returnTo: `/admin/persons/${person.id}` });
  await staff.goto(`/admin/persons/${person.id}`);
  const timeline = staff.getByTestId("automation-timeline");
  await expect(timeline).toBeVisible();
  await expect(timeline.locator('[data-run-outcome="entered"]').first()).toBeVisible();
  for (const key of ["reminder_7d", "reminder_3d"]) {
    const row = timeline.locator(`[data-run-outcome="skipped_late_entry"][data-step="${key}"]`);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(new Date(due(key)).toISOString().slice(0, 16));
  }

  // Fake clock: the day-of reminder becomes due now; the tick sends it.
  const madeDueAt = new Date();
  await e2eRows(sql`update automation_enrolments set next_step_at = now() where id = ${enrolment.id} and status = 'active'`);
  const sent = await poll(() =>
    one<{ email_message_id: string }>(sql`select email_message_id from automation_runs where enrolment_id = ${enrolment.id} and step_key = 'reminder_day_of' and outcome = 'sent'`),
  );
  await poll(() => one<{ id: string }>(sql`select id from email_messages where id = ${sent.email_message_id} and rendered_file_id is not null`));
  await latestEmail(email, { after: madeDueAt, timeoutMs: TICK_WAIT });
  await expect.poll(async () => (await one<{ status: string }>(sql`select status::text as status from automation_enrolments where id = ${enrolment.id}`))?.status, { timeout: TICK_WAIT }).toBe("completed");

  // Exactly the confirmation and the day-of reminder reached the sink after the booking.
  const delivered = await e2eRows<{ key: string }>(sql`
    select idempotency_key as key from email_messages
    where lower(to_email) = ${email.toLowerCase()} and rendered_file_id is not null and created_at >= ${bookedAt.toISOString()}::timestamptz
    order by created_at`);
  expect(delivered.map((d) => d.key)).toEqual([`booking:${booking.id}:confirmed`, `automation:${enrolment.id}:reminder_day_of`]);

  await staff.reload();
  await expect(staff.getByTestId("automation-timeline").locator('[data-run-outcome="sent"][data-step="reminder_day_of"]')).toHaveCount(1);
  await staff.close();
});
