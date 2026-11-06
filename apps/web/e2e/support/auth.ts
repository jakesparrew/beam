import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, type Response } from "@playwright/test";
import { TOTP, Secret } from "otpauth";
import { sql } from "drizzle-orm";
import type { Db } from "@beam/db";
import { e2eDb, e2eRows } from "./db";
import { latestEmail } from "./sink";

export type DemoRole =
  | "owner"
  | "management"
  | "customer_service"
  | "sales"
  | "marketing"
  | "finance"
  | "reception"
  | "technical_admin"
  | "external_partner";

export const demoStaffEmail = (role: DemoRole) => `${role}@demo.beam.be`;

const here = path.dirname(fileURLToPath(import.meta.url));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type LoginCatalogue = { invalid_credentials: string; locked: string; rate_limited: string };
type MfaCatalogue = { invalid_code: string };
const platformCatalogues = (["nl-BE", "fr-BE", "en"] as const).map((locale) => {
  const file = path.join(here, `../../../../packages/core/src/i18n/messages/${locale}/platform.json`);
  return (JSON.parse(readFileSync(file, "utf8")) as { platform: { login: LoginCatalogue; mfa: MfaCatalogue } }).platform;
});
const loginCatalogues: LoginCatalogue[] = platformCatalogues.map((c) => c.login);
/** The text before the first ICU argument (`rate_limited` ends in a plural of minutes). */
const leadingText = (message: string) => message.split("{")[0]!.trim();

/**
 * The staff login's catalogue messages, in any of the three locales: wrong credentials, and
 * "locked until HH:MM" (`{time}` matched as two-digit hours and minutes).
 */
export const staffLoginMessages = {
  invalidCredentials: new RegExp(loginCatalogues.map((c) => escapeRe(c.invalid_credentials)).join("|")),
  locked: new RegExp(loginCatalogues.map((c) => escapeRe(c.locked).replace(escapeRe("{time}"), "\\d{2}[:.]\\d{2}")).join("|")),
  /** PL-68: 10 password sign-ins per IP per minute, 20 per account per hour. */
  rateLimited: new RegExp(loginCatalogues.map((c) => escapeRe(leadingText(c.rate_limited))).join("|")),
  /** A wrong or replayed TOTP code. */
  invalidCode: new RegExp(platformCatalogues.map((c) => escapeRe(c.mfa.invalid_code)).join("|")),
};

/**
 * The error box of the sign-in forms. Next.js renders a 1px route announcer with `role="alert"`
 * (`#__next-route-announcer__`, in a shadow root) on every page, so a bare `getByRole("alert")`
 * is visible before the server action has answered; this locator leaves the announcer out.
 */
export const formError = (page: Page): Locator => page.locator('[role="alert"]:not(#__next-route-announcer__)');

/**
 * Clicks a submit button and resolves once the server action's POST to the current page has
 * answered. Next.js sends the response headers only after the action has returned, so its database
 * writes have landed; the client renders the result (error box or navigation) right after, which
 * callers assert on. (`response.finished()` is not awaited: the action's flight stream can stay
 * open while the client navigates.)
 */
export async function submitAndWait(page: Page, button: Locator = page.locator('form button[type="submit"]').first()): Promise<Response> {
  const pathname = new URL(page.url()).pathname;
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === pathname),
    button.click(),
  ]);
  return response;
}

/** Waits for `url`, or returns the form's error text when the form shows one instead. */
async function urlOrFormError(page: Page, url: RegExp | ((u: URL) => boolean)): Promise<string | null> {
  const error = formError(page);
  const reached = page.waitForURL(url).then(() => "url" as const);
  const failed = error.waitFor({ state: "visible" }).then(() => "error" as const);
  // The loser keeps waiting until the page closes; keep its rejection from going unhandled.
  reached.catch(() => undefined);
  failed.catch(() => undefined);
  const outcome = await Promise.race([reached, failed]);
  return outcome === "error" ? ((await error.textContent())?.trim() ?? "") : null;
}

/** Waits for `url`, failing at once with the form's error text when the form shows one instead. */
async function waitForUrlOrFormError(page: Page, url: RegExp | ((u: URL) => boolean), what: string): Promise<void> {
  const error = await urlOrFormError(page, url);
  if (error !== null) throw new Error(`${what} failed: ${error}`);
}

/** The code of `DEMO_TOTP_SECRET` at `ms` (epoch milliseconds). */
function demoTotpAt(ms: number): string {
  const secret = process.env.DEMO_TOTP_SECRET;
  if (!secret) throw new Error("DEMO_TOTP_SECRET is not set");
  return TOTP.generate({ secret: Secret.fromBase32(secret.replace(/\s/g, "").toUpperCase()), algorithm: "SHA1", digits: 6, period: 30, timestamp: ms });
}

/** The current code of `DEMO_TOTP_SECRET`, waiting for a fresh step when the current one was used. */
export async function demoTotp(previous?: string): Promise<string> {
  let code = demoTotpAt(Date.now());
  while (previous && code === previous) {
    await new Promise((r) => setTimeout(r, 1000));
    code = demoTotpAt(Date.now());
  }
  return code;
}

const totpStep = (ms: number = Date.now()) => Math.floor(ms / 30_000);

/** The last TOTP step the server accepted for the user: `rate_limits` row `totp_used:<user id>`, as `storeTotpCounter` (lib/auth.ts) writes it. */
async function usedTotpStep(db: Pick<Db, "execute">, email: string): Promise<number> {
  const result: unknown = await db.execute(
    sql`select floor(extract(epoch from r.window_start) / 30)::bigint as c from rate_limits r
      join users u on r.key = 'totp_used:' || u.id::text where lower(u.email) = ${email.toLowerCase()}`,
  );
  const rows = ((result as { rows?: { c: string | number | null }[] }).rows ?? []) as { c: string | number | null }[];
  return rows[0]?.c == null ? -1 : Number(rows[0].c);
}

/**
 * Enters a TOTP code on `/admin/mfa/verify` and waits for the redirect. A code is accepted once
 * per 30-second step (replay protection, PL-4), and every worker of every run on beam_dev signs
 * in as the same demo users, so:
 * - the step is taken under a Postgres advisory lock per user, held until the server has
 *   answered, so two sign-ins through this helper never present the same step;
 * - it waits until the current step is later than the last step the server accepted (the
 *   server's counter is the truth: a Playwright retry runs in a new worker without memory);
 * - when the code is refused and the server's counter shows that a sign-in outside this helper
 *   took that very step in between, it tries the next step; any other refusal fails.
 */
async function enterFreshTotp(page: Page, email: string): Promise<void> {
  const verifyUrl = page.url();
  const db = await e2eDb();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`e2e:totp:${email.toLowerCase()}`}))`);
    for (let attempt = 0; ; attempt++) {
      const used = await usedTotpStep(tx, email);
      while (totpStep() <= used) await new Promise((r) => setTimeout(r, 500));
      const now = Date.now();
      const step = totpStep(now);
      if (attempt > 0) await page.goto(verifyUrl);
      await page.locator('input[name="code"]').fill(demoTotpAt(now));
      await submitAndWait(page);
      const error = await urlOrFormError(page, (url) => !url.pathname.startsWith("/admin/mfa"));
      if (error === null) return;
      const takenElsewhere = staffLoginMessages.invalidCode.test(error) && (await usedTotpStep(tx, email)) >= step;
      if (!takenElsewhere || attempt >= 3) throw new Error(`TOTP step of ${email} failed: ${error}`);
    }
  });
}

/**
 * PL-68 allows 10 password sign-ins per IP per minute and 20 per account per hour. The suite
 * signs in as the demo owner more than 20 times, and parallel runs on beam_dev share the demo
 * accounts and the loopback IP, so a refused attempt clears this account's bucket and the
 * loopback IP buckets once and tries again (platform.spec.ts covers the limits themselves).
 */
async function clearLoginBuckets(email: string): Promise<void> {
  const digest = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  await e2eRows(sql`delete from rate_limits where key = ${`login:acct:${digest}`}
    or key in ('login:ip:127.0.0.1', 'login:ip:::1', 'login:ip:::ffff:127.0.0.1')`);
}

/** Signs a demo staff user in: password from `DEMO_STAFF_PASSWORD`, then a TOTP from `DEMO_TOTP_SECRET`. Callers close the e2e database in `afterAll` (`closeE2eDb()`). */
export async function signInStaff(page: Page, role: DemoRole, opts: { returnTo?: string } = {}): Promise<void> {
  const password = process.env.DEMO_STAFF_PASSWORD;
  if (!password) throw new Error("DEMO_STAFF_PASSWORD is not set");
  const email = demoStaffEmail(role);
  for (let attempt = 0; ; attempt++) {
    await page.goto(opts.returnTo ? `/admin/login?returnTo=${encodeURIComponent(opts.returnTo)}` : "/admin/login");
    await page.getByLabel(/e-?mail/i).fill(email);
    await page.locator('input[name="password"]').fill(password);
    await submitAndWait(page);
    const error = await urlOrFormError(page, /\/admin\/mfa\/verify/);
    if (error === null) break;
    if (attempt > 0 || !staffLoginMessages.rateLimited.test(error)) throw new Error(`Password sign-in of ${email} failed: ${error}`);
    await clearLoginBuckets(email);
  }
  await enterFreshTotp(page, email);
}

/** Requests a magic link on `/<seg>/account/login`, reads it from the sink, opens it and clicks "Sign in". */
export async function signInCustomer(page: Page, email: string, locale: "nl" | "fr" | "en" = "nl"): Promise<void> {
  const requestedAt = new Date(Date.now() - 2000);
  await page.goto(`/${locale}/account/login`);
  await page.locator('input[name="email"]').first().fill(email);
  await submitAndWait(page);
  await waitForUrlOrFormError(page, /\/account\/login\/check-email/, `Magic-link request for ${email}`);
  const mail = await latestEmail(email, { after: requestedAt, linkIncludes: "/account/login/verify" });
  const link = mail.links.find((l) => l.includes("/account/login/verify"));
  expect(link, "the magic-link email contains the verify link").toBeTruthy();
  const url = new URL(link!);
  await page.goto(`${url.pathname}${url.search}`);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((u) => u.pathname.startsWith(`/${locale}/account`) && !u.pathname.includes("/login"));
}
