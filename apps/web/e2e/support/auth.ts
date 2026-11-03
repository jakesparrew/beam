import { expect, type Page } from "@playwright/test";
import { TOTP, Secret } from "otpauth";
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

let lastCode: string | undefined;

/** Signs a demo staff user in: password from `DEMO_STAFF_PASSWORD`, then a TOTP from `DEMO_TOTP_SECRET`. */
export async function signInStaff(page: Page, role: DemoRole, opts: { returnTo?: string } = {}): Promise<void> {
  const password = process.env.DEMO_STAFF_PASSWORD;
  if (!password) throw new Error("DEMO_STAFF_PASSWORD is not set");
  await page.goto(opts.returnTo ? `/admin/login?returnTo=${encodeURIComponent(opts.returnTo)}` : "/admin/login");
  await page.getByLabel(/e-?mail/i).fill(demoStaffEmail(role));
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/admin\/mfa\/verify/);
  // A code is accepted once per 30-second step (replay protection), so wait for a fresh one.
  lastCode = await demoTotp(lastCode);
  await page.locator('input[name="code"]').fill(lastCode);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/admin/mfa"));
}

/** Requests a magic link on `/<seg>/account/login`, reads it from the sink, opens it and clicks "Sign in". */
export async function signInCustomer(page: Page, email: string, locale: "nl" | "fr" | "en" = "nl"): Promise<void> {
  const requestedAt = new Date(Date.now() - 2000);
  await page.goto(`/${locale}/account/login`);
  await page.locator('input[name="email"]').first().fill(email);
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL(/\/account\/login\/check-email/);
  const mail = await latestEmail(email, { after: requestedAt });
  const link = mail.links.find((l) => l.includes("/account/login/verify"));
  expect(link, "the magic-link email contains the verify link").toBeTruthy();
  const url = new URL(link!);
  await page.goto(`${url.pathname}${url.search}`);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((u) => u.pathname.startsWith(`/${locale}/account`) && !u.pathname.includes("/login"));
}
