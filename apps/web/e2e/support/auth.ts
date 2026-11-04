import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, type Response } from "@playwright/test";
import { TOTP, Secret } from "otpauth";
import { sql } from "drizzle-orm";
import { e2eRows } from "./db";
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

type LoginCatalogue = { invalid_credentials: string; locked: string };
const loginCatalogues: LoginCatalogue[] = (["nl-BE", "fr-BE", "en"] as const).map((locale) => {
  const file = path.join(here, `../../../../packages/core/src/i18n/messages/${locale}/platform.json`);
  return (JSON.parse(readFileSync(file, "utf8")) as { platform: { login: LoginCatalogue } }).platform.login;
});

/**
 * The staff login's catalogue messages, in any of the three locales: wrong credentials, and
 * "locked until HH:MM" (`{time}` matched as two-digit hours and minutes).
 */
export const staffLoginMessages = {
  invalidCredentials: new RegExp(loginCatalogues.map((c) => escapeRe(c.invalid_credentials)).join("|")),
  locked: new RegExp(loginCatalogues.map((c) => escapeRe(c.locked).replace(escapeRe("{time}"), "\\d{2}[:.]\\d{2}")).join("|")),
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

/** Waits for `url`, failing at once with the form's error text when the form shows one instead. */
async function waitForUrlOrFormError(page: Page, url: RegExp | ((u: URL) => boolean), what: string): Promise<void> {
  const error = formError(page);
  const reached = page.waitForURL(url).then(() => "url" as const);
  const failed = error.waitFor({ state: "visible" }).then(() => "error" as const);
  // The loser keeps waiting until the page closes; keep its rejection from going unhandled.
  reached.catch(() => undefined);
  failed.catch(() => undefined);
  const outcome = await Promise.race([reached, failed]);
  if (outcome === "error") throw new Error(`${what} failed: ${(await error.textContent())?.trim() ?? ""}`);
}

/** The current code of `DEMO_TOTP_SECRET`, waiting for a fresh step when the current one was used. */
export async function demoTotp(previous?: string): Promise<string> {
  const secret = process.env.DEMO_TOTP_SECRET;
  if (!secret) throw new Error("DEMO_TOTP_SECRET is not set");
  const make = () => TOTP.generate({ secret: Secret.fromBase32(secret.replace(/\s/g, "").toUpperCase()), algorithm: "SHA1", digits: 6, period: 30 });
  let code = make();
  while (previous && code === previous) {
    await new Promise((r) => setTimeout(r, 1000));
    code = make();
  }
  return code;
}

/**
 * Waits until the current TOTP step is later than the last step the server accepted for the
 * user (`rate_limits` row `totp_used:<user id>`), so a code is never a replay. The server's
 * counter is the truth: a Playwright retry runs in a new worker without any in-memory state.
 */
async function waitForFreshTotpStep(email: string): Promise<void> {
  const [row] = await e2eRows<{ c: string | number | null }>(
    sql`select floor(extract(epoch from r.window_start) / 30)::bigint as c from rate_limits r
      join users u on r.key = 'totp_used:' || u.id::text where lower(u.email) = ${email.toLowerCase()}`,
  );
  const used = row?.c == null ? -1 : Number(row.c);
  while (Math.floor(Date.now() / 30_000) <= used) await new Promise((r) => setTimeout(r, 1000));
}

/** Signs a demo staff user in: password from `DEMO_STAFF_PASSWORD`, then a TOTP from `DEMO_TOTP_SECRET`. Callers close the e2e database in `afterAll` (`closeE2eDb()`). */
export async function signInStaff(page: Page, role: DemoRole, opts: { returnTo?: string } = {}): Promise<void> {
  const password = process.env.DEMO_STAFF_PASSWORD;
  if (!password) throw new Error("DEMO_STAFF_PASSWORD is not set");
  await page.goto(opts.returnTo ? `/admin/login?returnTo=${encodeURIComponent(opts.returnTo)}` : "/admin/login");
  await page.getByLabel(/e-?mail/i).fill(demoStaffEmail(role));
  await page.locator('input[name="password"]').fill(password);
  await submitAndWait(page);
  await waitForUrlOrFormError(page, /\/admin\/mfa\/verify/, `Password sign-in of ${demoStaffEmail(role)}`);
  // A code is accepted once per 30-second step (replay protection), so wait for a fresh one.
  await waitForFreshTotpStep(demoStaffEmail(role));
  await page.locator('input[name="code"]').fill(await demoTotp());
  await submitAndWait(page);
  await waitForUrlOrFormError(page, (url) => !url.pathname.startsWith("/admin/mfa"), `TOTP step of ${demoStaffEmail(role)}`);
}

/** Requests a magic link on `/<seg>/account/login`, reads it from the sink, opens it and clicks "Sign in". */
export async function signInCustomer(page: Page, email: string, locale: "nl" | "fr" | "en" = "nl"): Promise<void> {
  const requestedAt = new Date(Date.now() - 2000);
  await page.goto(`/${locale}/account/login`);
  await page.locator('input[name="email"]').first().fill(email);
  await submitAndWait(page);
  await waitForUrlOrFormError(page, /\/account\/login\/check-email/, `Magic-link request for ${email}`);
  const mail = await latestEmail(email, { after: requestedAt });
  const link = mail.links.find((l) => l.includes("/account/login/verify"));
  expect(link, "the magic-link email contains the verify link").toBeTruthy();
  const url = new URL(link!);
  await page.goto(`${url.pathname}${url.search}`);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((u) => u.pathname.startsWith(`/${locale}/account`) && !u.pathname.includes("/login"));
}
