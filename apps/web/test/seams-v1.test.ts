/**
 * platform-P12: the three V1 seams with real module code on PGlite (platform spec 12, build
 * order risk 5). No module function is mocked; only Next.js request APIs are (`next/headers`,
 * `next/server`), and every provider is the fake of `createFakeIntegrations()`.
 *
 * 1. checkout -> credits -> booking: a portal order for the 5-day package (commerce `createOrder`
 *    and `startPayment`), the fake Mollie payment settled `paid`, `POST /api/webhooks/mollie`,
 *    then the job runner: `webhook.process` finalises the order and credits grants 5 day units;
 *    booking books a day session with a credit (4 left) and the customer cancels inside the
 *    rules: the credit comes back (5 left), and the timeline holds both facts.
 * 2. order -> invoice -> Billit: the same paid order has invoice `BEAM-<year>-000001` (the first
 *    number of the year), and the runner's `finance.render_pdf` and `billit.push_invoice` create
 *    the matching document in the Billit fake.
 * 3. form -> person -> automation -> email: a published automation listening to `form.completed`
 *    of the seeded `contact` form (built through automation's staff actions, with a template
 *    seeded through email's `seedTemplate`); a visitor submits the form through the public
 *    routes; the person is created, `automation.evaluate` enrols them, `automation.step` queues
 *    the email and `email.send` delivers it to the sink: one `email_messages` row with a stored
 *    rendered copy, sent through the Resend fake to `EMAIL_SINK`.
 *
 * A failing seam is written to `docs/build/seam-issues-v1.md` with the owning package; the case
 * is then marked `it.fails` / `it.todo` with the issue id until the fix package lands.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import type { Actor, Ctx } from "@/lib/ctx";
import { activityEvents, automationEnrolments, bookings, emailMessages, files, invoices, jobs, orders, payments, persons, roles, settings } from "@beam/db/schema";
import { seedDefaults } from "@beam/db/seed";
import { createTestDb, makePerson, makeProduct, makeSession, makeUser } from "@beam/db/testing";
import { ensureTermsVersion } from "@beam/db/testing/commerce-factories";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.12" })),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<object>()), after: () => undefined }));

const WEBHOOK_SECRET = "whsec_seams_v1_0123456789";
const SINK = "sink@example.com";
vi.stubEnv("MOLLIE_WEBHOOK_SECRET", WEBHOOK_SECRET);
vi.stubEnv("EMAIL_SINK", SINK);
vi.stubEnv("APP_ENV", "local");
vi.stubEnv("INTEGRATIONS", "fake");
vi.stubEnv("APP_URL", "https://app.example.com");
vi.stubEnv("AUTH_SECRET", "seams-v1-auth-secret-0123456789abcdef");
vi.stubEnv("SENSITIVE_DATA_KEY_V1", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("VOUCHER_CODE_SECRET", "seams-v1-voucher-secret-0123456789abcdef");

const { and, createCtx, eq, inArray } = await import("@/lib/ctx");
const { createFakeIntegrations, makeCtx, resetRuntime } = await import("@/lib/testing");
const { runJobs } = await import("@/lib/job-runner");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { createOrder, startPayment } = await import("@/modules/commerce/api");
const { getPersonCreditSummary } = await import("@/modules/credits/api");
const { getInvoiceForOrder } = await import("@/modules/finance/api");
const { seedTemplate, sendTransactional } = await import("@/modules/email/api");
const { bookSeats } = await import("@/modules/booking/server/book");
const { cancelBookingRow } = await import("@/modules/booking/server/cancel");
const automationActions = await import("@/modules/automation/actions");
const { POST: mollieWebhook } = await import("@/app/api/webhooks/mollie/route");
const { POST: formStart } = await import("@/app/api/public/forms/[slug]/start/route");
const { POST: formSubmit } = await import("@/app/api/public/forms/[slug]/submit/route");

let h: DbHandle;
const fake = createFakeIntegrations();
const DAY_MS = 86_400_000;

const COMPANY = {
  legal_name: "Vibrant Lifestyle Collective BV",
  trade_name: "BEAM Vitality Center",
  vat_number: "BE0123456789",
  enterprise_number: "0123.456.789",
  address: { street: "Voorbeeldstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
  support_email: "support@demo.beam.be",
  phone: "",
  website: "",
};

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: fake });
  // `pnpm seed` on a fresh database: roles, automation groups, system forms, templates.
  await seedDefaults(h.db);
  await h.db.insert(settings).values({ key: "company", value: COMPANY }).onConflictDoUpdate({ target: settings.key, set: { value: COMPANY } });
  await ensureTermsVersion(h.db);
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  resetRuntime();
  await h?.close();
});

/** Runs `fn` in a real transaction with its own context, the way `action()` does. */
function inTx<T>(actor: Actor, fn: (tx: Tx, ctx: Ctx) => Promise<T>): Promise<T> {
  return h.db.transaction(async (tx) => fn(tx, createCtx({ tx, actor, durableMode: "immediate", locale: "nl-BE" })));
}

/** The runner until nothing due is left (every lane, the fakes of this file). */
async function drainJobs(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const summary = await runJobs({ db: h.db, integrations: fake, budgetMs: 60_000 });
    if (summary.ran.fast + summary.ran.bulk === 0) return;
  }
}

/** Jobs that ended dead or are still retrying: a seam must leave none. */
async function brokenJobs(): Promise<{ kind: string; status: string; lastError: string | null }[]> {
  return h.db
    .select({ kind: jobs.kind, status: jobs.status, lastError: jobs.lastError })
    .from(jobs)
    .where(inArray(jobs.status, ["dead"]));
}

const dayUnits = async (personId: string) => (await getPersonCreditSummary(h.db, personId)).byKind.find((k) => k.kind === "day")?.remainingUnits ?? 0;
const eventKinds = async (personId: string) => (await h.db.select({ kind: activityEvents.kind }).from(activityEvents).where(eq(activityEvents.personId, personId))).map((e) => e.kind);

describe("seam 1: checkout -> credits -> booking (fake Mollie paid, grant, book with a credit, cancel in policy, credit back)", () => {
  const state: { personId?: string; orderId?: string; bookingId?: string } = {};

  it("a portal order for the 5-day package is paid through the Mollie webhook and grants 5 day credits", async () => {
    const person = await makePerson(h.db, { firstName: "Seam", lastName: "Buyer", email: `seam-buyer-${randomUUID().slice(0, 8)}@example.com` });
    const user = await makeUser(h.db, { audience: "customer", email: person.email!, personId: person.id });
    const actor: Actor = { kind: "customer", userId: user.id, personId: person.id };
    state.personId = person.id;
    const pkg = await makeProduct(h.db, { kind: "package", creditKind: "day", creditUnits: 5, validityDays: 180, priceCents: 20_000 });

    const created = await inTx(actor, (tx, ctx) =>
      createOrder(tx, ctx, { personId: person.id, channel: "portal", items: [{ productId: pkg.id, quantity: 1 }], clientKey: randomUUID(), locale: "nl-BE" }),
    );
    state.orderId = created.orderId;
    expect(created).toMatchObject({ status: "pending_payment", totalCents: 20_000, isExisting: false });

    const started = await inTx(actor, (tx, ctx) => startPayment(tx, ctx, { orderId: created.orderId }));
    expect(started.redirectUrl).toContain("/api/dev/fake-pay/");
    const [payment] = await h.db.select().from(payments).where(eq(payments.orderId, created.orderId));
    expect(payment).toMatchObject({ provider: "mollie", status: "open", amountCents: 20_000 });

    fake.payments.settle(payment!.providerPaymentId!, "paid");
    const res = await mollieWebhook(
      new Request(`https://app.example.com/api/webhooks/mollie?t=${WEBHOOK_SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `id=${payment!.providerPaymentId}`,
      }),
    );
    expect(res.status).toBe(200);
    await drainJobs();

    const [order] = await h.db.select().from(orders).where(eq(orders.id, created.orderId));
    expect(order!.status).toBe("paid");
    expect(await dayUnits(person.id)).toBe(5);
    expect(await eventKinds(person.id)).toContain("order.paid");
  });

  it("booking a day session with a credit leaves 4; cancelling inside the rules gives the credit back", async () => {
    const personId = state.personId!;
    const actor: Actor = { kind: "customer", userId: randomUUID(), personId };
    const session = await makeSession(h.db, {
      startsAt: new Date(Date.now() + 5 * DAY_MS),
      publishedAt: new Date(Date.now() - DAY_MS),
      creditKind: "day",
      creditCost: 1,
      capacitySeats: 8,
    });

    const booked = await inTx(actor, (tx, ctx) =>
      bookSeats(tx, ctx, { sessionId: session.id, personId, payWith: "credit", acceptTerms: true, clientKey: randomUUID(), source: "portal", by: "customer", locale: "nl-BE" }),
    );
    expect(booked.kind).toBe("confirmed");
    const bookingId = booked.bookingIds[0]!;
    state.bookingId = bookingId;
    expect((await h.db.select().from(bookings).where(eq(bookings.id, bookingId)))[0]).toMatchObject({ status: "confirmed", paidWith: "credit" });
    expect(await dayUnits(personId)).toBe(4);

    // Blueprint 76 "Email sends correctly" at unit level: one confirmation, nl-BE, mail.beam.be,
    // HTML and plain text with the legal footer, through the sink, and `email.sent` on the timeline.
    await drainJobs();
    const confirmations = await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `booking:${bookingId}:confirmed`));
    expect(confirmations).toHaveLength(1);
    const message = confirmations[0]!;
    expect(message).toMatchObject({ status: "sent", locale: "nl-BE", personId });
    expect(message.renderedFileId).not.toBeNull();
    expect((await h.db.select({ kind: files.kind }).from(files).where(eq(files.id, message.renderedFileId!)))[0]?.kind).toBe("rendered_email");
    const delivered = fake.resend.sent.filter((m) => m.idempotencyKey === `email:${message.id}`);
    expect(delivered).toHaveLength(1);
    expect([delivered[0]!.to].flat()).toEqual([SINK]);
    expect(String(delivered[0]!.from)).toMatch(/@mail\.beam\.be>?$/);
    expect(delivered[0]!.html).toContain(COMPANY.legal_name);
    expect(delivered[0]!.text).toContain(COMPANY.legal_name);
    expect(await eventKinds(personId)).toContain("email.sent");

    const [row] = await h.db.select({ version: bookings.version }).from(bookings).where(eq(bookings.id, bookingId));
    const cancelled = await inTx(actor, (tx, ctx) => cancelBookingRow(tx, ctx, { bookingId, expectedVersion: row!.version, includeGuests: true, by: "customer" }));
    expect(cancelled).toMatchObject({ status: "cancelled", creditReleased: true, refundRequested: false });
    expect(await dayUnits(personId)).toBe(5);
    await drainJobs();

    const kinds = await eventKinds(personId);
    expect(kinds).toEqual(expect.arrayContaining(["order.paid", "booking.confirmed", "booking.cancelled"]));
    expect(await brokenJobs()).toEqual([]);
  });

  describe("seam 2: order -> invoice -> Billit", () => {
    it("the paid order has invoice BEAM-<year>-000001 and a matching Billit fake document", async () => {
      const orderId = state.orderId!;
      const summary = await getInvoiceForOrder(h.db, orderId);
      expect(summary).not.toBeNull();
      const [invoice] = await h.db.select().from(invoices).where(eq(invoices.orderId, orderId));
      const year = Number(invoice!.issuedOn.slice(0, 4));
      expect(invoice).toMatchObject({ kind: "invoice", status: "paid", fiscalYear: year, sequenceNumber: 1, totalCents: 20_000 });
      expect(invoice!.number).toBe(`BEAM-${year}-000001`);
      // In the build year this is literally BEAM-2026-000001 (platform spec 12).
      if (year === 2026) expect(invoice!.number).toBe("BEAM-2026-000001");

      await drainJobs();
      const [synced] = await h.db.select().from(invoices).where(eq(invoices.id, invoice!.id));
      expect(synced).toMatchObject({ billitStatus: "synced" });
      const documents = fake.billit.snapshot().orders.filter((o) => o.OrderNumber === invoice!.number);
      expect(documents).toHaveLength(1);
      expect(synced!.billitId).toBe(documents[0]!.OrderID);
      expect(await brokenJobs()).toEqual([]);
    });
  });
});

describe("seam 3: form -> person -> automation -> email", () => {
  const TEMPLATE = "automation.seam_contact_thanks";
  const SLUG = "seam-contact-thanks";
  const L = ["nl-BE", "fr-BE", "en"] as const;
  const each = (text: string) => Object.fromEntries(L.map((l) => [l, `${text} (${l})`])) as Record<(typeof L)[number], string>;
  let automationId: string;

  function ok<T>(r: unknown): T {
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    return (r as { ok: true; data: T }).data;
  }

  beforeAll(async () => {
    // A marketing user with the automation permissions signs in (the action wrapper reads the cookie).
    const [role] = await h.db.select({ permissions: roles.permissions }).from(roles).where(eq(roles.key, "marketing"));
    const permissions = [...new Set([...(role?.permissions ?? []), "automations.write", "automations.publish"])];
    await h.db.update(roles).set({ permissions }).where(eq(roles.key, "marketing"));
    const staff = await makeUser(h.db, { roleKey: "marketing", name: "Seam Marketing" });
    const { token } = await createAuthSession(h.db, { userId: staff.id, audience: "staff", roleKey: "marketing", now: new Date(), mfaAt: new Date() });
    jar.set(SESSION_COOKIE, token);

    // email: a published transactional template in the three locales.
    await seedTemplate(h.db as unknown as Tx, {
      slug: TEMPLATE,
      name: "Seam contact thanks",
      kind: "transactional",
      purpose: null,
      subject: each("Thanks for your message"),
      preheader: each("We reply within two working days"),
      document: { schemaVersion: 1, locales: Object.fromEntries(L.map((l, i) => [l, [{ id: `seamblk00${i + 1}`, type: "text", markdown: `Hello {{first_name}}, thank you (${l}).` }]])) } as never,
    });

    // automation: draft -> definition -> publish -> activate, through the staff actions.
    const created = ok<{ id: string }>(await automationActions.createAutomation({ slug: SLUG, name: "Seam contact thanks", groupKey: "transactional", isMarketing: false }));
    automationId = created.id;
    const definition = {
      schema_version: 1,
      trigger: { event: "form.completed", where: { "data.form_slug": "contact" } },
      anchor: "enrolment",
      re_entry: "never",
      exit_on: [],
      steps: [{ key: "thanks", type: "email", template: TEMPLATE, at: { from: "enrolment", minutes: 0 } }],
    };
    const saved = ok<{ issues: { severity: string; code: string; path: string }[] }>(await automationActions.saveDraft({ automationId, definition }));
    expect(saved.issues.filter((i) => i.severity === "error")).toEqual([]);
    ok(await automationActions.publishVersion({ automationId, migrateActive: false }));
    ok(await automationActions.activateAutomation({ automationId }));
  });

  const enqueueEvaluate = () => makeCtx(h.db, { integrations: fake }).enqueue({ kind: "automation.evaluate", payload: {}, key: `seam:automation.evaluate:${randomUUID()}` });

  it("a contact form submission creates the person, enrols them and the email reaches the sink", async () => {
    const address = `seam-visitor-${randomUUID().slice(0, 8)}@example.com`;
    const call = (path: string, body: unknown, cookie?: string) =>
      new Request(`https://app.example.com${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.77", "user-agent": "vitest", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
    const params = { params: Promise.resolve({ slug: "contact" }) };
    const started = await formStart(call("/api/public/forms/contact/start", { locale: "nl-BE", url: "https://app.example.com/nl/f/contact" }), params);
    expect(started.status).toBe(200);
    const { submissionId } = (await started.json()) as { submissionId: string };
    const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    // R3: a real visitor needs at least three seconds before submitting.
    await new Promise((r) => setTimeout(r, 3_100));
    const answers = { email: address, first_name: "Vera", message: "When is the next open day?" };
    const submitted = await formSubmit(call("/api/public/forms/contact/submit", { submissionId, answers }, cookie), params);
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({ completedNow: true });

    const [person] = await h.db.select().from(persons).where(eq(persons.email, address));
    expect(person).toMatchObject({ firstName: "Vera" });
    expect(await eventKinds(person!.id)).toContain("form.completed");

    // The minute schedule `automation.evaluate`, then every job it leads to.
    await enqueueEvaluate();
    await drainJobs();

    const enrolmentsOf = () =>
      h.db
        .select()
        .from(automationEnrolments)
        .where(and(eq(automationEnrolments.personId, person!.id), eq(automationEnrolments.automationId, automationId)));
    const enrolments = await enrolmentsOf();
    expect(enrolments).toHaveLength(1);
    const messagesOf = () => h.db.select().from(emailMessages).where(eq(emailMessages.enrolmentId, enrolments[0]!.id));
    const messages = await messagesOf();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ status: "sent", locale: "nl-BE", personId: person!.id });
    expect(messages[0]!.renderedFileId).not.toBeNull();
    const delivered = fake.resend.sent.filter((m) => m.idempotencyKey === `email:${messages[0]!.id}`);
    expect(delivered).toHaveLength(1);
    expect([delivered[0]!.to].flat()).toEqual([SINK]);
    expect(delivered[0]!.subject).toContain("Thanks for your message (nl-BE)");
    expect(delivered[0]!.text).toContain("Hello Vera, thank you (nl-BE).");
    expect(await eventKinds(person!.id)).toEqual(expect.arrayContaining(["form.completed", "email.sent"]));

    // A second evaluation and drain change nothing (idempotent enrolment and send).
    await enqueueEvaluate();
    await drainJobs();
    expect(await enrolmentsOf()).toHaveLength(1);
    expect(await messagesOf()).toHaveLength(1);
    expect(await brokenJobs()).toEqual([]);
  });

  // SI-1 (docs/build/seam-issues-v1.md, owner email): found while building this seam. A stored
  // template document that fails validation at send time kills `email.send` with
  // `invalid_document` but leaves the message `queued` (email rule 39: content problems end
  // `failed`). Fixed by fix-w21-email-wiring: `email.send` calls `failMessage` on `invalid_document`.
  it("SI-1: a message whose template document is invalid ends failed, not queued", async () => {
    const slug = "automation.seam_bad_document";
    await seedTemplate(h.db as unknown as Tx, {
      slug,
      name: "Seam bad document",
      kind: "transactional",
      purpose: null,
      subject: each("Bad"),
      preheader: each("Bad"),
      // Block ids must be 10-character nanoids; these are not.
      document: { schemaVersion: 1, locales: Object.fromEntries(L.map((l) => [l, [{ id: `bad-${l}`, type: "text", markdown: "Hello" }]])) } as never,
    });
    const person = await makePerson(h.db, { email: `seam-bad-${randomUUID().slice(0, 8)}@example.com` });
    const { emailMessageId } = await sendTransactional(makeCtx(h.db, { integrations: fake }), { template: slug, personId: person.id, locale: "nl-BE", data: {}, key: `seam:bad_document:${person.id}` });
    await drainJobs();
    const [message] = await h.db.select({ status: emailMessages.status }).from(emailMessages).where(eq(emailMessages.id, emailMessageId));
    expect(message?.status).toBe("failed");
  });
});
