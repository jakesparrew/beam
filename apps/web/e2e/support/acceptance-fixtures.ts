/**
 * Shared helpers of `e2e/acceptance-v1.spec.ts` (platform-P12): catalogue copy in a locale,
 * server-action waits, the fake payment page, the spec's own sessions and people, sink and
 * webhook helpers. Every row the spec creates is marked `E2E acceptance-v1` (session titles) or
 * uses a unique `e2e+acceptance-...@example.com` address, and `resetAcceptanceRows()` cancels the
 * spec's sessions before and after (runbook 3.6). Demo seed rows are never written.
 */
import { createHash } from "node:crypto";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { emailHash } from "@beam/core/crm";
import { createTranslator, lookupMessage, MESSAGES } from "@beam/core/i18n";
import { newLinkToken } from "@beam/core/email";
import { makeSession, type SessionRow } from "@beam/db/testing";
import { FAKE_RESEND_WEBHOOK_SECRET, signResendWebhook } from "@beam/integrations/resend";
import { e2eDb, e2eRows } from "./db";

export const MARK = "E2E acceptance-v1";
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const PACKAGE_SKU = "PKG-5-DAYS";

export type Locale = "nl-BE" | "fr-BE" | "en";
export type Segment = "nl" | "fr" | "en";
export const SEGMENT: Record<Locale, Segment> = { "nl-BE": "nl", "fr-BE": "fr", en: "en" };
const LOCALES: Locale[] = ["nl-BE", "fr-BE", "en"];

const t = createTranslator(MESSAGES, { mode: "throw" });

/** The catalogue text of `<module>.<path>` in `locale`, with ICU arguments (throws when missing). */
export function copy(locale: Locale, key: string, values: Record<string, string | number> = {}): string {
  return t(locale, key, values);
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A catalogue text in any of the three locales (staff accounts may use any). */
export function anyLocale(key: string): RegExp {
  return new RegExp(LOCALES.map((l) => escapeRe(lookupMessage(MESSAGES, l, key)!.split("{")[0]!.trim())).join("|"));
}

/** Clicks and resolves once the Server Action's POST has answered (never a bare role=alert wait). */
export async function clickAction(page: Page, target: Locator): Promise<void> {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await target.click();
  await response;
}

/** Pays on the fake provider page and waits for the return page's paid state. */
export async function payWithFake(page: Page): Promise<void> {
  await page.waitForURL(/\/api\/dev\/fake-pay\//);
  await page.getByTestId("fake-pay-paid").click();
  await page.waitForURL(/\/checkout\/return\//);
  await expect(page.locator('[data-return-phase="paid"]')).toBeVisible({ timeout: 35_000 });
}

/** The checkout page: ticks the terms box when shown, clicks Pay and waits for the action. */
export async function payCheckout(page: Page): Promise<void> {
  // The URL changes before the page renders: wait for Pay, so the terms box is counted on the page.
  const pay = page.getByRole("button", { name: /^(Betaal|Payer|Pay)\b/ });
  await expect(pay).toBeVisible();
  const terms = page.locator("#accept-terms");
  if ((await terms.count()) > 0) await terms.check();
  const posted = page.waitForResponse((r) => r.request().method() === "POST");
  await pay.click();
  await posted;
  await payWithFake(page);
}

/** Buys the 5-day package (or `sku`) in the portal with the fake provider; returns the paid order id. */
export async function buyPackage(page: Page, locale: Locale, sku: string = PACKAGE_SKU): Promise<string> {
  const seg = SEGMENT[locale];
  await page.goto(`/${seg}/account/shop/${sku}`);
  await page.getByRole("button", { name: copy(locale, "commerce.shop.buy_now") }).click();
  await page.waitForURL(new RegExp(`/${seg}/account/checkout\\?checkout=`));
  await payCheckout(page);
  const orderId = page.url().match(/\/checkout\/return\/([0-9a-f-]{36})/)?.[1];
  expect(orderId, "the return page names the order").toBeTruthy();
  await expect.poll(async () => (await one<{ status: string }>(sql`select status::text as status from orders where id = ${orderId!}::uuid`))?.status, { timeout: 30_000 }).toBe("paid");
  return orderId!;
}

/** Ticks the terms box when the booking form shows it, submits and waits for the action's POST. */
export async function submitBooking(page: Page): Promise<void> {
  // Wait for the rendered form before counting its terms box (a soft navigation renders later).
  const submit = page.getByTestId("book-submit");
  await expect(submit).toBeVisible();
  const terms = page.getByTestId("accept-terms");
  if ((await terms.count()) > 0) await terms.check();
  const posted = page.waitForResponse((r) => r.request().method() === "POST");
  await submit.click();
  await posted;
}

export async function one<T>(query: Parameters<typeof e2eRows>[0]): Promise<T | undefined> {
  return (await e2eRows<T>(query))[0];
}

export const personIdOf = async (email: string) => (await one<{ id: string }>(sql`select id from persons where lower(email) = ${email.toLowerCase()} and erased_at is null`))?.id;

/** Remaining day credits of a person: granted, minus live consumptions, plus releases (credits views). */
export async function dayCreditsOf(personId: string): Promise<number> {
  const row = await one<{ n: number | string | null }>(sql`
    select coalesce(sum(remaining_units), 0) as n from v_credit_grant_balances
    where person_id = ${personId}::uuid and credit_kind = 'day' and status = 'active'`);
  return Number(row?.n ?? 0);
}

export const bookingOf = async (personId: string, sessionId: string) =>
  one<{ id: string; status: string; paid_with: string; version: number }>(sql`
    select id, status::text as status, paid_with::text as paid_with, version from bookings
    where person_id = ${personId}::uuid and session_id = ${sessionId}::uuid order by created_at desc limit 1`);

export const statusOfBooking = async (id: string) => (await one<{ status: string }>(sql`select status::text as status from bookings where id = ${id}::uuid`))?.status;

const title = (tag: string) => ({ "nl-BE": `${MARK} ${tag}`, "fr-BE": `${MARK} ${tag}`, en: `${MARK} ${tag}` });

/** `d` days from now at 10:00 UTC (inside the free cancellation window of a day session). */
export const inDays = (d: number, hourUtc = 10) => {
  const t = new Date(Date.now() + d * DAY);
  t.setUTCHours(hourUtc, 0, 0, 0);
  return t;
};

/** A published day session of this spec (one day credit, 8 seats unless given). */
export async function acceptanceSession(tag: string, overrides: Parameters<typeof makeSession>[1] = {}): Promise<SessionRow> {
  return makeSession(await e2eDb(), { title: title(tag), startsAt: inDays(3), publishedAt: new Date(Date.now() - HOUR), capacitySeats: 8, creditKind: "day", creditCost: 1, ...overrides });
}

/** Cancels the spec's sessions (and their live bookings) and removes its waitlist entries. */
export async function resetAcceptanceRows(): Promise<void> {
  await e2eRows(sql`delete from waitlist_entries where session_id in (select id from sessions where title->>'en' like ${`${MARK}%`})`);
  await e2eRows(sql`update bookings set status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'staff', reserved_until = null, version = version + 1
    where status in ('reserved', 'confirmed') and session_id in (select id from sessions where title->>'en' like ${`${MARK}%`})`);
  await e2eRows(sql`update sessions set status = 'cancelled', cancelled_at = now(), cancel_reason = 'e2e reset' where status <> 'cancelled' and title->>'en' like ${`${MARK}%`}`);
}

/** The newest sent message of a person with its Resend id (sign-in, confirmation, ...). */
export async function sentMessageOf(personId: string): Promise<{ id: string; resend_id: string; to_email: string } | undefined> {
  return one(sql`select id, resend_id, to_email from email_messages where person_id = ${personId}::uuid and resend_id is not null order by queued_at desc limit 1`);
}

/** A signed fake Resend webhook (`email.bounced` Permanent by default) for a message's Resend id. */
export async function resendWebhook(request: APIRequestContext, input: { resendId: string; to: string; type?: "email.bounced" | "email.complained" }): Promise<number> {
  const at = new Date();
  const type = input.type ?? "email.bounced";
  const body = JSON.stringify({
    type,
    created_at: at.toISOString(),
    data: {
      email_id: input.resendId,
      created_at: at.toISOString(),
      to: [input.to],
      ...(type === "email.bounced" ? { bounce: { type: "Permanent", subType: "General", message: "Mailbox does not exist" } } : {}),
    },
  });
  const id = `msg_e2e_acceptance_${createHash("sha256").update(`${input.resendId}:${type}:${at.getTime()}`).digest("hex").slice(0, 16)}`;
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const secret = process.env.RESEND_WEBHOOK_SECRET || FAKE_RESEND_WEBHOOK_SECRET;
  const res = await request.post("/api/webhooks/resend", {
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signResendWebhook({ id, timestamp, body, secret }) },
    data: body,
  });
  return res.status();
}

/**
 * A preference token for a person: a sent transactional message row carrying the link token's
 * hash (the token every email footer links to, as `crm.spec.ts` builds it). Returns the token.
 */
export async function preferenceToken(personId: string, email: string, tag: string): Promise<string> {
  const link = newLinkToken();
  await e2eRows(sql`insert into email_messages (kind, locale, to_email, person_id, idempotency_key, status, sent_at, link_token_hash)
    values ('transactional', 'nl-BE', ${email}, ${personId}::uuid, ${`e2e:acceptance-v1:${tag}:${Date.now()}`}, 'sent', now(), ${link.hash})`);
  return link.token;
}

/** `v_marketing_reachability` for the newsletter purpose. */
export async function newsletterReachable(personId: string): Promise<boolean | undefined> {
  return (await one<{ is_reachable: boolean }>(sql`select is_reachable from v_marketing_reachability where person_id = ${personId}::uuid and purpose = 'newsletter'`))?.is_reachable;
}

export const emailHashOf = (email: string) => emailHash(email);

/** Polls `read` until it returns a value (not undefined), then returns it. */
export async function eventually<T>(read: () => Promise<T | undefined>, timeout = 60_000): Promise<T> {
  let value: T | undefined;
  await expect
    .poll(
      async () => {
        value = await read();
        return value !== undefined;
      },
      { timeout, intervals: [1_000, 2_000] },
    )
    .toBe(true);
  return value!;
}
