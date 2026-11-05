/**
 * webinar-P4 (spec section 12, rules 19-25, 44, section 9.3): watching through the personal link.
 *
 * 1. Fake player: an on-demand webinar whose recording id starts with `fake_` renders the YouTube
 *    fake's simulated player (a 1-second timer), so no request goes to youtube.com. Open the token
 *    link, accept the notice, play and toggle captions with the keyboard only, wait for 3
 *    heartbeats, and the admin registrations page shows the watch minutes the database holds.
 * 2. IFrame API stub: for a real-looking video id the player loads `iframe_api` through
 *    `next/script`; the spec answers that request with a stub (no youtube.com), checks the
 *    `<script>` carries the CSP nonce of the page response and that no CSP violation is reported,
 *    and that the player is created on `youtube-nocookie.com`.
 *
 * Release 2: skipped while `ff_webinar_portal` is off. The spec creates its own two webinars
 * (slugs `e2e-watch-*`, owned by the demo owner) and registers a fresh `@example.com` address
 * through the public route; it removes its rows before and after (under `beam.allow_rewrite`,
 * because the segments and interactions are append-only). It never waits on a bare
 * `role="alert"` (CONVENTIONS item 11): it waits for the POST responses.
 */
import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { deriveAccessKey, signAccessToken } from "@beam/core/webinar";
import { signInStaff } from "./support/auth";
import { closeE2eDb, e2eDb, e2eRows } from "./support/db";

const stamp = Date.now().toString(36);
const FAKE = { slug: `e2e-watch-fake-${stamp}`, video: "fake_e2ewat" };
const REAL = { slug: `e2e-watch-real-${stamp}`, video: "e2eRealVid1" };
const email = `webinar-watch-${stamp}@example.com`;
const TITLE = { "nl-BE": "E2E kijken", "fr-BE": "E2E regarder", en: "E2E watching" };

async function flagOn(): Promise<boolean> {
  const rows = await e2eRows<{ state: string }>(sql`select state::text as state from feature_flags where key = 'ff_webinar_portal'`);
  return rows[0]?.state === "on";
}

async function cleanup(): Promise<void> {
  const db = await e2eDb();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('beam.allow_rewrite', 'on', true)`);
    await tx.execute(sql`delete from webinar_registrations where webinar_id in (select id from webinars where slug in (${FAKE.slug}, ${REAL.slug}))`);
    await tx.execute(sql`delete from webinars where slug in (${FAKE.slug}, ${REAL.slug})`);
  });
}

async function createWebinar(slug: string, video: string): Promise<string> {
  const rows = await e2eRows<{ id: string }>(sql`
    insert into webinars (slug, title, description, mode, status, published_at, recording_video_id, duration_sec, owner_user_id, created_by_user_id)
    select ${slug}, ${JSON.stringify(TITLE)}::jsonb, '{}'::jsonb, 'on_demand', 'published', now(), ${video}, 1800, u.id, u.id
    from users u where lower(u.email) = 'owner@demo.beam.be'
    returning id::text as id`);
  if (!rows[0]) throw new Error("demo owner user missing");
  return rows[0].id;
}

/** Registers `email` through the public route and returns the personal token (signed like the access email). */
async function register(page: Page, slug: string): Promise<{ token: string; registrationId: string }> {
  const res = await page.request.post(`/api/public/webinars/${slug}/register`, {
    data: { email, firstName: "Wanda", lastName: "Kijker", locale: "nl-BE", consents: {}, wordingVersion: "v1", utm: {} },
  });
  expect(res.status()).toBe(202);
  const rows = await e2eRows<{ id: string; token_version: number }>(sql`
    select r.id::text as id, r.token_version from webinar_registrations r join persons p on p.id = r.person_id join webinars w on w.id = r.webinar_id
    where w.slug = ${slug} and lower(p.email) = ${email.toLowerCase()}`);
  const reg = rows[0];
  if (!reg) throw new Error("registration missing");
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return { registrationId: reg.id, token: signAccessToken(deriveAccessKey(secret), reg.id, Number(reg.token_version)) };
}

/** Collects `securitypolicyviolation` events of every document the page opens. */
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}

test.describe("webinar watching (webinar-P4)", () => {
  let fakeId = "";
  let realId = "";

  test.beforeAll(async () => {
    if (!(await flagOn())) return;
    await cleanup();
    fakeId = await createWebinar(FAKE.slug, FAKE.video);
    realId = await createWebinar(REAL.slug, REAL.video);
  });
  test.afterAll(async () => {
    await cleanup().catch(() => undefined);
    await closeE2eDb();
  });

  test("fake player: notice, play and captions by keyboard, 3 heartbeats, watch minutes on the admin page", async ({ page }) => {
    test.skip(!(await flagOn()), "ff_webinar_portal is off (Release 2)");
    test.setTimeout(150_000);
    await page.route("https://www.youtube.com/**", (route) => route.abort());
    const violations = await watchCsp(page);
    const { token, registrationId } = await register(page, FAKE.slug);

    await page.goto(`/nl/w/${token}`);
    await expect(page.getByRole("heading", { name: "E2E kijken" })).toBeVisible();
    const accept = page.getByRole("button", { name: "Video laden" });
    await accept.focus();
    const viewed = page.waitForResponse((r) => r.url().endsWith("/api/webinar/view") && r.request().method() === "POST");
    await page.keyboard.press("Enter");
    expect((await viewed).status()).toBe(200);

    const player = page.getByTestId("webinar-fake-player");
    await expect(player).toBeVisible();
    await page.getByRole("button", { name: "Afspelen" }).focus();
    await page.keyboard.press("Space");
    await expect(player).toHaveAttribute("data-state", "playing");

    const captions = page.getByRole("button", { name: "Ondertitels aanzetten" });
    await captions.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Ondertitels uitzetten" })).toHaveAttribute("aria-pressed", "true");
    // The captions toggle reloads the player; play again by keyboard.
    await page.getByRole("button", { name: "Afspelen" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("webinar-fake-player")).toHaveAttribute("data-state", "playing");

    for (let i = 0; i < 3; i++) {
      const beat = await page.waitForResponse((r) => r.url().endsWith("/api/webinar/heartbeat") && r.request().method() === "POST", { timeout: 40_000 });
      expect(beat.status()).toBe(200);
    }
    expect(await violations()).toEqual([]);

    const [watch] = await e2eRows<{ sec: number }>(sql`select coalesce(sum(watched_sec), 0)::int as sec from v_webinar_watch where registration_id = ${registrationId}::uuid and mode = 'on_demand'`);
    expect(watch!.sec).toBeGreaterThan(0);
    const expected = Math.round(watch!.sec / 60);

    await signInStaff(page, "owner", { returnTo: `/admin/webinars/${fakeId}/registrations` });
    await page.goto(`/admin/webinars/${fakeId}/registrations`);
    const row = page.getByRole("row").filter({ hasText: email });
    await expect(row).toBeVisible();
    await expect(row).toContainText(new RegExp(`/\\s*${expected}\\s*min`));
  });

  test("IFrame API stub: the script carries the CSP nonce, no violation, nocookie host", async ({ page }) => {
    test.skip(!(await flagOn()), "ff_webinar_portal is off (Release 2)");
    const violations = await watchCsp(page);
    await page.route("https://www.youtube.com/iframe_api", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `window.YT = { Player: function (el, opts) {
          el.setAttribute("data-stub-video", opts.videoId); el.setAttribute("data-stub-host", opts.host);
          this.getCurrentTime = function () { return 0; }; this.getPlayerState = function () { return 2; };
          this.seekTo = function () {}; this.destroy = function () {};
        } };
        if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady();`,
      }),
    );
    const { token } = await register(page, REAL.slug);
    const doc = await page.goto(`/nl/w/${token}`);
    const csp = (await doc!.headerValue("content-security-policy")) ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce, "the page response carries a CSP nonce").toBeTruthy();
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");

    await page.getByRole("button", { name: "Video laden" }).focus();
    const viewed = page.waitForResponse((r) => r.url().endsWith("/api/webinar/view"));
    await page.keyboard.press("Enter");
    expect((await viewed).status()).toBe(200);
    const script = page.locator('script[src="https://www.youtube.com/iframe_api"]');
    await expect(script).toHaveCount(1);
    expect(await script.evaluate((el) => (el as HTMLScriptElement).nonce)).toBe(nonce);
    await expect(page.locator(`[data-stub-video="${REAL.video}"]`)).toHaveAttribute("data-stub-host", "https://www.youtube-nocookie.com");
    expect(await violations()).toEqual([]);
    expect(realId).not.toBe("");
  });
});
