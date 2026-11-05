/**
 * The three Release 2 webinar acceptance tests (proposal section 12; webinar spec section 1 and
 * webinar-P6, rules 17, 26, 33 and 39):
 *
 * 1. Registration is not attendance: a registration through the public route writes the
 *    registration and `webinar.registered` only; no started, attended or watched fact; the report
 *    counts one registration and nobody attended.
 * 2. Watch time is captured: watching an on-demand webinar through the personal link writes watch
 *    segments every 15 s; `v_webinar_watch` holds the seconds and the report shows the viewer
 *    under on-demand.
 * 3. Replay activity and replay polls are stored apart from live: a live poll answer and a replay
 *    answer of the same person are two rows with their own modes, and the report's poll results
 *    show them in their own columns.
 *
 * Release 2: skipped while `ff_webinar_portal` is off. Video ids start with `fake_`, so the player
 * is the YouTube fake's simulated player and nothing goes to youtube.com. The spec creates its own
 * webinars (slugs `e2e-acc2-*`, owned by the demo owner) and session, registers fresh
 * `@example.com` addresses and removes its rows before and after (under `beam.allow_rewrite`:
 * segments and interactions are append-only). It waits for responses, never on a bare
 * `role="alert"` (CONVENTIONS item 11).
 */
import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { deriveAccessKey, signAccessToken } from "@beam/core/webinar";
import { signInStaff } from "./support/auth";
import { closeE2eDb, e2eDb, e2eRows } from "./support/db";

const stamp = Date.now().toString(36);
const SLUGS = { upcoming: `e2e-acc2-upcoming-${stamp}`, ondemand: `e2e-acc2-od-${stamp}`, replay: `e2e-acc2-replay-${stamp}` };
const SESSION_TITLE = `E2E acceptance R2 ${stamp}`;
const TITLE = { "nl-BE": "E2E acceptatie", "fr-BE": "E2E acceptation", en: "E2E acceptance" };
const QUESTION = { "nl-BE": "Slaap je goed?", "fr-BE": "Dormez-vous bien ?", en: "Do you sleep well?" };
const OPTIONS = [
  { key: "yes", label: { "nl-BE": "Ja", "fr-BE": "Oui", en: "Yes" } },
  { key: "no", label: { "nl-BE": "Nee", "fr-BE": "Non", en: "No" } },
];
const ids: Record<keyof typeof SLUGS, string> = { upcoming: "", ondemand: "", replay: "" };

async function flagOn(): Promise<boolean> {
  const rows = await e2eRows<{ state: string }>(sql`select state::text as state from feature_flags where key = 'ff_webinar_portal'`);
  return rows[0]?.state === "on";
}

async function cleanup(): Promise<void> {
  const db = await e2eDb();
  const slugs = Object.values(SLUGS);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('beam.allow_rewrite', 'on', true)`);
    await tx.execute(sql`delete from webinar_registrations where webinar_id in (select id from webinars where slug in ${slugs})`);
    await tx.execute(sql`delete from webinars where slug in ${slugs}`);
    await tx.execute(sql`delete from sessions where title->>'en' = ${SESSION_TITLE}`);
  });
}

async function makeSession(startsIn: string): Promise<string> {
  const title = JSON.stringify({ "nl-BE": SESSION_TITLE, "fr-BE": SESSION_TITLE, en: SESSION_TITLE });
  const [s] = await e2eRows<{ id: string }>(sql`
    insert into sessions (kind, title, starts_at, ends_at, capacity_seats, event_category)
    values ('event', ${title}::jsonb, now() + ${startsIn}::interval, now() + ${startsIn}::interval + interval '1 hour', 0, 'webinar')
    returning id::text as id`);
  return s!.id;
}

async function createWebinars(): Promise<void> {
  const upcomingSession = await makeSession("1 day");
  const liveSession = await makeSession("-10 minutes");
  const title = JSON.stringify(TITLE);
  const [up] = await e2eRows<{ id: string }>(sql`
    insert into webinars (slug, session_id, title, description, mode, status, starts_at, published_at, youtube_video_id, owner_user_id, created_by_user_id)
    select ${SLUGS.upcoming}, ${upcomingSession}::uuid, ${title}::jsonb, '{}'::jsonb, 'live', 'published', now() + interval '1 day', now(), 'fake_acc2up', u.id, u.id
    from users u where lower(u.email) = 'owner@demo.beam.be' returning id::text as id`);
  const [od] = await e2eRows<{ id: string }>(sql`
    insert into webinars (slug, title, description, mode, status, published_at, recording_video_id, duration_sec, owner_user_id, created_by_user_id)
    select ${SLUGS.ondemand}, ${title}::jsonb, '{}'::jsonb, 'on_demand', 'published', now(), 'fake_acc2od', 1800, u.id, u.id
    from users u where lower(u.email) = 'owner@demo.beam.be' returning id::text as id`);
  const [rp] = await e2eRows<{ id: string }>(sql`
    insert into webinars (slug, session_id, title, description, mode, status, starts_at, live_started_at, published_at, youtube_video_id, owner_user_id, created_by_user_id)
    select ${SLUGS.replay}, ${liveSession}::uuid, ${title}::jsonb, '{}'::jsonb, 'live', 'live', now() - interval '10 minutes', now() - interval '10 minutes',
           now() - interval '1 day', 'fake_acc2rp', u.id, u.id
    from users u where lower(u.email) = 'owner@demo.beam.be' returning id::text as id`);
  if (!up || !od || !rp) throw new Error("demo owner user missing");
  await e2eRows(sql`insert into webinar_polls (webinar_id, key, question, options, show_at_sec, show_for_sec)
    values (${rp.id}::uuid, 'sleep', ${JSON.stringify(QUESTION)}::jsonb, ${JSON.stringify(OPTIONS)}::jsonb, 2, 600)`);
  Object.assign(ids, { upcoming: up.id, ondemand: od.id, replay: rp.id });
}

async function register(page: Page, slug: keyof typeof SLUGS, email: string): Promise<{ token: string; registrationId: string }> {
  const res = await page.request.post(`/api/public/webinars/${SLUGS[slug]}/register`, {
    data: { email, firstName: "Aline", lastName: "Kijker", locale: "nl-BE", consents: {}, wordingVersion: "v1", utm: { source: "e2e" } },
  });
  expect(res.status()).toBe(202);
  const [reg] = await e2eRows<{ id: string; token_version: number }>(sql`
    select r.id::text as id, r.token_version from webinar_registrations r join persons p on p.id = r.person_id
    where r.webinar_id = ${ids[slug]}::uuid and lower(p.email) = ${email.toLowerCase()}`);
  if (!reg) throw new Error("registration missing");
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return { registrationId: reg.id, token: signAccessToken(deriveAccessKey(secret), reg.id, Number(reg.token_version)) };
}

/** Opens the personal link, accepts the notice and plays the simulated player, by keyboard. */
async function watch(page: Page, token: string, mode: "live" | "replay" | "on_demand"): Promise<void> {
  await page.goto(`/nl/w/${token}`);
  await page.getByRole("button", { name: "Video laden" }).focus();
  const viewed = page.waitForResponse((r) => r.url().endsWith("/api/webinar/view") && r.request().method() === "POST");
  await page.keyboard.press("Enter");
  const body = (await (await viewed).json()) as { mode?: string };
  expect(body.mode).toBe(mode);
  await page.getByRole("button", { name: "Afspelen" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("webinar-fake-player")).toHaveAttribute("data-state", "playing");
}

/** The report cell of a metric row in the table of one mode, for one segment column. */
const reportCell = (page: Page, mode: string, metric: string, segment: string) =>
  page.getByTestId(`report-mode-${mode}`).locator(`tr[data-metric="${metric}"] td[data-segment="${segment}"]`);

async function openReport(page: Page, webinarId: string): Promise<void> {
  await signInStaff(page, "owner", { returnTo: `/admin/webinars/${webinarId}/report` });
  await page.goto(`/admin/webinars/${webinarId}/report?period=30`);
  await expect(page.getByTestId("report-conversion")).toBeVisible();
}

test.describe("Release 2 webinar acceptance (proposal section 12)", () => {
  test.beforeAll(async () => {
    if (!(await flagOn())) return;
    await cleanup();
    await createWebinars();
  });
  test.afterAll(async () => {
    await cleanup().catch(() => undefined);
    await closeE2eDb();
  });

  test("Registration is not attendance", async ({ page }) => {
    test.skip(!(await flagOn()), "ff_webinar_portal is off (Release 2)");
    const { registrationId } = await register(page, "upcoming", `webinar-acc2-reg-${stamp}@example.com`);
    const events = await e2eRows<{ kind: string }>(sql`
      select kind from activity_events where ref_type = 'webinar_registration' and ref_id = ${registrationId} order by kind`);
    expect(events.map((e) => e.kind)).toEqual(["webinar.registered"]);
    const [facts] = await e2eRows<{ live_started: boolean; live_attended: boolean; live_watched_sec: number }>(sql`
      select live_started, live_attended, live_watched_sec from v_webinar_registration_facts where registration_id = ${registrationId}::uuid`);
    expect(facts).toMatchObject({ live_started: false, live_attended: false, live_watched_sec: 0 });

    await openReport(page, ids.upcoming);
    await expect(reportCell(page, "live", "registered", "total")).toHaveText("1");
    await expect(reportCell(page, "live", "started", "total")).toHaveText("0");
    await expect(reportCell(page, "live", "attended", "total")).toHaveText("0");
  });

  test("Watch time is captured", async ({ browser }) => {
    test.skip(!(await flagOn()), "ff_webinar_portal is off (Release 2)");
    test.setTimeout(150_000);
    const context = await browser.newContext();
    await context.route("https://www.youtube.com/**", (route) => route.abort());
    const page = await context.newPage();
    const { token, registrationId } = await register(page, "ondemand", `webinar-acc2-watch-${stamp}@example.com`);
    await watch(page, token, "on_demand");
    for (let i = 0; i < 2; i++) {
      const beat = await page.waitForResponse((r) => r.url().endsWith("/api/webinar/heartbeat") && r.request().method() === "POST", { timeout: 40_000 });
      expect(beat.status()).toBe(200);
    }
    const [segments] = await e2eRows<{ n: number }>(sql`select count(*)::int as n from watch_segments where registration_id = ${registrationId}::uuid and mode = 'on_demand'`);
    expect(segments!.n).toBeGreaterThan(0);
    const [watched] = await e2eRows<{ sec: number }>(sql`select coalesce(sum(watched_sec), 0)::int as sec from v_webinar_watch where registration_id = ${registrationId}::uuid and mode = 'on_demand'`);
    expect(watched!.sec).toBeGreaterThan(0);
    await context.close();

    const staff = await (await browser.newContext()).newPage();
    await openReport(staff, ids.ondemand);
    await expect(reportCell(staff, "on_demand", "started", "total")).toHaveText("1");
    await expect(reportCell(staff, "live", "started", "total")).toHaveText("0");
    await staff.context().close();
  });

  test("Replay activity and replay polls are stored separately from live", async ({ browser }) => {
    test.skip(!(await flagOn()), "ff_webinar_portal is off (Release 2)");
    test.setTimeout(150_000);
    const context = await browser.newContext();
    await context.route("https://www.youtube.com/**", (route) => route.abort());
    const page = await context.newPage();
    const { token, registrationId } = await register(page, "replay", `webinar-acc2-replay-${stamp}@example.com`);
    // The live answer (the live part is driven through the UI in scenario-5-replay-separation.spec.ts).
    await e2eRows(sql`insert into webinar_interactions (registration_id, webinar_id, mode, kind, poll_id, payload, at_sec)
      select ${registrationId}::uuid, ${ids.replay}::uuid, 'live', 'poll_answer', p.id, '{"option_keys": ["yes"]}'::jsonb, 30
      from webinar_polls p where p.webinar_id = ${ids.replay}::uuid and p.key = 'sleep'`);
    await e2eRows(sql`update webinars set status = 'ended', live_ended_at = now(), recording_video_id = 'fake_acc2rp', duration_sec = 1800 where id = ${ids.replay}::uuid`);

    await watch(page, token, "replay");
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
    const [facts] = await e2eRows<{ poll_answers_live: number; poll_answers_replay: number; replay_started: boolean }>(sql`
      select poll_answers_live, poll_answers_replay, replay_started from v_webinar_registration_facts where registration_id = ${registrationId}::uuid`);
    expect(facts).toMatchObject({ poll_answers_live: 1, poll_answers_replay: 1, replay_started: true });

    const staff = await (await browser.newContext()).newPage();
    await openReport(staff, ids.replay);
    const table = staff.getByTestId("report-poll-sleep");
    await expect(table.getByRole("row", { name: /^(Ja|Yes|Oui)\b/ }).locator('td[data-mode="live"]')).toHaveText("1");
    await expect(table.getByRole("row", { name: /^(Ja|Yes|Oui)\b/ }).locator('td[data-mode="replay"]')).toHaveText("0");
    await expect(table.getByRole("row", { name: /^(Nee|No|Non)\b/ }).locator('td[data-mode="replay"]')).toHaveText("1");
    await expect(table.getByRole("row", { name: /^(Nee|No|Non)\b/ }).locator('td[data-mode="live"]')).toHaveText("0");
    await expect(reportCell(staff, "replay", "pollResponses", "total")).toHaveText("1");
    await expect(reportCell(staff, "live", "pollResponses", "total")).toHaveText("1");
    await staff.context().close();
  });
});
