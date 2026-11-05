/**
 * The V1 acceptance checklist (proposal section 12) as one Playwright spec, plus blueprint 76
 * "Email sends correctly" (gap G1), against a production build on beam_dev with the demo seed and
 * the provider fakes (platform-P12; first shell by platform-P7). `docs/plan/acceptance-v1.md`
 * maps every row to this file and to the module test that proves it in depth.
 *
 * - Core: a new customer registers by magic link, buys the 5-day package with the fake provider,
 *   books a day session with a credit, cancels it from `/nl/account/bookings/<id>` (credit back)
 *   and reschedules another from the same page (gap G11: a missing booking-P6 page fails here);
 *   the member price, a staff change, the CRM timeline, the revenue report and a persons export.
 * - Email: the booking confirmation reaches the sink exactly once, in Dutch, from `mail.beam.be`,
 *   with both parts and the legal footer, `email.sent` on the timeline, and a second run of the
 *   send job adds nothing; late-entry skips; one-click unsubscribe; hard bounce; dynamic blocks.
 * - Assessment: `recovery-check` (weighted, branched) updates an existing person, creates no
 *   newsletter consent, and its sensitive answers never reach the AI context.
 * - Waitlist: no second seat, claim window expiry, confirmed seat protected.
 * - GDPR: subject export, deletion propagation, consent history, suppression surviving an import.
 *
 * Rows the spec creates carry `E2E acceptance-v1` (sessions) or a unique `e2e+acceptance-...`
 * address; `resetAcceptanceRows()` runs before and after. Selectors are test ids, data attributes
 * and catalogue copy (`copy()`), never hard-coded Dutch. Server actions are awaited through their
 * POST response, never a bare `role=alert`.
 */
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { AI_ALLOWED_FIELDS, toAiContext } from "@beam/core/ai";
import { recoveryCheckSeed } from "@beam/core/forms";
import { IMPORT_PRESETS } from "@beam/core/ops";
import { claimToken, deriveClaimKey, hashToken } from "@beam/core/booking";
import { insertSeededTemplate } from "@beam/db/seed/email";
import { makePerson } from "@beam/db/testing";
import { bookings, waitlistEntries } from "@beam/db/schema";
import { expectAccessible } from "./support/a11y";
import { demoStaffEmail, signInCustomer, signInStaff } from "./support/auth";
import { closeE2eDb, e2eDb, e2eRows } from "./support/db";
import { uniqueEmail } from "./support/ids";
import {
  DAY,
  HOUR,
  MIN,
  acceptanceSession,
  anyLocale,
  bookingOf,
  buyPackage,
  clickAction,
  copy,
  dayCreditsOf,
  emailHashOf,
  eventually,
  inDays,
  newsletterReachable,
  one,
  personIdOf,
  preferenceToken,
  resendWebhook,
  resetAcceptanceRows,
  sentMessageOf,
  statusOfBooking,
  submitBooking,
} from "./support/acceptance-fixtures";

test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
const LOCALE = "nl-BE" as const;

/** The core customer: registered in test "register, book, pay and cancel", reused by later rows. */
const core = { email: uniqueEmail("acceptance-core"), personId: "", orderId: "", cancelledId: "", rescheduledId: "" };
const fx = { creditDay: "", creditDay2: "", rescheduleTarget: "", staffDay: "", full: "" };

test.beforeAll(async () => {
  await resetAcceptanceRows();
  fx.creditDay = (await acceptanceSession("credit day", { startsAt: inDays(3) })).id;
  fx.creditDay2 = (await acceptanceSession("credit day 2", { startsAt: inDays(4) })).id;
  fx.rescheduleTarget = (await acceptanceSession("reschedule target", { startsAt: inDays(5) })).id;
  fx.staffDay = (await acceptanceSession("staff day", { startsAt: inDays(6) })).id;
  const full = await acceptanceSession("full", { startsAt: inDays(7), capacitySeats: 1 });
  fx.full = full.id;
  const db = await e2eDb();
  const holder = await makePerson(db, { firstName: "E2E", lastName: "Acceptance holder", email: uniqueEmail("acceptance-holder") });
  await db.insert(bookings).values({ sessionId: full.id, personId: holder.id, status: "confirmed", paidWith: "free", source: "admin" });
});

test.afterAll(async () => {
  await resetAcceptanceRows();
  await closeE2eDb();
});

test.describe("V1 acceptance", () => {
  test.describe("Core", () => {
    // site-P2: the customer journey starts on the public site; the stable event link sends a
    // visitor without a session through the portal sign-in back to the booking page.
    test("A visitor starts on the public site and reaches booking through sign-in", async ({ page }) => {
      const home = await page.goto("/nl");
      expect(home?.status()).toBe(200);
      await expectAccessible(page);
      const [event] = await e2eRows<{ id: string }>(sql`
        select id from sessions where kind = 'event' and status = 'open' and starts_at > now() order by starts_at limit 1`);
      expect(event, "an upcoming seeded event session").toBeTruthy();
      await page.goto(`/nl/events/${event!.id}`);
      const tickets = page.locator('a[data-action="tickets"], a[data-action="waitlist"]').first();
      if ((await page.locator("[data-event]").count()) > 0) await tickets.click();
      await expect(page).toHaveURL((url) => url.pathname === "/nl/account/login" && url.searchParams.get("returnTo") === `/nl/account/book/${event!.id}`);
    });

    test("A customer can register, book, pay and cancel", async ({ page }) => {
      test.setTimeout(180_000);
      // Register: a new address signs in by magic link and gets a person and a portal user.
      await signInCustomer(page, core.email, "nl");
      core.personId = (await personIdOf(core.email))!;
      expect(core.personId, "the magic link created the person").toBeTruthy();

      // Pay: the 5-day package through the fake provider.
      core.orderId = await buyPackage(page, LOCALE);
      await expect.poll(() => dayCreditsOf(core.personId), { timeout: 30_000 }).toBe(5);

      // Book with a credit.
      await page.goto(`/nl/account/book/${fx.creditDay}`);
      await expect(page.getByTestId("book-form")).toBeVisible();
      await page.getByTestId("pay-credit").check();
      await submitBooking(page);
      await page.waitForURL(/\/nl\/account\/bookings\/[0-9a-f-]+\?done=booked/);
      await expect(page.getByTestId("booking-status")).toHaveText(copy(LOCALE, "booking.status.confirmed"));
      const booking = (await bookingOf(core.personId, fx.creditDay))!;
      expect(booking).toMatchObject({ status: "confirmed", paid_with: "credit" });
      core.cancelledId = booking.id;

      // Cancel from the booking page (G11): open the dialog, confirm, the credit comes back.
      await page.goto("/nl/account/bookings");
      await expect(page.getByTestId("bookings-list")).toBeVisible();
      await page.goto(`/nl/account/bookings/${booking.id}`);
      await expectAccessible(page);
      await page.getByTestId("cancel-booking").locator("summary").click();
      await expect(page.getByTestId("cancel-outcome")).toBeVisible();
      const cancelled = page.waitForResponse((r) => r.request().method() === "POST");
      await page.getByTestId("cancel-confirm").click();
      await cancelled;
      await page.waitForURL(/\?done=cancelled/);
      await expect(page.getByTestId("booking-cancelled")).toBeVisible();
      expect(await statusOfBooking(booking.id)).toBe("cancelled");
      await expect.poll(() => dayCreditsOf(core.personId)).toBe(5);
    });

    test("The package balance updates", async ({ page }) => {
      test.skip(!core.personId, "the core customer did not register");
      await signInCustomer(page, core.email, "nl");
      await page.goto(`/nl/account/book/${fx.creditDay2}`);
      await expect(page.getByText(copy(LOCALE, "booking.portalSession.credits_left", { count: 5 }))).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("pay-credit").check();
      await submitBooking(page);
      await page.waitForURL(/\/nl\/account\/bookings\/[0-9a-f-]+\?done=booked/);
      core.rescheduledId = (await bookingOf(core.personId, fx.creditDay2))!.id;
      expect(await dayCreditsOf(core.personId)).toBe(4);
      await page.goto(`/nl/account/book/${fx.creditDay}`);
      await expect(page.getByText(copy(LOCALE, "booking.portalSession.credits_left", { count: 4 }))).toBeVisible();
      await page.goto("/nl/account/packages");
      await expectAccessible(page);

      // Reschedule from the booking page (G11): pick the target session, confirm.
      await page.goto(`/nl/account/bookings/${core.rescheduledId}`);
      await page.getByTestId("reschedule-link").click();
      await page.waitForURL(/\/reschedule$/);
      await page.getByTestId(`target-${fx.rescheduleTarget}`).locator("input").check();
      const posted = page.waitForResponse((r) => r.request().method() === "POST");
      await page.getByTestId("reschedule-confirm").click();
      await posted;
      await page.waitForURL(/\?done=rescheduled/);
      expect((await bookingOf(core.personId, fx.rescheduleTarget))?.status).toBe("confirmed");
      expect(await statusOfBooking(core.rescheduledId)).toBe("cancelled");
      // A reschedule moves the credit: still 4 left.
      expect(await dayCreditsOf(core.personId)).toBe(4);
    });

    test("The member discount applies automatically", async ({ page }) => {
      // The demo seed has no member: a fresh customer becomes one by buying the monthly membership.
      const member = uniqueEmail("acceptance-member");
      const [price] = await e2eRows<{ base: number }>(sql`
        select v.amount_cents as base from price_versions v join products pr on pr.id = v.product_id
        where pr.sku = 'PKG-5-DAYS' and v.audience = 'public' order by v.version desc limit 1`);
      expect(price, "a public price for PKG-5-DAYS").toBeTruthy();
      await signInCustomer(page, member, "en");
      await buyPackage(page, "en", "MEMBER-MONTHLY");
      await eventually(
        () => one<{ id: string }>(sql`select m.id from memberships m join persons p on p.id = m.person_id where lower(p.email) = ${member} and m.status = 'active'`),
        30_000,
      );
      await page.goto("/en/account/shop");
      const tile = page.locator("li", { has: page.getByRole("link", { name: /5 day sessions package/i }) });
      await expect(tile.getByText("Member price")).toBeVisible();
      await expect(tile.getByText(`Normal price €${(Number(price!.base) / 100).toFixed(2)}`)).toBeVisible();
    });

    test("An administrator can change a booking", async ({ page }) => {
      const db = await e2eDb();
      const person = await makePerson(db, { firstName: "E2E", lastName: "Acceptance changed", email: uniqueEmail("acceptance-staff-change") });
      const [b] = await db.insert(bookings).values({ sessionId: fx.staffDay, personId: person.id, status: "confirmed", paidWith: "free", source: "admin" }).returning();
      await signInStaff(page, "customer_service", { returnTo: `/admin/bookings/${b!.id}` });
      await page.getByRole("button", { name: anyLocale("booking.session.cancel_booking") }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.locator('textarea[name="reason"]').fill("E2E acceptance staff change");
      await clickAction(page, dialog.locator('button[type="submit"]'));
      await expect.poll(() => statusOfBooking(b!.id)).toBe("cancelled");
    });

    test("The CRM shows the activity", async ({ page }) => {
      test.skip(!core.personId, "the core customer did not register");
      await signInStaff(page, "customer_service", { returnTo: `/admin/persons/${core.personId}` });
      await expect(page.getByTestId("person-360")).toBeVisible();
      const timeline = page.getByTestId("timeline");
      for (const kind of ["order.paid", "booking.confirmed", "booking.cancelled"]) {
        await expect(timeline.locator(`[data-testid="timeline-row"][data-kind="${kind}"]`).first(), kind).toBeVisible();
      }
      await expectAccessible(page);
    });

    test("Reports reflect the transaction", async ({ page, browser }) => {
      test.skip(!core.personId, "the core customer did not register");
      test.setTimeout(150_000);
      await signInStaff(page, "finance", { returnTo: "/admin/reports/revenue?period=day" });
      await expect(page).toHaveURL(/\/admin\/reports\/revenue/);
      const tile = async () => Number(await page.getByTestId("revenue-tile-day").getAttribute("data-value"));
      const before = await tile();
      // A second package paid with the fake provider while the report is open.
      const customer = await browser.newPage();
      await signInCustomer(customer, core.email, "nl");
      const orderId = await buyPackage(customer, LOCALE);
      await customer.close();
      const [order] = await e2eRows<{ total: number }>(sql`select total_cents as total from orders where id = ${orderId}::uuid`);
      await expect.poll(async () => (await page.reload(), tile()), { timeout: 60_000 }).toBeGreaterThanOrEqual(before + Number(order!.total));
      const csv = await page.request.get("/admin/reports/revenue/csv?period=day&vat=incl");
      expect(csv.status()).toBe(200);
      expect(await csv.text()).toContain("package");
    });

    test("Data can be exported", async ({ page }) => {
      test.setTimeout(180_000);
      const startedAt = new Date(Date.now() - 1000).toISOString();
      const owner = demoStaffEmail("owner");
      await signInStaff(page, "owner", { returnTo: "/admin/reports/exports" });
      const form = page.getByTestId("new-export");
      await form.locator('input[name="kind"][value="entity"]').check();
      await form.locator('select[name="entity"]').selectOption("persons");
      await clickAction(page, form.locator('button[type="submit"]'));
      const latest = () =>
        one<{ id: string; status: string }>(sql`select id, status::text as status from data_exports
          where created_by_user_id in (select id from users where lower(email) = lower(${owner})) and created_at >= ${startedAt}::timestamptz
          order by created_at desc limit 1`);
      await expect.poll(async () => (await latest())?.status ?? "missing", { timeout: 120_000, intervals: [1_000, 2_000, 3_000] }).toBe("done");
      const res = await page.request.get(`/admin/reports/exports/${(await latest())!.id}/download`);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("application/zip");
      const body = await res.body();
      expect(body.subarray(0, 4).toString("hex")).toBe("504b0304");
      expect(body.includes(Buffer.from("persons-1.csv"))).toBe(true);
    });
  });

  test.describe("Email", () => {
    // Blueprint 76 (gap G1, platform decision 115): the proposal's V1 row leaves it out.
    test("Email sends correctly: the booking confirmation reaches the sink once, in the person's locale, from mail.beam.be, with both parts and the legal footer", async ({ page }) => {
      test.skip(!core.cancelledId, "the core booking did not run");
      test.setTimeout(120_000);
      const key = `booking:${core.cancelledId}:confirmed`;
      const message = await eventually(() =>
        one<{ id: string; locale: string; from_domain: string; status: string; resend_id: string | null; rendered_file_id: string | null; to_email: string | null }>(sql`
          select id, locale, from_domain::text as from_domain, status::text as status, resend_id, rendered_file_id, to_email
          from email_messages where idempotency_key = ${key} and rendered_file_id is not null`),
      );
      const [count] = await e2eRows<{ n: number }>(sql`select count(*)::int as n from email_messages where idempotency_key = ${key}`);
      expect(count!.n, "exactly one confirmation message").toBe(1);
      expect(message.locale).toBe(LOCALE);
      expect(message.from_domain).toBe("mail.beam.be");
      expect(message.to_email?.toLowerCase()).toBe(core.email.toLowerCase());
      // `email.send` refuses a message without a plain-text part (`missing_text_part`), so `sent`
      // means both parts went out; their content is proved in test/seams-v1.test.ts.
      expect(["sent", "delivered"]).toContain(message.status);

      const [file] = await e2eRows<{ bytes: Uint8Array | Buffer | string }>(sql`select bytes from files where id = ${message.rendered_file_id}::uuid and kind = 'rendered_email'`);
      const html = typeof file!.bytes === "string" ? Buffer.from(file!.bytes.replace(/^\\x/, ""), "hex").toString("utf8") : Buffer.from(file!.bytes).toString("utf8");
      const [company] = await e2eRows<{ legal_name: string; enterprise_number: string }>(sql`
        select coalesce(value->>'legal_name', 'Vibrant Lifestyle Collective BV') as legal_name, coalesce(value->>'enterprise_number', '') as enterprise_number
        from settings where key = 'company'`);
      expect(html, "the legal footer names the company").toContain(company?.legal_name ?? "Vibrant Lifestyle Collective BV");

      // The timeline shows `email.sent` for this message.
      const sent = await e2eRows<{ n: number }>(sql`select count(*)::int as n from activity_events where kind = 'email.sent' and ref_type = 'email_message' and ref_id = ${message.id}`);
      expect(sent[0]!.n).toBe(1);
      await signInStaff(page, "customer_service", { returnTo: `/admin/persons/${core.personId}` });
      await expect(page.getByTestId("timeline").locator('[data-testid="timeline-row"][data-kind="email.sent"]').first()).toBeVisible();

      // A second run of the send job adds no second sink message.
      await e2eRows(sql`update jobs set status = 'pending', run_at = now(), locked_at = null, locked_by = null, finished_at = null where idempotency_key = ${`email:${message.id}`}`);
      await expect
        .poll(async () => (await one<{ status: string; done: boolean }>(sql`select status::text as status, finished_at is not null as done from jobs where idempotency_key = ${`email:${message.id}`}`)), { timeout: 60_000 })
        .toEqual({ status: "succeeded", done: true });
      const after = await one<{ resend_id: string | null; files: number; events: number }>(sql`
        select m.resend_id,
          (select count(*)::int from files f where f.kind = 'rendered_email' and f.name like ${`%${message.id}%`}) as files,
          (select count(*)::int from activity_events e where e.kind = 'email.sent' and e.ref_id = ${message.id}) as events
        from email_messages m where m.id = ${message.id}::uuid`);
      expect(after).toEqual({ resend_id: message.resend_id, files: 1, events: 1 });
    });

    test("Late-entry reminders are skipped", async ({ page }) => {
      test.setTimeout(240_000);
      const [journey] = await e2eRows<{ status: string }>(sql`select status::text as status from automations where slug = 'event-registration'`);
      test.skip(journey?.status !== "active", "the demo seed has no active event-registration journey");
      // A free event 48 hours away: the 7-day and 3-day reminders are already past at entry.
      const startsAt = new Date(Math.ceil((Date.now() + 2 * DAY) / MIN) * MIN);
      const event = await acceptanceSession("late-entry event", { kind: "event", startsAt, endsAt: new Date(startsAt.getTime() + 2 * HOUR), capacitySeats: 20, creditKind: null, productId: null });
      const email = uniqueEmail("acceptance-late-entry");
      await signInCustomer(page, email, "nl");
      await page.goto(`/nl/account/book/${event.id}`);
      await page.getByTestId("pay-free").check();
      await submitBooking(page);
      await expect(page.getByTestId("booking-status")).toBeVisible({ timeout: 30_000 });
      const personId = (await personIdOf(email))!;
      const booking = (await bookingOf(personId, event.id))!;
      const enrolment = await eventually(
        () =>
          one<{ id: string; next_step_key: string | null }>(sql`
          select e.id, e.next_step_key from automation_enrolments e join automations a on a.id = e.automation_id
          where a.slug = 'event-registration' and e.person_id = ${personId}::uuid and e.subject_key = ${`booking:${booking.id}`}`),
        180_000,
      );
      expect(enrolment.next_step_key).toBe("reminder_day_of");
      const runs = await e2eRows<{ step_key: string | null; outcome: string }>(sql`select step_key, outcome::text as outcome from automation_runs where enrolment_id = ${enrolment.id}::uuid`);
      expect(runs.filter((r) => r.outcome === "skipped_late_entry").map((r) => r.step_key).sort()).toEqual(["reminder_3d", "reminder_7d"]);
      // No reminder reached the sink; only the booking confirmation did.
      const delivered = await e2eRows<{ key: string }>(sql`select idempotency_key as key from email_messages where person_id = ${personId}::uuid and enrolment_id is not null and rendered_file_id is not null`);
      expect(delivered).toEqual([]);
    });

    test("An unsubscribe stops marketing within 15 minutes", async ({ request }) => {
      const db = await e2eDb();
      const email = uniqueEmail("acceptance-unsubscribe");
      const person = await makePerson(db, { firstName: "E2E", lastName: "Unsubscribe", email });
      await e2eRows(sql`update persons set email_hash = ${emailHashOf(email)} where id = ${person.id}::uuid`);
      await e2eRows(sql`insert into consent_records (person_id, purpose, status, method, source, wording_version, recorded_at, actor)
        values (${person.id}::uuid, 'newsletter', 'granted', 'form', 'e2e:acceptance-v1', 'newsletter@1', now() - interval '1 day', '{"kind":"system","id":null}'::jsonb)`);
      expect(await newsletterReachable(person.id)).toBe(true);
      const token = await preferenceToken(person.id, email, "unsubscribe");
      const postedAt = Date.now();
      const res = await request.post(`/api/public/unsubscribe/${token}`, { form: { "List-Unsubscribe": "One-Click" } });
      expect(res.status()).toBe(200);
      // The one-click POST writes the suppression at once: far inside the 15-minute window.
      const suppression = await eventually(() => one<{ reason: string; created_at: string }>(sql`select reason::text as reason, created_at from suppressions where email_hash = ${emailHashOf(email)} order by created_at desc limit 1`), 15 * MIN);
      expect(suppression.reason).toBe("unsubscribe");
      expect(new Date(suppression.created_at).getTime() - postedAt).toBeLessThan(15 * MIN);
      expect(await newsletterReachable(person.id)).toBe(false);
    });

    test("Hard bounces are suppressed", async ({ page, request }) => {
      const email = uniqueEmail("acceptance-bounce");
      await signInCustomer(page, email, "nl");
      const personId = (await personIdOf(email))!;
      const message = await eventually(() => sentMessageOf(personId));
      expect(await resendWebhook(request, { resendId: message.resend_id, to: email })).toBe(200);
      await expect.poll(async () => (await one<{ status: string }>(sql`select status::text as status from email_messages where id = ${message.id}::uuid`))?.status, { timeout: 60_000 }).toBe("bounced");
      const suppression = await eventually(() => one<{ reason: string }>(sql`select reason::text as reason from suppressions where email_hash = ${emailHashOf(email)} and reason = 'hard_bounce' limit 1`));
      expect(suppression.reason).toBe("hard_bounce");
      expect(await newsletterReachable(personId)).toBe(false);
    });

    test("Lead, customer and member content blocks display correctly", async ({ page }) => {
      const db = await e2eDb();
      const slug = `e2e-acceptance-blocks-${RUN}`;
      const text = (who: string) => `E2E ${who} block ${RUN}`;
      const id = (n: number) => `${n}${RUN}`.padEnd(10, "x").slice(0, 10);
      const dynamic = (l: string) => [
        {
          id: id(1),
          type: "dynamic",
          variants: (["lead", "customer", "member"] as const).map((status, i) => ({ when: { status }, blocks: [{ id: id(2 + i), type: "text", markdown: `${text(status)} ${l}` }] })),
          fallback: [{ id: id(5), type: "text", markdown: `${text("everyone")} ${l}` }],
        },
      ];
      const each = (s: string) => ({ "nl-BE": `${s} nl-BE`, "fr-BE": `${s} fr-BE`, en: `${s} en` });
      const { templateId } = await insertSeededTemplate(db, {
        slug,
        name: `E2E acceptance blocks ${RUN}`,
        kind: "marketing",
        purpose: "newsletter",
        subject: each("E2E blocks"),
        preheader: each("E2E blocks"),
        document: { schemaVersion: 1, locales: { "nl-BE": dynamic("nl-BE"), "fr-BE": dynamic("fr-BE"), en: dynamic("en") } } as never,
      });
      await signInStaff(page, "marketing", { returnTo: `/admin/templates/${templateId}/preview?locale=nl-BE&use=current&as=lead` });
      for (const who of ["lead", "customer", "member"] as const) {
        await page.goto(`/admin/templates/${templateId}/preview?locale=nl-BE&use=current&as=${who}`);
        const html = (await page.getByTestId("preview-iframe").getAttribute("srcdoc")) ?? "";
        expect(html, who).toContain(text(who));
        for (const other of ["lead", "customer", "member"].filter((o) => o !== who)) expect(html, `${who} hides ${other}`).not.toContain(text(other));
      }
    });
  });

  test.describe("Assessment", () => {
    const FR = "fr-BE" as const;
    const demo = recoveryCheckSeed({ baseUrl: "https://www.example.com" }).definition;
    const lbl = (key: string) => demo.fields[key]!.label[FR]!;
    const optLabel = (key: string, option: string) => (demo.fields[key] as { options?: { key: string; label: Record<string, string> }[] }).options!.find((o) => o.key === option)!.label[FR]!;
    const choose = async (page: Page, fieldLabel: string, optionLabel: string) =>
      page.getByRole("group", { name: new RegExp(fieldLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).getByLabel(optionLabel, { exact: true }).check();
    const routeDone = (page: Page, route: "save" | "submit") => page.waitForResponse((r) => r.url().includes("/api/public/forms/") && r.url().endsWith(`/${route}`) && r.request().method() === "POST");
    const existing = { email: `e2e-acceptance-assessment-${RUN}@demo.beam.be`, personId: "", submissionId: "" };

    test.beforeAll(async () => {
      // An existing customer record without a first name: the assessment fills it (fill-empty).
      const [row] = await e2eRows<{ id: string }>(sql`insert into persons (email, email_hash, locale, acquisition, is_tester)
        values (${existing.email}, ${emailHashOf(existing.email)}, 'fr-BE', '{"source":"manual"}'::jsonb, true) returning id`);
      existing.personId = row!.id;
    });

    test("A weighted, branched assessment works", async ({ page }) => {
      await page.goto("/fr/f/recovery-check?utm_source=facebook&utm_medium=paid_social");
      await expect(page.locator("h1")).toHaveText(demo.title[FR]!);
      await page.getByLabel(lbl("email")).fill(existing.email);
      await page.getByLabel(lbl("first_name")).fill("Lotte");
      await page.getByLabel((demo.fields.sensitive_consent as { wording: Record<string, string> }).wording[FR]!).check();
      let saved = routeDone(page, "save");
      await page.getByRole("button", { name: copy(FR, "forms.public.next") }).click();
      expect((await saved).status()).toBe(200);
      await choose(page, lbl("sleep_hours"), optLabel("sleep_hours", "5_6"));
      await choose(page, lbl("sleep_quality"), "2");
      await choose(page, lbl("stress_level"), "8");
      // Branching: the physical stress question appears only for a stress level of 6 or more.
      await expect(page.getByRole("group", { name: new RegExp(lbl("stress_physical").slice(0, 20)) })).toBeVisible();
      await choose(page, lbl("stress_physical"), copy(FR, "forms.public.yes"));
      saved = routeDone(page, "save");
      await page.getByRole("button", { name: copy(FR, "forms.public.next") }).click();
      expect((await saved).status()).toBe(200);
      await choose(page, lbl("movement"), optLabel("movement", "rarely"));
      await choose(page, lbl("screen_time"), optLabel("screen_time", "gt5"));
      const submitted = routeDone(page, "submit");
      await page.getByRole("button", { name: demo.settings.submitLabel[FR]! }).click();
      const res = await submitted;
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { resultUrl?: string };
      expect(body.resultUrl).toContain("/fr/f/recovery-check/r/");
      await page.goto(new URL(body.resultUrl!).pathname);
      // Weighted: the result shows the score of the weighted dimensions and a CTA.
      await expect(page.locator("[data-result-score]")).toBeVisible();
      await expect(page.locator("[data-cta]").first()).toBeVisible();
      const sub = await one<{ id: string; score: unknown; outcome_key: string | null }>(sql`
        select id, score, outcome_key from form_submissions where person_id = ${existing.personId}::uuid and status = 'completed' order by completed_at desc limit 1`);
      expect(sub?.outcome_key).toBeTruthy();
      expect(sub?.score, "the weighted score is stored").toBeTruthy();
      existing.submissionId = sub!.id;
    });

    test("An existing customer record is updated", async () => {
      test.skip(!existing.submissionId, "the assessment did not complete");
      const rows = await e2eRows<{ id: string; first_name: string | null }>(sql`select id, first_name from persons where lower(email) = ${existing.email} and erased_at is null`);
      expect(rows).toEqual([{ id: existing.personId, first_name: "Lotte" }]);
    });

    test("A result does not create newsletter consent", async () => {
      test.skip(!existing.submissionId, "the assessment did not complete");
      const [n] = await e2eRows<{ n: number }>(sql`select count(*)::int as n from consent_records where person_id = ${existing.personId}::uuid and purpose = 'newsletter'`);
      expect(n!.n).toBe(0);
      expect(await newsletterReachable(existing.personId)).not.toBe(true);
    });

    test("Sensitive free text is excluded from AI", async () => {
      test.skip(!existing.submissionId, "the assessment did not complete");
      // The sensitive answers are stored encrypted, apart from the plain answers.
      const sensitive = await e2eRows<{ field_key: string }>(sql`select field_key from form_sensitive_answers where submission_id = ${existing.submissionId}::uuid`);
      expect(sensitive.map((s) => s.field_key)).toEqual(expect.arrayContaining(["sleep_quality", "stress_level"]));
      const [plain] = await e2eRows<{ answers: string }>(sql`select coalesce(answers::text, '') as answers from form_submissions where id = ${existing.submissionId}::uuid`);
      expect(plain!.answers).not.toContain("sleep_quality");
      expect(plain!.answers).not.toContain("stress_level");
      // The AI context of the person's profile never carries them.
      const [profile] = await e2eRows<Record<string, unknown>>(sql`select * from v_person_profile where person_id = ${existing.personId}::uuid`);
      const context = toAiContext({ ...(profile ?? {}), sleep_quality: "2", stress_level: "8", free_text: `E2E sensitive ${RUN}` });
      for (const key of Object.keys(context)) expect(AI_ALLOWED_FIELDS as readonly string[]).toContain(key);
      expect(JSON.stringify(context)).not.toContain(`E2E sensitive ${RUN}`);
      const requests = await e2eRows<{ fields_sent: string[] | null }>(sql`select fields_sent from ai_requests`);
      for (const r of requests) for (const f of r.fields_sent ?? []) expect(["sleep_quality", "stress_level", "stress_physical", "free_text", "value_enc"]).not.toContain(f);
    });
  });

  test.describe("Waitlist", () => {
    const AUTH_SECRET = process.env.AUTH_SECRET ?? "";

    test("The same person cannot take a second seat", async ({ page }) => {
      test.skip(!core.personId, "the core customer did not register");
      await signInCustomer(page, core.email, "nl");
      for (let i = 0; i < 2; i++) {
        await page.goto(`/nl/account/book/${fx.rescheduleTarget}`);
        if ((await page.getByTestId("book-form").count()) === 0) break;
        await page.getByTestId("pay-credit").check();
        await submitBooking(page);
        await page.waitForLoadState("networkidle");
      }
      const [live] = await e2eRows<{ n: number }>(sql`
        select count(*)::int as n from bookings where person_id = ${core.personId}::uuid and session_id = ${fx.rescheduleTarget}::uuid and status in ('reserved', 'confirmed')`);
      expect(Number(live!.n)).toBe(1);
    });

    test("The claim window expires correctly", async ({ page }) => {
      const db = await e2eDb();
      const person = await makePerson(db, { firstName: "E2E", lastName: "Acceptance claimer", email: uniqueEmail("acceptance-claim") });
      const [entry] = await db
        .insert(waitlistEntries)
        .values({ sessionId: fx.full, personId: person.id, state: "offered", offersCount: 1, offeredAt: new Date(Date.now() - 3 * HOUR), offerExpiresAt: new Date(Date.now() - HOUR) })
        .returning();
      const token = claimToken(deriveClaimKey(AUTH_SECRET), entry!.id, 1);
      await e2eRows(sql`update waitlist_entries set claim_token_hash = ${hashToken(token)} where id = ${entry!.id}::uuid`);
      await page.goto(`/nl/claim/${token}`);
      await expect(page.getByText(copy(LOCALE, "booking.claim.expired"))).toBeVisible();
      const [seats] = await e2eRows<{ n: number }>(sql`select count(*)::int as n from bookings where session_id = ${fx.full}::uuid and person_id = ${person.id}::uuid`);
      expect(seats!.n).toBe(0);
    });

    test("A confirmed seat is protected", async ({ page }) => {
      const db = await e2eDb();
      const [holder] = await e2eRows<{ id: string; person_id: string }>(sql`select id, person_id from bookings where session_id = ${fx.full}::uuid and status = 'confirmed' limit 1`);
      const [entry] = await db.insert(waitlistEntries).values({ sessionId: fx.full, personId: holder!.person_id, state: "confirmed", offersCount: 1, bookingId: holder!.id }).returning();
      const token = claimToken(deriveClaimKey(AUTH_SECRET), entry!.id, 1);
      await e2eRows(sql`update waitlist_entries set claim_token_hash = ${hashToken(token)} where id = ${entry!.id}::uuid`);
      await page.goto(`/nl/claim/${token}`);
      await expect(page.getByText(copy(LOCALE, "booking.claim.already_claimed"))).toBeVisible();
      expect(await statusOfBooking(holder!.id)).toBe("confirmed");
    });
  });

  test.describe("GDPR", () => {
    /** Creates, verifies and runs a privacy request of `kind` from `/admin/privacy/new`; returns its id once done. */
    async function runPrivacyRequest(page: Page, personId: string, kind: "export" | "erase"): Promise<string> {
      await signInStaff(page, "owner", { returnTo: `/admin/privacy/new?personId=${personId}` });
      const form = page.getByTestId("privacy-new");
      await form.locator(`input[name="kind"][value="${kind}"]`).check();
      await form.locator('textarea[name="verificationNote"]').fill("Identity checked at the desk (acceptance-v1)");
      await clickAction(page, form.locator('button[type="submit"]'));
      await page.waitForURL(/\/admin\/privacy\/[0-9a-f-]{36}/);
      const requestId = page.url().match(/\/admin\/privacy\/([0-9a-f-]{36})/)![1]!;
      const verify = page.getByTestId("privacy-verify");
      await verify.locator('textarea[name="verificationNote"]').fill("Identity checked at the desk (acceptance-v1)");
      const ack = verify.locator('input[name="acknowledgeWarnings"]');
      if ((await ack.count()) > 0) await ack.check();
      await clickAction(page, verify.locator('button[type="submit"]'));
      await expect(page.getByTestId("privacy-status")).toHaveAttribute("data-status", "verified");
      await clickAction(page, page.getByTestId("privacy-run-now").locator('button[type="submit"]'));
      await expect
        .poll(async () => (await one<{ status: string }>(sql`select status::text as status from privacy_requests where id = ${requestId}::uuid`))?.status, { timeout: 240_000, intervals: [1_000, 2_000, 5_000] })
        .toBe("done");
      return requestId;
    }

    test("Export works", async ({ page }) => {
      test.setTimeout(300_000);
      const db = await e2eDb();
      const person = await makePerson(db, { firstName: "E2E", lastName: `Export${RUN}`, email: uniqueEmail("acceptance-export") });
      const requestId = await runPrivacyRequest(page, person.id, "export");
      await page.reload();
      await expect(page.getByTestId("privacy-status")).toHaveAttribute("data-status", "done");
      const res = await page.request.get(`/admin/privacy/${requestId}/download`);
      expect(res.status()).toBe(200);
      const body = await res.body();
      expect(body.subarray(0, 4).toString("hex")).toBe("504b0304");
    });

    test("Deletion propagates", async ({ page }) => {
      test.setTimeout(300_000);
      const db = await e2eDb();
      const email = uniqueEmail("acceptance-erase");
      const person = await makePerson(db, { firstName: "E2E", lastName: `Erase${RUN}`, email });
      await e2eRows(sql`update persons set email_hash = ${emailHashOf(email)} where id = ${person.id}::uuid`);
      await db.insert(bookings).values({ sessionId: fx.staffDay, personId: person.id, status: "confirmed", paidWith: "free", source: "admin" });
      await preferenceToken(person.id, email, "erase");
      const requestId = await runPrivacyRequest(page, person.id, "erase");
      const after = await one<{ erased_at: Date | null; email: string | null; last_name: string | null }>(sql`select erased_at, email, last_name from persons where id = ${person.id}::uuid`);
      expect(after!.erased_at).not.toBeNull();
      expect(after!.email).toBeNull();
      expect(after!.last_name).not.toBe(`Erase${RUN}`);
      for (const table of ["email_messages", "bookings"]) {
        const left = await one<{ n: number }>(sql`select count(*)::int as n from ${sql.raw(table)} where person_id = ${person.id}::uuid`);
        expect(left!.n, table).toBe(0);
      }
      const supp = await e2eRows<{ reason: string }>(sql`select reason::text as reason from suppressions where email_hash = ${emailHashOf(email)}`);
      expect(supp.map((s) => s.reason)).toContain("erased");
      const report = await one<{ report: unknown }>(sql`select report from privacy_requests where id = ${requestId}::uuid`);
      expect(JSON.stringify(report!.report)).not.toContain(email);
    });

    test("Consent history is kept", async ({ page }) => {
      const email = uniqueEmail("acceptance-consent");
      await signInCustomer(page, email, "nl");
      const personId = (await personIdOf(email))!;
      await page.goto("/nl/account/preferences");
      const newsletter = () => page.getByRole("switch").first();
      const save = () => clickAction(page, page.locator('main button:not([role="switch"])').first());
      for (const want of ["true", "false"]) {
        if ((await newsletter().getAttribute("aria-checked")) !== want) await newsletter().click();
        await save();
        await page.reload();
      }
      const history = await e2eRows<{ status: string }>(sql`select status::text as status from consent_records where person_id = ${personId}::uuid and purpose = 'newsletter' order by recorded_at, created_at`);
      expect(history.map((h) => h.status)).toEqual(["granted", "withdrawn"]);
      const [current] = await e2eRows<{ status: string }>(sql`select status::text as status from v_consent_current where person_id = ${personId}::uuid and purpose = 'newsletter'`);
      expect(current!.status).toBe("withdrawn");
    });

    test("Suppression survives an import", async ({ request }) => {
      test.setTimeout(180_000);
      const db = await e2eDb();
      const email = uniqueEmail("acceptance-survivor");
      const person = await makePerson(db, { firstName: "E2E", lastName: "Survivor", email });
      await e2eRows(sql`update persons set email_hash = ${emailHashOf(email)} where id = ${person.id}::uuid`);
      // Unsubscribed through the one-click URL of an email footer.
      const token = await preferenceToken(person.id, email, "survivor");
      expect((await request.post(`/api/public/unsubscribe/${token}`, { form: { "List-Unsubscribe": "One-Click" } })).status()).toBe(200);
      await eventually(() => one<{ id: string }>(sql`select id from suppressions where email_hash = ${emailHashOf(email)}`));

      // A Mailchimp audience export that still lists the address as subscribed.
      const owner = await one<{ id: string }>(sql`select id::text as id from users where lower(email) = lower(${demoStaffEmail("owner")})`);
      const csv = `Email Address,Status,CONFIRM_TIME,Source\n${email.toUpperCase()},subscribed,2026-02-01T10:00:00Z,Mailchimp form\n`;
      const file = await one<{ id: string }>(sql`insert into files (kind, name, mime, size_bytes, bytes, sha256)
        values ('import', 'acceptance-mailchimp.csv', 'text/csv', ${Buffer.byteLength(csv)}, ${Buffer.from(csv)}, ${createHash("sha256").update(csv).digest("hex")}) returning id::text as id`);
      const mapping = {
        columns: { ...IMPORT_PRESETS.mailchimp_consents.columns },
        options: { delimiter: ",", dateFormat: "iso", defaultLocale: "nl-BE", overwrite: false, preset: "mailchimp_consents", consentPurpose: "newsletter" },
      };
      const imp = await one<{ id: string }>(sql`insert into imports (kind, source, name, file_id, created_by_user_id, header, mapping, status, is_dry_run, run_seq)
        values ('consents', 'mailchimp', ${`E2E acceptance-v1 survivor ${RUN}`}, ${file!.id}::uuid, ${owner!.id}::uuid, ${["Email Address", "Status", "CONFIRM_TIME", "Source"]}::text[],
                ${JSON.stringify(mapping)}::jsonb, 'dry_run', true, 1) returning id::text as id`);
      await e2eRows(sql`insert into jobs (kind, payload, idempotency_key, lane, priority, max_attempts)
        values ('import.parse', ${JSON.stringify({ importId: imp!.id, runSeq: 1 })}::jsonb, ${`import:${imp!.id}:1:parse`}, 'bulk', 5, 6)`);
      const row = await eventually(
        () => one<{ status: string; message: string | null }>(sql`select dry_run_status::text as status, message from import_rows where import_id = ${imp!.id}::uuid and row_number = 1 and dry_run_status is not null`),
        120_000,
      );
      expect(row).toEqual({ status: "skipped", message: "suppressed" });
      expect(await newsletterReachable(person.id)).toBe(false);
      const [imported] = await e2eRows<{ n: number }>(sql`select count(*)::int as n from consent_records where person_id = ${person.id}::uuid and method = 'import'`);
      expect(imported!.n).toBe(0);
    });
  });
});
