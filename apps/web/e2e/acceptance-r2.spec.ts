/**
 * The Release 2 acceptance checklist of proposal section 12 as one spec (platform-P13), plus the
 * abandoned-checkout recovery of the R2 scope (proposal section 2, commerce rules 49 to 52):
 *
 * Webinar (flag `ff_webinar_portal`; skipped while it is off):
 *   1. Registration is not attendance.
 *   2. Watch time is captured.
 *   3. Replay activity and replay polls are stored separately from live.
 * Lead-priority waitlist (flag `ff_booking_lead_priority` for testers, set and restored here):
 *   4. Lead and customer windows on a Lead Magnet event.
 *   5. A waiting lead who buys becomes a customer without losing a confirmed seat.
 * Abandoned checkout (flag `ff_commerce_checkout_recovery`, the seeded `abandoned-checkout`
 * journey; both switched on here for the run and restored after):
 *   6. The recovery email is sent once, its resume link brings the customer back, and the paid
 *      checkout is attributed to that email.
 *
 * The spec runs at the wave 18 checkpoint against a production build on `beam_dev` with the demo
 * seed and the provider fakes (runbook 3.6); coding agents only list it. It creates its own
 * webinars (slugs `e2e-accr2-*`), sessions (titles `E2E acceptance-r2 ...`) and persons
 * (`e2e+accr2-...@example.com`) and removes or cancels them before and after; demo rows are
 * never written. "Fake clock" steps move the spec's own rows (`last_activity_at`,
 * `lead_window_end_at`, `next_step_at`) instead of waiting. It waits for responses or specific
 * rows, never on a bare `role="alert"` (CONVENTIONS item 11). The module specs that go deeper are
 * mapped in `docs/plan/acceptance-r2.md`.
 */
import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { deriveAccessKey, signAccessToken } from "@beam/core/webinar";
import { signInCustomer, signInStaff } from "./support/auth";
import { closeE2eDb, e2eDb, e2eRows, pgArray } from "./support/db";
import { distinctEmail, uniqueEmail } from "./support/ids";
import { latestEmail } from "./support/sink";
import { buyPackage, copy, eventually, one, payCheckout, personIdOf } from "./support/acceptance-fixtures";
import { newCheckinCode } from "@beam/core/booking";

const stamp = Date.now().toString(36);
const MARK = "E2E acceptance-r2";
/** The local tick runs every job kind once a minute; a release or an email can take two ticks. */
const TICK_WAIT = 150_000;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type FlagRow = { state: string; user_ids: string[]; person_ids: string[] };

async function readFlag(key: string): Promise<FlagRow | null> {
  return (await one<FlagRow>(sql`select state::text as state, user_ids, person_ids from feature_flags where key = ${key}`)) ?? null;
}

/** Sets a flag to `state` unless it is already `on`; returns the previous row for `restoreFlag`. */
async function raiseFlag(key: string, state: "on" | "testers"): Promise<FlagRow | null> {
  const previous = await readFlag(key);
  await e2eRows(sql`insert into feature_flags (key, state) values (${key}, ${state}::feature_flags_state)
    on conflict (key) do update set state = case when feature_flags.state = 'on' then 'on'::feature_flags_state else ${state}::feature_flags_state end`);
  return previous;
}

async function restoreFlag(key: string, previous: FlagRow | null): Promise<void> {
  if (previous) {
    await e2eRows(sql`update feature_flags set state = ${previous.state}::feature_flags_state, user_ids = ${pgArray(previous.user_ids)}::uuid[], person_ids = ${pgArray(previous.person_ids)}::uuid[] where key = ${key}`);
  } else {
    await e2eRows(sql`delete from feature_flags where key = ${key}`);
  }
}

/** A tester person of this spec (unique `@example.com` address). */
async function testerPerson(email: string, firstName: string): Promise<string> {
  const [row] = await e2eRows<{ id: string }>(sql`
    insert into persons (email, first_name, last_name, locale, is_tester, acquisition)
    values (${email}, ${firstName}, 'AcceptanceR2', 'nl-BE', true, '{"source":"manual"}'::jsonb) returning id::text as id`);
  return row!.id;
}

/** Enqueues one run of a job kind for the local tick (a schedule firing, with this spec's key). */
async function enqueueJob(kind: string, tag: string): Promise<string> {
  const [row] = await e2eRows<{ id: string }>(sql`insert into jobs (kind, payload, idempotency_key, lane, priority)
    values (${kind}, '{}'::jsonb, ${`e2e:accr2:${kind}:${stamp}:${tag}`}, 'fast', 5) returning id::text as id`);
  return row!.id;
}

async function jobFinished(id: string): Promise<boolean> {
  return (await one<{ status: string }>(sql`select status::text as status from jobs where id = ${id}::uuid`))?.status === "succeeded";
}

// ---------------------------------------------------------------------------
// Webinar (rows 1 to 3)
// ---------------------------------------------------------------------------

const SLUGS = { upcoming: `e2e-accr2-upcoming-${stamp}`, ondemand: `e2e-accr2-od-${stamp}`, replay: `e2e-accr2-replay-${stamp}` };
const WEBINAR_SESSION = `${MARK} webinar ${stamp}`;
const WEBINAR_TITLE = { "nl-BE": "E2E acceptatie R2", "fr-BE": "E2E acceptation R2", en: "E2E acceptance R2" };
const QUESTION = { "nl-BE": "Slaap je goed?", "fr-BE": "Dormez-vous bien ?", en: "Do you sleep well?" };
const OPTIONS = [
  { key: "yes", label: { "nl-BE": "Ja", "fr-BE": "Oui", en: "Yes" } },
  { key: "no", label: { "nl-BE": "Nee", "fr-BE": "Non", en: "No" } },
];
const webinarIds: Record<keyof typeof SLUGS, string> = { upcoming: "", ondemand: "", replay: "" };

const webinarPortalOn = async () => (await readFlag("ff_webinar_portal"))?.state === "on";

async function cleanupWebinars(): Promise<void> {
  const db = await e2eDb();
  const slugs = Object.values(SLUGS);
  await db.transaction(async (tx) => {
    // Watch segments and interactions are append-only: removing the spec's own rows needs the rewrite switch.
    await tx.execute(sql`select set_config('beam.allow_rewrite', 'on', true)`);
    await tx.execute(sql`delete from webinar_registrations where webinar_id in (select id from webinars where slug in ${slugs})`);
    await tx.execute(sql`delete from webinars where slug in ${slugs}`);
    await tx.execute(sql`delete from sessions where title->>'en' = ${WEBINAR_SESSION}`);
  });
}

async function webinarSession(startsIn: string): Promise<string> {
  const title = JSON.stringify({ "nl-BE": WEBINAR_SESSION, "fr-BE": WEBINAR_SESSION, en: WEBINAR_SESSION });
  const [s] = await e2eRows<{ id: string }>(sql`
    insert into sessions (kind, title, starts_at, ends_at, capacity_seats, event_category)
    values ('event', ${title}::jsonb, now() + ${startsIn}::interval, now() + ${startsIn}::interval + interval '1 hour', 0, 'webinar')
    returning id::text as id`);
  return s!.id;
}

/** An upcoming live webinar, a published on-demand one and a live one already running (with a poll). */
async function createWebinars(): Promise<void> {
  const upcomingSession = await webinarSession("1 day");
  const liveSession = await webinarSession("-10 minutes");
  const title = JSON.stringify(WEBINAR_TITLE);
  const [up] = await e2eRows<{ id: string }>(sql`
    insert into webinars (slug, session_id, title, description, mode, status, starts_at, published_at, youtube_video_id, owner_user_id, created_by_user_id)
    select ${SLUGS.upcoming}, ${upcomingSession}::uuid, ${title}::jsonb, '{}'::jsonb, 'live', 'published', now() + interval '1 day', now(), 'fake_accr2up', u.id, u.id
    from users u where lower(u.email) = 'owner@demo.beam.be' returning id::text as id`);
  const [od] = await e2eRows<{ id: string }>(sql`
    insert into webinars (slug, title, description, mode, status, published_at, recording_video_id, duration_sec, owner_user_id, created_by_user_id)
    select ${SLUGS.ondemand}, ${title}::jsonb, '{}'::jsonb, 'on_demand', 'published', now(), 'fake_accr2od', 1800, u.id, u.id
    from users u where lower(u.email) = 'owner@demo.beam.be' returning id::text as id`);
  const [rp] = await e2eRows<{ id: string }>(sql`
    insert into webinars (slug, session_id, title, description, mode, status, starts_at, live_started_at, published_at, youtube_video_id, owner_user_id, created_by_user_id)
    select ${SLUGS.replay}, ${liveSession}::uuid, ${title}::jsonb, '{}'::jsonb, 'live', 'live', now() - interval '10 minutes', now() - interval '10 minutes',
           now() - interval '1 day', 'fake_accr2rp', u.id, u.id
    from users u where lower(u.email) = 'owner@demo.beam.be' returning id::text as id`);
  if (!up || !od || !rp) throw new Error("demo owner user missing");
  await e2eRows(sql`insert into webinar_polls (webinar_id, key, question, options, show_at_sec, show_for_sec)
    values (${rp.id}::uuid, 'sleep', ${JSON.stringify(QUESTION)}::jsonb, ${JSON.stringify(OPTIONS)}::jsonb, 2, 600)`);
  Object.assign(webinarIds, { upcoming: up.id, ondemand: od.id, replay: rp.id });
}

/** Registers through the public route (as the landing page's form does) and signs the personal link. */
async function registerForWebinar(page: Page, slug: keyof typeof SLUGS, email: string): Promise<{ token: string; registrationId: string }> {
  const res = await page.request.post(`/api/public/webinars/${SLUGS[slug]}/register`, {
    data: { email, firstName: "Aline", lastName: "AcceptanceR2", locale: "nl-BE", consents: {}, wordingVersion: "v1", utm: { source: "e2e" } },
  });
  expect(res.status()).toBe(202);
  const reg = await one<{ id: string; token_version: number }>(sql`
    select r.id::text as id, r.token_version from webinar_registrations r join persons p on p.id = r.person_id
    where r.webinar_id = ${webinarIds[slug]}::uuid and lower(p.email) = ${email.toLowerCase()}`);
  if (!reg) throw new Error("registration missing");
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return { registrationId: reg.id, token: signAccessToken(deriveAccessKey(secret), reg.id, Number(reg.token_version)) };
}

/** Opens the personal link, accepts the video notice and plays the simulated player, by keyboard. */
async function watchWebinar(page: Page, token: string, mode: "live" | "replay" | "on_demand"): Promise<void> {
  await page.goto(`/nl/w/${token}`);
  await page.getByRole("button", { name: "Video laden" }).focus();
  const viewed = page.waitForResponse((r) => r.url().endsWith("/api/webinar/view") && r.request().method() === "POST");
  await page.keyboard.press("Enter");
  expect(((await (await viewed).json()) as { mode?: string }).mode).toBe(mode);
  await page.getByRole("button", { name: "Afspelen" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("webinar-fake-player")).toHaveAttribute("data-state", "playing");
}

const reportCell = (page: Page, mode: string, metric: string, segment: string) =>
  page.getByTestId(`report-mode-${mode}`).locator(`tr[data-metric="${metric}"] td[data-segment="${segment}"]`);

async function openWebinarReport(page: Page, webinarId: string): Promise<void> {
  await signInStaff(page, "owner", { returnTo: `/admin/webinars/${webinarId}/report` });
  await page.goto(`/admin/webinars/${webinarId}/report?period=30`);
  await expect(page.getByTestId("report-conversion")).toBeVisible();
}

// ---------------------------------------------------------------------------
// Lead-priority waitlist (rows 4 and 5)
// ---------------------------------------------------------------------------

const LEAD_FLAG = "ff_booking_lead_priority";
const LEAD_TITLE = { "nl-BE": `${MARK} lezing`, "fr-BE": `${MARK} conférence`, en: `${MARK} lecture` };
type LeadIds = { sessionId: string; seated: string; waiting: string; customer: string; other: string; emails: Record<"seated" | "waiting" | "customer" | "other", string> };
let lead: LeadIds | null = null;

const statusOf = async (personId: string) => (await one<{ status: string }>(sql`select status::text as status from v_person_status where person_id = ${personId}::uuid`))?.status;
const entryOf = async (personId: string) =>
  one<{ id: string; queue: string; state: string; joined_at: string }>(sql`
    select id::text as id, queue::text as queue, state::text as state, joined_at::text as joined_at
    from waitlist_entries where session_id = ${lead!.sessionId}::uuid and person_id = ${personId}::uuid`);
const leadBookingOf = async (personId: string) =>
  one<{ id: string; status: string; used_lead_seat: boolean }>(sql`
    select id::text as id, status::text as status, used_lead_seat from bookings
    where session_id = ${lead!.sessionId}::uuid and person_id = ${personId}::uuid order by created_at desc limit 1`);

/** A paid admin order with one package line: the person is a customer from now on (D28). */
async function makeCustomer(personId: string): Promise<void> {
  const product = await one<{ id: string; sku: string }>(sql`select id::text as id, sku from products where kind = 'package' order by created_at limit 1`);
  expect(product, "the demo data has a package product").toBeTruthy();
  const order = await one<{ id: string }>(sql`
    insert into orders (person_id, channel, status, subtotal_cents, vat_cents, total_cents, locale, client_key, paid_at, terms_version_id)
    values (${personId}::uuid, 'admin', 'paid', 9000, 1562, 9000, 'nl-BE', gen_random_uuid(), now(), null) returning id::text as id`);
  await e2eRows(sql`
    insert into order_lines (order_id, line_no, product_id, product_kind, sku, description, quantity, unit_amount_cents, line_total_cents, vat_rate_pct, vat_cents, pricing_trace)
    values (${order!.id}::uuid, 1, ${product!.id}::uuid, 'package', ${product!.sku}, '{"nl-BE":"Pakket","fr-BE":"Forfait","en":"Package"}'::jsonb, 1, 9000, 9000, 21.00, 1562, '{"e2e":true}'::jsonb)`);
}

/** A free Lead Magnet event in its lead window: 2 seats, 1 reserved for leads, the general seat taken. */
async function createLeadMagnet(): Promise<void> {
  // Distinct normalised addresses, so booking's duplicate signals (R48) see four people.
  const emails = { seated: distinctEmail("accr2-lead-seated"), waiting: distinctEmail("accr2-lead-waiting"), customer: distinctEmail("accr2-customer"), other: distinctEmail("accr2-other") };
  const session = await one<{ id: string }>(sql`
    insert into sessions (kind, event_category, title, starts_at, ends_at, capacity_seats, credit_kind, credit_cost, published_at,
                          is_lead_magnet, lead_reserved_seats, lead_window_start_at, lead_window_end_at, lead_release_rule, public_release_at, claim_window_minutes)
    values ('event', 'lecture', ${JSON.stringify(LEAD_TITLE)}::jsonb, now() + interval '6 days', now() + interval '6 days 2 hours', 2, null, 0, now() - interval '1 day',
            true, 1, now() - interval '1 hour', now() + interval '2 days', 'customers_then_public', now() + interval '3 days', 120)
    returning id::text as id`);
  lead = {
    sessionId: session!.id,
    seated: await testerPerson(emails.seated, "Lena"),
    waiting: await testerPerson(emails.waiting, "Wout"),
    customer: await testerPerson(emails.customer, "Carla"),
    other: await testerPerson(emails.other, "Olga"),
    emails,
  };
  await makeCustomer(lead.customer);
  await makeCustomer(lead.other);
  await e2eRows(sql`insert into bookings (session_id, person_id, status, paid_with, source, checkin_code) values (${lead.sessionId}::uuid, ${lead.other}::uuid, 'confirmed', 'free', 'admin', ${newCheckinCode()})`);
}

async function cleanupLeadMagnet(): Promise<void> {
  await e2eRows(sql`delete from waitlist_entries where session_id in (select id from sessions where title->>'en' = ${LEAD_TITLE.en})`);
  await e2eRows(sql`update bookings set status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'staff', reserved_until = null, version = version + 1
    where status in ('reserved', 'confirmed') and session_id in (select id from sessions where title->>'en' = ${LEAD_TITLE.en})`);
  await e2eRows(sql`update sessions set status = 'cancelled', cancelled_at = now(), cancel_reason = 'e2e acceptance-r2 cleanup' where title->>'en' = ${LEAD_TITLE.en} and status <> 'cancelled'`);
}

/** The portal booking page of the Lead Magnet event, signed in as `email`. */
async function openLeadMagnet(page: Page, email: string): Promise<void> {
  await signInCustomer(page, email, "nl");
  await page.goto(`/nl/account/book/${lead!.sessionId}`);
}

/** The fixture people never accepted the terms, so their first booking or queue join asks for them. */
async function acceptTerms(page: Page): Promise<void> {
  await page.getByRole("checkbox", { name: /voorwaarden/ }).check();
}

async function postOn(page: Page, click: () => Promise<void>): Promise<void> {
  const [response] = await Promise.all([page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/account/book/${lead!.sessionId}`)), click()]);
  expect(response.status()).toBeLessThan(500);
}

// ---------------------------------------------------------------------------
// Abandoned checkout (row 6)
// ---------------------------------------------------------------------------

const RECOVERY_FLAG = "ff_commerce_checkout_recovery";
const JOURNEY = "abandoned-checkout";
type Saved = { flag: FlagRow | null; journey: { status: string; activated_at: string | null } | null; rules: unknown };
let saved: Saved | null = null;

/** The recovery flag on, the seeded journey active, no quiet hours and room under the caps for this run. */
async function switchOnRecovery(): Promise<void> {
  const flag = await raiseFlag(RECOVERY_FLAG, "on");
  const journey = (await one<{ status: string; activated_at: string | null }>(sql`select status::text as status, activated_at::text as activated_at from automations where slug = ${JOURNEY}`)) ?? null;
  expect(journey, "the defaults seed has the abandoned-checkout journey").toBeTruthy();
  if (journey!.status === "draft") await e2eRows(sql`update automations set status = 'active', activated_at = coalesce(activated_at, now()) where slug = ${JOURNEY}`);
  const rules = (await one<{ value: unknown }>(sql`select value from settings where key = 'automation_rules'`))?.value ?? null;
  const open = { max_marketing_per_day: 10, max_marketing_per_week: 30, quiet_start: "00:00", quiet_end: "00:00" };
  await e2eRows(sql`insert into settings (key, value) values ('automation_rules', ${JSON.stringify({ webhook_hosts: [], ...open })}::jsonb)
    on conflict (key) do update set value = settings.value || ${JSON.stringify(open)}::jsonb, version = settings.version + 1`);
  saved = { flag, journey, rules };
}

async function restoreRecovery(): Promise<void> {
  if (!saved) return;
  await restoreFlag(RECOVERY_FLAG, saved.flag);
  if (saved.journey?.status === "draft") await e2eRows(sql`update automations set status = 'draft', activated_at = ${saved.journey.activated_at}::timestamptz where slug = ${JOURNEY}`);
  if (saved.rules === null) await e2eRows(sql`delete from settings where key = 'automation_rules'`);
  else await e2eRows(sql`update settings set value = ${JSON.stringify(saved.rules)}::jsonb, version = version + 1 where key = 'automation_rules'`);
  saved = null;
}

const recoveryMessagesOf = (checkoutId: string) =>
  e2eRows<{ id: string; status: string; resume_url: string | null; idempotency_key: string }>(sql`
    select id::text as id, status::text as status, context->>'resume_url' as resume_url, idempotency_key from email_messages
    where kind = 'automation' and context->>'checkout_id' = ${checkoutId} order by created_at`);
const checkoutOf = (id: string) =>
  one<{ status: string; recovery_message_id: string | null; recovered_order_id: string | null }>(sql`
    select status::text as status, recovery_message_id::text as recovery_message_id, recovered_order_id::text as recovered_order_id from checkouts where id = ${id}::uuid`);
const enrolmentOf = (checkoutId: string) =>
  one<{ id: string; status: string; next_step_key: string | null }>(sql`
    select e.id::text as id, e.status::text as status, e.next_step_key from automation_enrolments e join automations a on a.id = e.automation_id
    where a.slug = ${JOURNEY} and e.subject_key = ${`checkout:${checkoutId}`} order by e.entered_at desc limit 1`);

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

test.describe("Release 2 acceptance (proposal section 12)", () => {
  test.afterAll(async () => {
    await closeE2eDb();
  });

  test.describe("Webinar", () => {
    test.beforeAll(async () => {
      if (!(await webinarPortalOn())) return;
      await cleanupWebinars();
      await createWebinars();
    });
    test.afterAll(async () => {
      await cleanupWebinars().catch(() => undefined);
    });

    test("Registration is not counted as attendance", async ({ page }) => {
      test.skip(!(await webinarPortalOn()), "ff_webinar_portal is off (Release 2)");
      const { registrationId } = await registerForWebinar(page, "upcoming", uniqueEmail("accr2-webinar-reg"));
      const events = await e2eRows<{ kind: string }>(sql`select kind from activity_events where ref_type = 'webinar_registration' and ref_id = ${registrationId} order by kind`);
      expect(events.map((e) => e.kind)).toEqual(["webinar.registered"]);
      const facts = await one<{ live_started: boolean; live_attended: boolean; live_watched_sec: number }>(sql`
        select live_started, live_attended, live_watched_sec from v_webinar_registration_facts where registration_id = ${registrationId}::uuid`);
      expect(facts).toMatchObject({ live_started: false, live_attended: false, live_watched_sec: 0 });

      await openWebinarReport(page, webinarIds.upcoming);
      await expect(reportCell(page, "live", "registered", "total")).toHaveText("1");
      await expect(reportCell(page, "live", "started", "total")).toHaveText("0");
      await expect(reportCell(page, "live", "attended", "total")).toHaveText("0");
    });

    test("Watch time is captured", async ({ browser }) => {
      test.skip(!(await webinarPortalOn()), "ff_webinar_portal is off (Release 2)");
      test.setTimeout(150_000);
      const context = await browser.newContext();
      await context.route("https://www.youtube.com/**", (route) => route.abort());
      const page = await context.newPage();
      const { token, registrationId } = await registerForWebinar(page, "ondemand", uniqueEmail("accr2-webinar-watch"));
      await watchWebinar(page, token, "on_demand");
      for (let i = 0; i < 2; i++) {
        const beat = await page.waitForResponse((r) => r.url().endsWith("/api/webinar/heartbeat") && r.request().method() === "POST", { timeout: 40_000 });
        expect(beat.status()).toBe(200);
      }
      const watched = await one<{ segments: number; sec: number }>(sql`
        select (select count(*)::int from watch_segments where registration_id = ${registrationId}::uuid and mode = 'on_demand') as segments,
               (select coalesce(sum(watched_sec), 0)::int from v_webinar_watch where registration_id = ${registrationId}::uuid and mode = 'on_demand') as sec`);
      expect(watched!.segments).toBeGreaterThan(0);
      expect(watched!.sec).toBeGreaterThan(0);
      await context.close();

      const staff = await (await browser.newContext()).newPage();
      await openWebinarReport(staff, webinarIds.ondemand);
      await expect(reportCell(staff, "on_demand", "started", "total")).toHaveText("1");
      await expect(reportCell(staff, "live", "started", "total")).toHaveText("0");
      await staff.context().close();
    });

    test("Replay activity and replay polls are stored separately from live", async ({ browser }) => {
      test.skip(!(await webinarPortalOn()), "ff_webinar_portal is off (Release 2)");
      test.setTimeout(150_000);
      const context = await browser.newContext();
      await context.route("https://www.youtube.com/**", (route) => route.abort());
      const page = await context.newPage();
      const { token, registrationId } = await registerForWebinar(page, "replay", uniqueEmail("accr2-webinar-replay"));
      // The live answer of the same person (the live UI path is scenario-5-replay-separation.spec.ts).
      await e2eRows(sql`insert into webinar_interactions (registration_id, webinar_id, mode, kind, poll_id, payload, at_sec)
        select ${registrationId}::uuid, ${webinarIds.replay}::uuid, 'live', 'poll_answer', p.id, '{"option_keys": ["yes"]}'::jsonb, 30
        from webinar_polls p where p.webinar_id = ${webinarIds.replay}::uuid and p.key = 'sleep'`);
      // Fake clock: the live broadcast ended and its recording is the replay.
      await e2eRows(sql`update webinars set status = 'ended', live_ended_at = now(), recording_video_id = 'fake_accr2rp', duration_sec = 1800 where id = ${webinarIds.replay}::uuid`);

      await watchWebinar(page, token, "replay");
      const poll = page.getByTestId("webinar-poll");
      await expect(poll.getByRole("group", { name: "Slaap je goed?" })).toBeVisible({ timeout: 30_000 });
      await poll.getByRole("radio", { name: "Nee" }).focus();
      await page.keyboard.press("Space");
      const answered = page.waitForResponse((r) => r.url().endsWith("/api/webinar/interact") && r.request().postData()?.includes("poll_answer") === true);
      await poll.getByRole("button", { name: "Verstuur mijn antwoord" }).focus();
      await page.keyboard.press("Enter");
      expect((await answered).status()).toBe(200);
      await context.close();

      const rows = await e2eRows<{ mode: string; keys: string }>(sql`
        select mode::text as mode, payload->'option_keys'->>0 as keys from webinar_interactions
        where registration_id = ${registrationId}::uuid and kind = 'poll_answer' order by mode`);
      expect(rows).toEqual([
        { mode: "live", keys: "yes" },
        { mode: "replay", keys: "no" },
      ]);
      const facts = await one<{ poll_answers_live: number; poll_answers_replay: number; replay_started: boolean; live_started: boolean }>(sql`
        select poll_answers_live, poll_answers_replay, replay_started, live_started from v_webinar_registration_facts where registration_id = ${registrationId}::uuid`);
      expect(facts).toMatchObject({ poll_answers_live: 1, poll_answers_replay: 1, replay_started: true, live_started: false });

      const staff = await (await browser.newContext()).newPage();
      await openWebinarReport(staff, webinarIds.replay);
      const table = staff.getByTestId("report-poll-sleep");
      await expect(table.getByRole("row", { name: /^(Ja|Yes|Oui)\b/ }).locator('td[data-mode="live"]')).toHaveText("1");
      await expect(table.getByRole("row", { name: /^(Ja|Yes|Oui)\b/ }).locator('td[data-mode="replay"]')).toHaveText("0");
      await expect(table.getByRole("row", { name: /^(Nee|No|Non)\b/ }).locator('td[data-mode="replay"]')).toHaveText("1");
      await expect(table.getByRole("row", { name: /^(Nee|No|Non)\b/ }).locator('td[data-mode="live"]')).toHaveText("0");
      await staff.context().close();
    });
  });

  test.describe("Lead-priority waitlist", () => {
    test.describe.configure({ mode: "serial" });
    let previousFlag: FlagRow | null = null;

    test.beforeAll(async () => {
      previousFlag = await raiseFlag(LEAD_FLAG, "testers");
      await cleanupLeadMagnet();
      await createLeadMagnet();
    });
    test.afterAll(async () => {
      await cleanupLeadMagnet().catch(() => undefined);
      await restoreFlag(LEAD_FLAG, previousFlag);
    });

    test("Lead and customer rules work on a Lead Magnet event", async ({ browser }) => {
      // Three people sign in by magic link and act in turn.
      test.setTimeout(3 * 60_000);
      const s = lead!;
      expect(await statusOf(s.seated)).toBe("lead");
      expect(await statusOf(s.customer)).toBe("customer");

      // While the reserved seat is still free and the general seat is taken, a customer sees when the
      // event opens for them and no booking button (R22). Once every seat is taken the page says
      // "Volzet" instead (booking's computeAvailability: nothing is left to open), so the customer
      // looks first and joins the customer queue after the leads, keeping the queue order below.
      const customerPage = await (await browser.newContext()).newPage();
      await openLeadMagnet(customerPage, s.emails.customer);
      await expect(customerPage.getByTestId("session-state")).toContainText("Opent voor jou op");
      await expect(customerPage.getByTestId("book-submit")).toHaveCount(0);
      await expect(customerPage.getByTestId("join-waitlist")).toHaveText(/klantenwachtrij|wachtrij voor klanten/i);

      // During the lead window a lead books the reserved seat.
      const leadPage = await (await browser.newContext()).newPage();
      await openLeadMagnet(leadPage, s.emails.seated);
      await expect(leadPage.getByTestId("book-form")).toBeVisible();
      await acceptTerms(leadPage);
      await postOn(leadPage, () => leadPage.getByTestId("book-submit").click());
      await leadPage.waitForURL(/\/account\/bookings\//);
      expect(await leadBookingOf(s.seated)).toMatchObject({ status: "confirmed", used_lead_seat: true });
      await leadPage.context().close();

      // A second lead finds the event full and joins the lead queue.
      const waitingPage = await (await browser.newContext()).newPage();
      await openLeadMagnet(waitingPage, s.emails.waiting);
      await expect(waitingPage.getByTestId("join-waitlist")).toBeVisible();
      await acceptTerms(waitingPage);
      await postOn(waitingPage, () => waitingPage.getByTestId("join-waitlist").click());
      await expect(waitingPage.getByTestId("waitlist-joined")).toBeVisible();
      expect(await entryOf(s.waiting)).toMatchObject({ queue: "lead", state: "waiting" });
      await waitingPage.context().close();

      // The customer joins the customer queue, still without a booking button.
      await customerPage.reload();
      await expect(customerPage.getByTestId("book-submit")).toHaveCount(0);
      await expect(customerPage.getByTestId("join-waitlist")).toHaveText(/klantenwachtrij|wachtrij voor klanten/i);
      await acceptTerms(customerPage);
      await postOn(customerPage, () => customerPage.getByTestId("join-waitlist").click());
      await expect(customerPage.getByTestId("waitlist-joined")).toBeVisible();
      expect(await entryOf(s.customer)).toMatchObject({ queue: "customer", state: "waiting" });
      await customerPage.context().close();
    });

    test("A waiting lead who buys is reclassified as a customer, and a seated lead who buys keeps the confirmed seat", async ({ browser }) => {
      test.setTimeout(6 * 60_000);
      const s = lead!;
      const before = await entryOf(s.waiting);
      expect(before).toMatchObject({ queue: "lead", state: "waiting" });
      const seatedBefore = await leadBookingOf(s.seated);
      expect(seatedBefore).toMatchObject({ status: "confirmed", used_lead_seat: true });

      // Both leads buy the 5-day package in the portal with the fake provider.
      for (const email of [s.emails.waiting, s.emails.seated]) {
        const page = await (await browser.newContext()).newPage();
        await signInCustomer(page, email, "nl");
        await buyPackage(page, "nl-BE");
        await page.context().close();
      }
      await expect.poll(() => statusOf(s.waiting), { timeout: 30_000 }).toBe("customer");
      await expect.poll(() => statusOf(s.seated), { timeout: 30_000 }).toBe("customer");

      // The minute job `waitlist.expire_offers` moves the waiting entry to the customer queue, keeping its place.
      await expect.poll(async () => (await entryOf(s.waiting))?.queue, { timeout: TICK_WAIT }).toBe("customer");
      expect(await entryOf(s.waiting)).toMatchObject({ id: before!.id, state: "waiting", joined_at: before!.joined_at });
      const requeued = await one<{ n: number }>(sql`select count(*)::int as n from activity_events where kind = 'waitlist.requeued' and person_id = ${s.waiting}::uuid`);
      expect(requeued!.n).toBe(1);
      // It joined before the customer, so it stays ahead of them in the customer queue.
      expect(new Date(before!.joined_at).getTime()).toBeLessThan(new Date((await entryOf(s.customer))!.joined_at).getTime());

      // The seated lead's confirmed seat is untouched.
      expect(await leadBookingOf(s.seated)).toEqual(seatedBefore);
      expect(await entryOf(s.seated)).toBeUndefined();
    });
  });

  test.describe("Abandoned checkout", () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(async () => {
      await switchOnRecovery();
    });
    test.afterAll(async () => {
      await restoreRecovery().catch(() => undefined);
    });

    test("The recovery email is sent once, brings the customer back, and the paid checkout is attributed to it", async ({ page }) => {
      test.setTimeout(10 * 60_000);
      const email = uniqueEmail("accr2-cart");
      const startedAt = new Date();
      await signInCustomer(page, email, "nl");
      const personId = await eventually(() => personIdOf(email), 30_000);
      // The newsletter purpose is reachable (the journey sends commerce.checkout_recovery as marketing).
      await e2eRows(sql`insert into consent_records (person_id, purpose, status, method, source, wording_version, recorded_at, actor)
        values (${personId}::uuid, 'newsletter', 'granted', 'form', 'form:e2e-accr2', 'form:e2e-accr2:v1:newsletter', now(), '{"kind":"system","id":null}'::jsonb)`);

      // The customer opens the checkout for the 5-day package and leaves.
      await page.goto("/nl/account/shop/PKG-5-DAYS");
      await page.getByRole("button", { name: copy("nl-BE", "commerce.shop.buy_now") }).click();
      await page.waitForURL(/\/nl\/account\/checkout\?checkout=/);
      const checkoutId = new URL(page.url()).searchParams.get("checkout")!;
      expect(checkoutId).toMatch(/^[0-9a-f-]{36}$/);

      // Fake clock: 61 minutes idle; one `checkouts.mark_abandoned` run marks it.
      await e2eRows(sql`update checkouts set last_activity_at = now() - interval '61 minutes' where id = ${checkoutId}::uuid`);
      const first = await enqueueJob("checkouts.mark_abandoned", "1");
      await expect.poll(() => jobFinished(first), { timeout: TICK_WAIT }).toBe(true);
      expect((await checkoutOf(checkoutId))?.status).toBe("abandoned");

      // The evaluator enrols the person; fake clock: the 1-hour reminder is due now.
      const enrolment = await eventually(() => enrolmentOf(checkoutId), TICK_WAIT);
      expect(enrolment).toMatchObject({ status: "active", next_step_key: "remind_1h" });
      await e2eRows(sql`update automation_enrolments set next_step_at = now() - interval '1 minute' where id = ${enrolment.id}::uuid`);

      const mail = await latestEmail(email, { after: startedAt, timeoutMs: TICK_WAIT });
      expect(mail.html.length).toBeGreaterThan(0);
      await expect.poll(async () => (await recoveryMessagesOf(checkoutId)).map((m) => m.status), { timeout: TICK_WAIT }).toEqual(["sent"]);
      const [message] = await recoveryMessagesOf(checkoutId);
      expect(message!.idempotency_key).toBe(`automation:${enrolment.id}:remind_1h`);
      expect(message!.resume_url).toMatch(/\/nl\/checkout\/resume\/[A-Za-z0-9_-]{43}$/);
      expect((await checkoutOf(checkoutId))?.recovery_message_id).toBe(message!.id);

      // Sent once: another mark_abandoned run and evaluator tick add no second recovery email.
      const second = await enqueueJob("checkouts.mark_abandoned", "2");
      await expect.poll(() => jobFinished(second), { timeout: TICK_WAIT }).toBe(true);
      await page.waitForTimeout(65_000);
      expect((await recoveryMessagesOf(checkoutId)).map((m) => m.id)).toEqual([message!.id]);

      // The resume link brings the customer back to the same checkout, and they pay.
      await page.goto(new URL(message!.resume_url!).pathname);
      const resumed = page.waitForResponse((r) => r.request().method() === "POST");
      await page.getByRole("button", { name: copy("nl-BE", "commerce.resume.continue") }).click();
      await resumed;
      await page.waitForURL(new RegExp(`/nl/account/checkout\\?checkout=${checkoutId}`));
      await payCheckout(page);
      await expect.poll(async () => (await checkoutOf(checkoutId))?.status, { timeout: 30_000 }).toBe("completed");

      // checkout.completed ends the journey; the next mark_abandoned run attributes the recovery to the first email.
      await expect.poll(async () => (await enrolmentOf(checkoutId))?.status, { timeout: TICK_WAIT }).toBe("exited");
      const third = await enqueueJob("checkouts.mark_abandoned", "3");
      await expect.poll(() => jobFinished(third), { timeout: TICK_WAIT }).toBe(true);
      const recovered = await checkoutOf(checkoutId);
      expect(recovered).toMatchObject({ status: "completed", recovery_message_id: message!.id });
      expect(recovered!.recovered_order_id).toMatch(/^[0-9a-f-]{36}$/);
      expect((await recoveryMessagesOf(checkoutId)).map((m) => m.id)).toEqual([message!.id]);
    });
  });
});
