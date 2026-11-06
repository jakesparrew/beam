/**
 * Scenario 5: replay data separation (proposal section 11, Release 2; webinar-P5, spec rules 26,
 * 33-36, scenario 5). One viewer watches a live webinar through the personal link, answers the
 * poll and clicks the CTA by keyboard after the host launched them from the host console; the
 * webinar ends; the same viewer watches the replay, answers the same poll and clicks the same CTA
 * again. Every interaction and event carries its own mode, `v_webinar_registration_facts` counts
 * one poll answer and one click per mode, the host console shows the live results apart from the
 * replay answers, and a registrant who never watched is not counted as attended.
 *
 * Release 2: skipped while `ff_webinar_portal` is off. The video ids start with `fake_`, so the
 * player is the YouTube fake's simulated player and nothing goes to youtube.com; the CTA target
 * (`beam.example.com`) is answered by the spec. The spec creates its own webinar (slug
 * `e2e-sc5-*`, owned by the demo owner) and session, registers fresh `@example.com` addresses and
 * removes its rows before and after (under `beam.allow_rewrite`: interactions and segments are
 * append-only). It never waits on a bare `role="alert"` (CONVENTIONS item 11).
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { deriveAccessKey, signAccessToken } from "@beam/core/webinar";
import { signInStaff } from "./support/auth";
import { closeE2eDb, e2eDb, e2eRows } from "./support/db";

const stamp = Date.now().toString(36);
const SLUG = `e2e-sc5-${stamp}`;
const viewer = `webinar-sc5-${stamp}@example.com`;
const absent = `webinar-sc5-absent-${stamp}@example.com`;
const TITLE = { "nl-BE": "E2E scenario 5", "fr-BE": "E2E scénario 5", en: "E2E scenario 5" };
const QUESTION = { "nl-BE": "Slaap je goed?", "fr-BE": "Dormez-vous bien ?", en: "Do you sleep well?" };
const OPTIONS = [
  { key: "yes", label: { "nl-BE": "Ja", "fr-BE": "Oui", en: "Yes" } },
  { key: "no", label: { "nl-BE": "Nee", "fr-BE": "Non", en: "No" } },
];
const CTA_LABEL = { "nl-BE": "Boek een sessie", "fr-BE": "Réservez une séance", en: "Book a session" };

let webinarId = "";

async function flagOn(): Promise<boolean> {
  const rows = await e2eRows<{ state: string }>(sql`select state::text as state from feature_flags where key = 'ff_webinar_portal'`);
  return rows[0]?.state === "on";
}

async function cleanup(): Promise<void> {
  const db = await e2eDb();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('beam.allow_rewrite', 'on', true)`);
    await tx.execute(sql`delete from webinar_moderation_actions where webinar_id in (select id from webinars where slug = ${SLUG})`);
    await tx.execute(sql`delete from webinar_registrations where webinar_id in (select id from webinars where slug = ${SLUG})`);
    await tx.execute(sql`delete from webinars where slug = ${SLUG}`);
    await tx.execute(sql`delete from sessions where title->>'en' = ${`E2E scenario 5 ${stamp}`}`);
  });
}

/** A live webinar that went live 10 minutes ago, with one poll and one CTA shown 2 s into the replay. */
async function createWebinar(): Promise<string> {
  const [session] = await e2eRows<{ id: string }>(sql`
    insert into sessions (kind, title, starts_at, ends_at, capacity_seats, event_category)
    values ('event', ${JSON.stringify({ "nl-BE": `E2E scenario 5 ${stamp}`, "fr-BE": `E2E scenario 5 ${stamp}`, en: `E2E scenario 5 ${stamp}` })}::jsonb,
            now() - interval '10 minutes', now() + interval '50 minutes', 0, 'webinar')
    returning id::text as id`);
  const [w] = await e2eRows<{ id: string }>(sql`
    insert into webinars (slug, session_id, title, description, mode, status, starts_at, live_started_at, published_at, youtube_video_id, owner_user_id, created_by_user_id)
    select ${SLUG}, ${session!.id}::uuid, ${JSON.stringify(TITLE)}::jsonb, '{}'::jsonb, 'live', 'live', now() - interval '10 minutes', now() - interval '10 minutes',
           now() - interval '1 day', 'fake_e2esc5', u.id, u.id
    from users u where lower(u.email) = 'owner@demo.beam.be'
    returning id::text as id`);
  if (!w) throw new Error("demo owner user missing");
  await e2eRows(sql`insert into webinar_polls (webinar_id, key, question, options, show_at_sec, show_for_sec)
    values (${w.id}::uuid, 'sleep', ${JSON.stringify(QUESTION)}::jsonb, ${JSON.stringify(OPTIONS)}::jsonb, 2, 600)`);
  await e2eRows(sql`insert into webinar_ctas (webinar_id, key, label, url, show_at_sec, show_for_sec)
    values (${w.id}::uuid, 'book', ${JSON.stringify(CTA_LABEL)}::jsonb, 'https://beam.example.com/book', 2, 600)`);
  return w.id;
}

async function register(page: Page, email: string): Promise<{ token: string; registrationId: string }> {
  const res = await page.request.post(`/api/public/webinars/${SLUG}/register`, {
    data: { email, firstName: "Sanne", lastName: "Kijker", locale: "nl-BE", consents: {}, wordingVersion: "v1", utm: {} },
  });
  expect(res.status()).toBe(202);
  const [reg] = await e2eRows<{ id: string; token_version: number }>(sql`
    select r.id::text as id, r.token_version from webinar_registrations r join persons p on p.id = r.person_id
    where r.webinar_id = ${webinarId}::uuid and lower(p.email) = ${email.toLowerCase()}`);
  if (!reg) throw new Error("registration missing");
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return { registrationId: reg.id, token: signAccessToken(deriveAccessKey(secret), reg.id, Number(reg.token_version)) };
}

/** Opens the personal link, accepts the notice and plays the simulated player, by keyboard. */
async function watch(page: Page, token: string, mode: "live" | "replay"): Promise<void> {
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

/** Answers the poll and clicks the CTA by keyboard; the CTA tab is answered by the spec. */
async function answerAndClick(page: Page, option: "Ja" | "Nee"): Promise<void> {
  const poll = page.getByTestId("webinar-poll");
  await expect(poll.getByRole("group", { name: "Slaap je goed?" })).toBeVisible({ timeout: 30_000 });
  await poll.getByRole("radio", { name: option }).focus();
  await page.keyboard.press("Space");
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/webinar/interact") && r.request().postData()?.includes("poll_answer") === true);
  await poll.getByRole("button", { name: "Verstuur mijn antwoord" }).focus();
  await page.keyboard.press("Enter");
  expect((await answered).status()).toBe(200);
  await expect(poll).toContainText(`Jouw antwoord: ${option}`);

  const cta = page.getByTestId("webinar-cta");
  await expect(cta).toBeVisible({ timeout: 30_000 });
  const clicked = page.context().waitForEvent("request", (r) => r.url().includes(`/api/webinar/cta/`));
  const tab = page.context().waitForEvent("page");
  await cta.focus();
  await page.keyboard.press("Enter");
  await clicked;
  await (await tab).close();
}

async function asStaff(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signInStaff(page, "owner", { returnTo: `/admin/webinars/${webinarId}/host` });
  await page.goto(`/admin/webinars/${webinarId}/host`);
  return page;
}

/** Clicks a host console button and waits for its server action POST. */
async function hostClick(page: Page, item: "host-poll" | "host-cta", name: RegExp): Promise<void> {
  const done = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/admin/webinars/${webinarId}/host`));
  await page.getByTestId(item).getByRole("button", { name }).click();
  expect((await done).status()).toBe(200);
}

test.describe("Scenario 5: replay data separation (proposal section 11, Release 2)", () => {
  test.beforeAll(async () => {
    if (!(await flagOn())) return;
    await cleanup();
    webinarId = await createWebinar();
  });
  test.afterAll(async () => {
    await cleanup().catch(() => undefined);
    await closeE2eDb();
  });

  test("Every webinar interaction is stored with its mode; poll answers, CTA clicks and watch time per mode; reports split them; registration is not attendance", async ({ browser }) => {
    test.skip(!(await flagOn()), "ff_webinar_portal is off (Release 2)");
    test.setTimeout(240_000);
    const viewerContext = await browser.newContext();
    await viewerContext.route("https://beam.example.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>CTA target</title>" }));
    await viewerContext.route("https://www.youtube.com/**", (route) => route.abort());
    const page = await viewerContext.newPage();
    const { token, registrationId } = await register(page, viewer);
    const other = await register(page, absent);

    // Live: the host launches the poll and shows the CTA from the host console.
    const host = await asStaff(browser);
    await hostClick(host, "host-poll", /Starten|Launch|Lancer/);
    await hostClick(host, "host-cta", /Tonen|Show|Afficher/);
    await watch(page, token, "live");
    await answerAndClick(page, "Ja");
    await page.waitForResponse((r) => r.url().endsWith("/api/webinar/heartbeat"), { timeout: 40_000 });

    // The live webinar ends; its recording is the replay.
    await e2eRows(sql`update webinars set status = 'ended', live_ended_at = now(), recording_video_id = 'fake_e2esc5', duration_sec = 1800 where id = ${webinarId}::uuid`);
    // The state endpoint memoises the webinar row 2 s per instance (LIVE_STATE_MEMO_MS); the
    // host's end action clears it, this direct update does not. Within those 2 s the replay
    // player read "live", reloaded, and came back paused at 00:00, before the poll's window.
    await new Promise((r) => setTimeout(r, 2500));
    await watch(page, token, "replay");
    await answerAndClick(page, "Nee");
    await page.waitForResponse((r) => r.url().endsWith("/api/webinar/heartbeat"), { timeout: 40_000 });

    const rows = await e2eRows<{ kind: string; mode: string; n: number }>(sql`
      select kind::text, mode::text, count(*)::int as n from webinar_interactions
      where registration_id = ${registrationId}::uuid and kind in ('poll_answer', 'cta_clicked') group by 1, 2 order by 1, 2`);
    expect(rows).toEqual([
      { kind: "cta_clicked", mode: "live", n: 1 },
      { kind: "cta_clicked", mode: "replay", n: 1 },
      { kind: "poll_answer", mode: "live", n: 1 },
      { kind: "poll_answer", mode: "replay", n: 1 },
    ]);
    const [facts] = await e2eRows<Record<string, number | boolean>>(sql`
      select poll_answers_live, poll_answers_replay, cta_clicks_live, cta_clicks_replay, live_watched_sec, replay_watched_sec
      from v_webinar_registration_facts where registration_id = ${registrationId}::uuid`);
    expect(facts).toMatchObject({ poll_answers_live: 1, poll_answers_replay: 1, cta_clicks_live: 1, cta_clicks_replay: 1 });
    expect(Number(facts!.live_watched_sec)).toBeGreaterThan(0);
    expect(Number(facts!.replay_watched_sec)).toBeGreaterThan(0);
    const events = await e2eRows<{ kind: string; mode: string }>(sql`
      select kind, mode::text from activity_events where ref_type = 'webinar_registration' and ref_id = ${registrationId}
        and kind in ('webinar.poll_answered', 'webinar.cta_clicked') order by kind, mode`);
    expect(events).toEqual([
      { kind: "webinar.cta_clicked", mode: "live" },
      { kind: "webinar.cta_clicked", mode: "replay" },
      { kind: "webinar.poll_answered", mode: "live" },
      { kind: "webinar.poll_answered", mode: "replay" },
    ]);

    // The host console keeps live results apart from replay answers.
    await host.reload();
    const hostPoll = host.getByTestId("host-poll");
    await expect(hostPoll).toContainText(/1 (antwoorden|answers|réponses) \((live|direct)\)/);
    await expect(hostPoll).toContainText(/: 1 (antwoorden|answers|réponses)/);

    // Registration is not attendance: the second registrant never watched.
    const [absentFacts] = await e2eRows<{ live_attended: boolean; live_started: boolean }>(sql`
      select live_attended, live_started from v_webinar_registration_facts where registration_id = ${other.registrationId}::uuid`);
    expect(absentFacts).toMatchObject({ live_attended: false });
    const attendedEvents = await e2eRows<{ n: number }>(sql`
      select count(*)::int as n from activity_events where ref_type = 'webinar_registration' and ref_id = ${other.registrationId} and kind in ('webinar.attended', 'webinar.watched', 'webinar.started')`);
    expect(attendedEvents[0]!.n).toBe(0);
    await viewerContext.close();
    await host.context().close();
  });
});
