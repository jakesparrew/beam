/**
 * platform-P13: the R2 seams with real module code on PGlite (platform spec 12, PL-96, gap G15).
 * No module function is mocked; only Next.js request APIs are (`next/headers`, `next/server`),
 * and every provider is the fake of `createFakeIntegrations()`. The database is `pnpm seed` on a
 * fresh database (`seedDefaults` and email's registry system rows), switched over to Release 2
 * with automation's `activateReleaseSequences(tx, 'R2', { isDpiaApproved })` and commerce's
 * `ff_commerce_checkout_recovery` flag on.
 *
 * 1. webinar.registered -> sequence with late-entry skip: webinar's `registerPerson` 48 hours
 *    before the start; automation's evaluator enrols the person in the seeded
 *    `webinar-registration` journey with `d7` and `d3` `skipped_late_entry`; at the `h3` due time
 *    the step queues `webinar.reminder` and `email.send` delivers it to the sink.
 * 2. checkout.abandoned -> recovery email -> checkout.completed attribution: commerce's
 *    `startCheckout`, `checkouts.mark_abandoned` 61 minutes later, the seeded
 *    `abandoned-checkout` journey sends `commerce.checkout_recovery` (marketing) after one hour
 *    with the checkout's resume link; the customer then pays through `placeOrder` and the Mollie
 *    webhook, `checkout.completed` ends the journey before the 24-hour reminder, and the next
 *    `checkouts.mark_abandoned` attributes the recovery to the first recovery email.
 * 3. The one executor (PL-96, gap G15): `runStep` imported from
 *    `apps/web/modules/automation/engine/step.ts` defers a marketing step due at 22:30 Brussels
 *    to 08:00 (quiet hours 21:00-08:00) with a new `scheduled` row; ends the third marketing step
 *    of a day `skipped_frequency_cap` with `maxMarketingPerDay = 2`; and gives the
 *    abandoned-checkout email the `resumeUrl` of `commerce.getCheckoutRecoveryProps`, with
 *    `checkouts.recovery_message_id` set once over two runs. A file scan finds exactly one
 *    `step.ts` exporting `runStep`, at that path, and none under `packages/db/src/` or
 *    `packages/core/src/i18n/`.
 *
 * Clock: every instant is pinned relative to the real clock and always lies in the future of
 * it (the job runner claims by the database clock; email rows are stamped with it), and the
 * Brussels times come from automation's DST-safe `nextBrusselsTime`, so the file passes at 23:30
 * and across a DST change.
 *
 * A failing seam is written to `docs/build/seam-issues-r2.md` with the owning package; the case
 * is then marked `it.fails` with the issue id until the fix package lands.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import type { Actor, Ctx } from "@/lib/ctx";
import {
  activityEvents,
  automationEnrolments,
  automationRuns,
  automations,
  checkouts,
  emailMessages,
  featureFlags,
  jobs,
  orders,
  payments,
  settings,
} from "@beam/db/schema";
import { seedDefaults } from "@beam/db/seed";
import { activateReleaseSequences } from "@beam/db/seed/automation";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { ensureTermsVersion } from "@beam/db/testing/commerce-factories";
import { brusselsDate, brusselsTimeOfDay, isWithinBrusselsWindow, nextBrusselsTime } from "@beam/core/automation";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.13" })),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<object>()), after: () => undefined }));

const WEBHOOK_SECRET = "whsec_seams_r2_0123456789";
const SINK = "sink@example.com";
vi.stubEnv("MOLLIE_WEBHOOK_SECRET", WEBHOOK_SECRET);
vi.stubEnv("EMAIL_SINK", SINK);
vi.stubEnv("APP_ENV", "local");
vi.stubEnv("INTEGRATIONS", "fake");
vi.stubEnv("APP_URL", "https://app.example.com");
vi.stubEnv("AUTH_SECRET", "seams-r2-auth-secret-0123456789abcdef");
vi.stubEnv("SENSITIVE_DATA_KEY_V1", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("VOUCHER_CODE_SECRET", "seams-r2-voucher-secret-0123456789abcdef");

const { and, asc, createCtx, eq, inArray, sql } = await import("@/lib/ctx");
const { createFakeIntegrations, makeCtx, resetRuntime } = await import("@/lib/testing");
const { runJobs } = await import("@/lib/job-runner");
const { clearFlagCache, flag } = await import("@/lib/flags");
const { FLAGS } = await import("@/registry/flags.generated");
const { getSettingWithVersion } = await import("@/lib/settings");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { runStep, stepJobKey } = await import("@/modules/automation/engine/step");
const automationActions = await import("@/modules/automation/actions");
const { isDpiaApproved } = await import("@/modules/ops/api");
const { getCheckoutRecoveryProps } = await import("@/modules/commerce/api");
const { startCheckout, placeOrder } = await import("@/modules/commerce/server/checkouts");
const { recordConsent } = await import("@/modules/crm/api");
const { applyTag } = await import("@/modules/crm/api");
const { createTag } = await import("@/modules/crm/actions");
const { seedTemplate } = await import("@/modules/email/api");
const { seedSystemTemplates } = await import("@/modules/email/seed");
const { registerPerson } = await import("@/modules/webinar/server/registration");
const { makeWebinar } = await import("@/modules/webinar/test/factories");
const { POST: mollieWebhook } = await import("@/app/api/webhooks/mollie/route");

let h: DbHandle;
const fake = createFakeIntegrations();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const L = ["nl-BE", "fr-BE", "en"] as const;
const each = (text: string) => Object.fromEntries(L.map((l) => [l, `${text} (${l})`])) as Record<(typeof L)[number], string>;
const QUIET = { start: "21:00", end: "08:00" };

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

/** The real clock at file start, rounded up to the next whole minute. */
const WALL = new Date(Math.ceil((Date.now() + MIN) / MIN) * MIN);
/** The first Brussels `hhmm` at least `minMs` after the real clock. */
const nextAt = (hhmm: string, minMs = HOUR) => nextBrusselsTime(new Date(WALL.getTime() + minMs), hhmm);
const isQuiet = (at: Date) => isWithinBrusselsWindow(at, QUIET.start, QUIET.end);

let activated: { activated: string[]; blocked: string[] };

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: fake });
  // `pnpm seed` on a fresh database: roles, groups, the R2 journeys as drafts, system templates.
  await seedDefaults(h.db);
  await seedSystemTemplates(h.db);
  await h.db.insert(settings).values({ key: "company", value: COMPANY }).onConflictDoUpdate({ target: settings.key, set: { value: COMPANY } });
  await ensureTermsVersion(h.db);

  // The R2 switch-over: commerce's recovery flag on, then automation's release activation.
  await h.db.insert(featureFlags).values({ key: "ff_commerce_checkout_recovery", state: "on" }).onConflictDoUpdate({ target: featureFlags.key, set: { state: "on" } });
  clearFlagCache();
  activated = await h.db.transaction((tx) => activateReleaseSequences(tx, "R2", { isDpiaApproved, now: WALL }));

  // An owner signs in (MFA done): the staff actions below read this cookie.
  const owner = await makeUser(h.db, { roleKey: "owner", name: "Seam Owner" });
  const { token } = await createAuthSession(h.db, { userId: owner.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
}, 180_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  resetRuntime();
  await h?.close();
});

function ok<T>(r: unknown): T {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  return (r as { ok: true; data: T }).data;
}

/** Runs `fn` in a real transaction with its own context at `now`, the way `action()` does. */
function inTx<T>(actor: Actor, now: Date, fn: (tx: Tx, ctx: Ctx) => Promise<T>): Promise<T> {
  return h.db.transaction(async (tx) => fn(tx, createCtx({ tx, actor, now, durableMode: "immediate", locale: "nl-BE" })));
}

/**
 * The real job runner with the clock at `now`: every pending job due by `now` (the runner
 * itself claims by the database clock, so the due rows are made claimable first), until none is
 * left. `only` limits the run to some kinds.
 */
async function runDue(now: Date, only?: string[], rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const due = await h.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), sql`${jobs.runAt} <= ${now.toISOString()}::timestamptz`, ...(only ? [inArray(jobs.kind, only)] : [])));
    if (!due.length) return;
    const ids = due.map((r) => r.id);
    await h.db.update(jobs).set({ runAt: sql`least(${jobs.runAt}, now())` }).where(inArray(jobs.id, ids));
    await warmFlags();
    await runJobs({ db: h.db, integrations: fake, ids, now: () => now, budgetMs: 60_000 });
  }
}

/**
 * `flag()` reads its row through the app database handle, outside the job's transaction. PGlite
 * has one connection, so that read would wait for the runner's open transaction; the 60-second
 * flag cache is filled first (production has a connection pool and needs no such step).
 */
async function warmFlags(): Promise<void> {
  for (const key of Object.keys(FLAGS)) await flag(key as Parameters<typeof flag>[0], { kind: "system", jobId: "" });
}

/** Enqueues one job at `now` (a schedule's firing) and runs it with everything it leads to. */
async function fire(kind: string, now: Date, payload: Record<string, unknown> = {}, opts: { alone?: boolean } = {}): Promise<void> {
  await makeCtx(h.db, { integrations: fake, now }).enqueue({ kind: kind as never, payload, key: `seam:${kind}:${randomUUID()}`, runAt: now });
  await runDue(now, opts.alone ? [kind] : undefined);
}

/** The minute schedule `automation.evaluate` at `now`, then every job due by `now`. */
const tick = (now: Date) => fire("automation.evaluate", now);

/** Jobs that ended dead: a seam must leave none. */
const deadJobs = async () => (await h.db.select({ kind: jobs.kind, lastError: jobs.lastError }).from(jobs).where(eq(jobs.status, "dead"))).filter((j) => !j.kind.startsWith("slack."));

async function enrolmentsOf(personId: string, slug: string) {
  return (
    await h.db
      .select({ e: automationEnrolments })
      .from(automationEnrolments)
      .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
      .where(and(eq(automationEnrolments.personId, personId), eq(automations.slug, slug)))
      .orderBy(asc(automationEnrolments.enteredAt))
  ).map((r) => r.e);
}

/** `[step_key, outcome]` of an enrolment's runs other than `entered` and `scheduled`, sorted. */
async function outcomes(enrolmentId: string): Promise<[string | null, string][]> {
  const rows = await h.db.select({ stepKey: automationRuns.stepKey, outcome: automationRuns.outcome }).from(automationRuns).where(eq(automationRuns.enrolmentId, enrolmentId));
  return rows
    .filter((r) => r.outcome !== "entered" && r.outcome !== "scheduled")
    .map((r) => [r.stepKey, r.outcome] as [string | null, string])
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? "") || a[1].localeCompare(b[1]));
}

const messagesOf = (enrolmentId: string) => h.db.select().from(emailMessages).where(eq(emailMessages.enrolmentId, enrolmentId)).orderBy(asc(emailMessages.createdAt));
const deliveredFor = (messageId: string) => fake.resend.sent.filter((m) => m.idempotencyKey === `email:${messageId}`);
const eventKinds = async (personId: string) => (await h.db.select({ kind: activityEvents.kind }).from(activityEvents).where(eq(activityEvents.personId, personId))).map((e) => e.kind);
const checkoutRow = async (id: string) => (await h.db.select().from(checkouts).where(eq(checkouts.id, id)))[0]!;

/** A person with an address and a current newsletter consent (crm's own consent api). */
async function reachablePerson(label: string) {
  const person = await makePerson(h.db, { firstName: "Seam", lastName: label, locale: "nl-BE", email: `seam-r2-${label}-${randomUUID().slice(0, 8)}@example.com` });
  await recordConsent(h.db as unknown as Tx, makeCtx(h.db, { integrations: fake }), {
    personId: person.id,
    purpose: "newsletter",
    status: "granted",
    method: "form",
    source: "form:seam-r2",
    wordingVersion: "form:seam-r2:v1:newsletter",
  });
  return person;
}

it("the R2 switch-over activated the webinar registration and abandoned-checkout journeys", () => {
  expect(activated.activated).toEqual(expect.arrayContaining(["webinar-registration", "abandoned-checkout"]));
});

describe("seam 1: webinar.registered -> webinar-registration with late-entry skip -> webinar.reminder in the sink", () => {
  it("a registration 48 hours before the start skips d7 and d3 and sends only the h3 reminder", async () => {
    const registeredAt = new Date(WALL.getTime() + 2 * HOUR);
    const startsAt = new Date(registeredAt.getTime() + 2 * DAY);
    const owner = await makeUser(h.db, { name: "Seam Webinar Owner" });
    const webinar = await makeWebinar(h.db, { ownerUserId: owner.id, startsAt }, { published: true });
    const person = await makePerson(h.db, { firstName: "Wanda", locale: "nl-BE", email: `seam-r2-webinar-${randomUUID().slice(0, 8)}@example.com` });

    // Webinar's own call shape (its public route runs it on the app database handle).
    const { registrationId, created } = await registerPerson(h.db as unknown as Tx, makeCtx(h.db, { integrations: fake, actor: { kind: "public" }, now: registeredAt }), {
      webinarId: webinar.id,
      personId: person.id,
      source: "site",
      locale: "nl-BE",
      utm: {},
    });
    expect(created).toBe(true);
    expect(await eventKinds(person.id)).toContain("webinar.registered");

    await tick(registeredAt);
    const [e] = await enrolmentsOf(person.id, "webinar-registration");
    expect(e).toMatchObject({ status: "active", subjectKey: `webinar_registration:${registrationId}`, nextStepKey: "h3", nextStepAt: new Date(startsAt.getTime() - 3 * HOUR) });
    expect(await outcomes(e!.id)).toEqual([
      ["d3", "skipped_late_entry"],
      ["d7", "skipped_late_entry"],
    ]);
    expect(await messagesOf(e!.id)).toEqual([]);

    await tick(e!.nextStepAt!);
    const [done] = await enrolmentsOf(person.id, "webinar-registration");
    expect(done).toMatchObject({ status: "completed" });
    expect(await outcomes(e!.id)).toEqual([
      [null, "completed"],
      ["d3", "skipped_late_entry"],
      ["d7", "skipped_late_entry"],
      ["h3", "sent"],
    ]);
    const messages = await messagesOf(e!.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ status: "sent", kind: "automation", purpose: null, locale: "nl-BE", personId: person.id, idempotencyKey: `automation:${e!.id}:h3` });
    const delivered = deliveredFor(messages[0]!.id);
    expect(delivered).toHaveLength(1);
    expect([delivered[0]!.to].flat()).toEqual([SINK]);
    expect(String(delivered[0]!.from)).toMatch(/@mail\.beam\.be>?$/);
    expect(await eventKinds(person.id)).toEqual(expect.arrayContaining(["webinar.registered", "email.sent"]));

    // A later evaluation changes nothing (one enrolment, one reminder).
    await tick(new Date(startsAt.getTime() + HOUR));
    expect(await enrolmentsOf(person.id, "webinar-registration")).toHaveLength(1);
    expect(await messagesOf(e!.id)).toHaveLength(1);
    expect(await deadJobs()).toEqual([]);
  });
});

/** A customer with a portal checkout for a 5-day package started at `startedAt` (commerce's own `startCheckout`). */
async function abandonedCartOf(label: string, startedAt: Date) {
  const person = await reachablePerson(label);
  const user = await makeUser(h.db, { audience: "customer", email: person.email!, personId: person.id });
  const actor: Actor = { kind: "customer", userId: user.id, personId: person.id };
  const pkg = await makeProduct(h.db, { kind: "package", creditKind: "day", creditUnits: 5, validityDays: 180, priceCents: 20_000 });
  const { checkoutId } = await inTx(actor, startedAt, (tx, ctx) =>
    startCheckout(tx, ctx, { channel: "portal", items: [{ productId: pkg.id, quantity: 1 }], locale: "nl-BE" }, { personId: person.id }),
  );
  // Rule 49: idle for 60 minutes; `checkouts.mark_abandoned` (every 10 minutes) marks it a minute later.
  const abandonedAt = new Date(startedAt.getTime() + 61 * MIN);
  await fire("checkouts.mark_abandoned", abandonedAt, {}, { alone: true });
  expect(await checkoutRow(checkoutId)).toMatchObject({ status: "abandoned", abandonedAt, personId: person.id });
  expect(await eventKinds(person.id)).toContain("checkout.abandoned");
  return { person, actor, checkoutId, abandonedAt };
}

describe("seam 2: checkout.abandoned -> recovery email -> checkout.completed attribution", () => {
  it("the 1-hour reminder carries the resume link, the paid checkout ends the journey and the recovery is attributed to that email", async () => {
    // The 1-hour reminder falls at 14:00 Brussels, outside the quiet hours.
    const remindAt = nextAt("14:00", 3 * HOUR);
    const { person, actor, checkoutId, abandonedAt } = await abandonedCartOf("recovered", new Date(remindAt.getTime() - 121 * MIN));

    await tick(abandonedAt);
    const [e] = await enrolmentsOf(person.id, "abandoned-checkout");
    expect(e).toMatchObject({ status: "active", subjectKey: `checkout:${checkoutId}`, nextStepKey: "remind_1h", nextStepAt: remindAt });

    await tick(remindAt);
    const [message] = await messagesOf(e!.id);
    const { resumeUrl } = await h.db.transaction((tx) => getCheckoutRecoveryProps(tx, checkoutId));
    expect(resumeUrl).toMatch(/^https:\/\/app\.example\.com\/nl\/checkout\/resume\/[A-Za-z0-9_-]{43}$/);
    expect(message).toMatchObject({ status: "sent", kind: "automation", purpose: "newsletter", personId: person.id, idempotencyKey: `automation:${e!.id}:remind_1h` });
    expect(message!.context).toMatchObject({ checkout_id: checkoutId, resume_url: resumeUrl });
    expect((await checkoutRow(checkoutId)).recoveryMessageId).toBe(message!.id);
    const delivered = deliveredFor(message!.id);
    expect(delivered).toHaveLength(1);
    expect([delivered[0]!.to].flat()).toEqual([SINK]);
    expect(String(delivered[0]!.from)).toMatch(/@news\.beam\.be>?$/);

    // The customer comes back and pays (placeOrder on the abandoned checkout, fake Mollie paid).
    const paidAt = new Date(remindAt.getTime() + 30 * MIN);
    const placed = await inTx(actor, paidAt, (tx, ctx) =>
      placeOrder(tx, ctx, { checkoutId, clientKey: randomUUID(), useEuroCredit: false, acceptTerms: true }, { personId: person.id }),
    );
    expect(placed.redirectUrl).toContain("/api/dev/fake-pay/");
    const [payment] = await h.db.select().from(payments).where(eq(payments.orderId, placed.orderId));
    fake.payments.settle(payment!.providerPaymentId!, "paid");
    const res = await mollieWebhook(
      new Request(`https://app.example.com/api/webhooks/mollie?t=${WEBHOOK_SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `id=${payment!.providerPaymentId}`,
      }),
    );
    expect(res.status).toBe(200);
    await runDue(paidAt);
    expect((await h.db.select({ status: orders.status }).from(orders).where(eq(orders.id, placed.orderId)))[0]?.status).toBe("paid");
    expect(await checkoutRow(checkoutId)).toMatchObject({ status: "completed" });
    expect(await eventKinds(person.id)).toEqual(expect.arrayContaining(["checkout.abandoned", "checkout.completed", "order.paid"]));

    // checkout.completed (or order.paid, written with it) ends the journey before the 24-hour reminder.
    await tick(new Date(paidAt.getTime() + MIN));
    const [ended] = await enrolmentsOf(person.id, "abandoned-checkout");
    expect(ended!.status).toBe("exited");
    expect(ended!.endReason).toMatch(/^exit_event:(checkout\.completed|order\.paid)$/);

    // The next mark_abandoned run attributes the recovery to the order and keeps the first email.
    await fire("checkouts.mark_abandoned", new Date(paidAt.getTime() + 10 * MIN), {}, { alone: true });
    expect(await checkoutRow(checkoutId)).toMatchObject({ recoveredOrderId: placed.orderId, recoveryMessageId: message!.id });
    expect((await checkoutRow(checkoutId)).recoveredAt).not.toBeNull();
    expect(await eventKinds(person.id)).toContain("checkout.recovered");

    await tick(new Date(abandonedAt.getTime() + DAY + HOUR));
    expect(await messagesOf(e!.id)).toHaveLength(1);
    expect(await deadJobs()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Seam 3: the one step executor (PL-96, gap G15)
// ---------------------------------------------------------------------------

const NEWS_TEMPLATE = "seam-r2-news";

/** `runStep` from its one home, in a real transaction with the system actor at `now`. */
function step(enrolmentId: string, stepKey: string, now: Date) {
  return h.db.transaction((tx) => runStep(tx, { enrolmentId, stepKey, now }, { ctx: createCtx({ tx, actor: { kind: "system", jobId: "" }, now, durableMode: "immediate" }) }));
}

/**
 * A marketing automation (purpose `newsletter`) built through automation's staff actions:
 * `tag.added` of `tagKey` enrols, then one marketing email step per `minutes` entry.
 */
async function marketingJourney(slug: string, tagKey: string, minutes: number[]): Promise<string> {
  ok(await createTag({ key: tagKey, name: each(`Seam ${tagKey}`), color: "#16a34a" }));
  const { id } = ok<{ id: string }>(await automationActions.createAutomation({ slug, name: `Seam ${slug}`, groupKey: "inactivity", isMarketing: true, purpose: "newsletter" }));
  const definition = {
    schema_version: 1,
    trigger: { event: "tag.added", where: { "data.tag_key": tagKey } },
    anchor: "enrolment",
    re_entry: "never",
    exit_on: [],
    steps: minutes.map((m, i) => ({ key: `m${i + 1}`, type: "email", template: NEWS_TEMPLATE, at: { from: "enrolment", minutes: m } })),
  };
  const saved = ok<{ issues: { severity: string; code: string; path: string }[] }>(await automationActions.saveDraft({ automationId: id, definition }));
  expect(saved.issues.filter((i) => i.severity === "error")).toEqual([]);
  ok(await automationActions.publishVersion({ automationId: id, migrateActive: false }));
  ok(await automationActions.activateAutomation({ automationId: id }));
  return id;
}

/** Tags a reachable person at `at` (crm's api) and runs only the evaluator at `at`: the enrolment, its step jobs left pending. */
async function enrolByTag(label: string, tagKey: string, slug: string, at: Date) {
  const person = await reachablePerson(label);
  await applyTag(h.db as unknown as Tx, makeCtx(h.db, { integrations: fake, now: at }), person.id, tagKey, "manual");
  await fire("automation.evaluate", at, {}, { alone: true });
  const [e] = await enrolmentsOf(person.id, slug);
  expect(e, `${slug} enrolment`).toBeDefined();
  return { person, e: e! };
}

describe("seam 3: quiet hours, frequency caps and checkout recovery run in the one executor (PL-96, gap G15)", () => {
  beforeAll(async () => {
    await seedTemplate(h.db as unknown as Tx, {
      slug: NEWS_TEMPLATE,
      name: "Seam R2 news",
      kind: "marketing",
      purpose: "newsletter",
      subject: each("News from BEAM"),
      preheader: each("This week at BEAM"),
      document: { schemaVersion: 1, locales: Object.fromEntries(L.map((l, i) => [l, [{ id: `seamr2nw0${i}`, type: "text", markdown: `Hello {{first_name}} (${l}).` }]])) } as never,
    });
    // automation's rules page action: quiet hours 21:00-08:00, two marketing emails a day.
    const current = await getSettingWithVersion(h.db, "automation_rules");
    ok(
      await automationActions.updateAutomationRules({
        expectedVersion: current.version,
        maxMarketingPerDay: 2,
        maxMarketingPerWeek: 10,
        quietStart: QUIET.start,
        quietEnd: QUIET.end,
        webhookHosts: [...(current.value.webhook_hosts ?? [])],
      }),
    );
    expect((await getSettingWithVersion(h.db, "automation_rules")).value).toMatchObject({ max_marketing_per_day: 2, quiet_start: "21:00", quiet_end: "08:00" });
  });

  it("a marketing step due at 22:30 Brussels is deferred to 08:00 with a new scheduled row, and sends then", async () => {
    await marketingJourney("seam-r2-quiet", "seam_r2_quiet", [0]);
    const due = nextAt("22:30");
    expect(brusselsTimeOfDay(due)).toBe("22:30");
    const { e } = await enrolByTag("quiet", "seam_r2_quiet", "seam-r2-quiet", due);
    expect(e).toMatchObject({ status: "active", nextStepKey: "m1", nextStepAt: due });

    const until = nextBrusselsTime(due, QUIET.end);
    expect(brusselsTimeOfDay(until)).toBe("08:00");
    expect(brusselsDate(until)).toBe(brusselsDate(new Date(due.getTime() + 12 * HOUR)));
    expect(await step(e.id, "m1", due)).toEqual({ status: "deferred", reason: "quiet_hours", nextStepKey: "m1", until });

    const scheduled = await h.db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.enrolmentId, e.id), eq(automationRuns.outcome, "scheduled"), eq(automationRuns.reason, "quiet_hours")));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ stepKey: "m1", data: { due_at: until.toISOString() } });
    const [moved] = await enrolmentsOf(e.personId, "seam-r2-quiet");
    expect(moved).toMatchObject({ status: "active", nextStepKey: "m1", nextStepAt: until });
    const [deferJob] = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, stepJobKey(e.id, "m1", { kind: "defer", at: until })));
    expect(deferJob).toMatchObject({ kind: "automation.step", status: "pending", runAt: until });
    expect(await messagesOf(e.id)).toEqual([]);

    // 08:00: the step jobs run and the email is queued once and sent.
    await runDue(until);
    const messages = await messagesOf(e.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ status: "sent", purpose: "newsletter", idempotencyKey: `automation:${e.id}:m1` });
    expect(await outcomes(e.id)).toEqual([
      [null, "completed"],
      ["m1", "sent"],
    ]);
  });

  it("with maxMarketingPerDay 2 the third marketing step of the day ends skipped_frequency_cap", async () => {
    await marketingJourney("seam-r2-cap", "seam_r2_cap", [0, 1, 2]);
    // Three steps in the day light, within 24 hours of the real clock that stamps the messages.
    const soon = new Date(WALL.getTime() + 30 * MIN);
    const third = !isQuiet(soon) && !isQuiet(new Date(soon.getTime() - 5 * MIN)) ? soon : nextAt("09:00", 0);
    const enteredAt = new Date(third.getTime() - 2 * MIN);
    const { e } = await enrolByTag("cap", "seam_r2_cap", "seam-r2-cap", enteredAt);
    expect(e).toMatchObject({ nextStepKey: "m1", nextStepAt: enteredAt });

    expect(await step(e.id, "m1", enteredAt)).toMatchObject({ status: "ran", outcome: "sent", nextStepKey: "m2" });
    expect(await step(e.id, "m2", new Date(enteredAt.getTime() + MIN))).toMatchObject({ status: "ran", outcome: "sent", nextStepKey: "m3" });
    expect(await step(e.id, "m3", third)).toMatchObject({ status: "ran", outcome: "skipped_frequency_cap", ended: true });

    const [capped] = await h.db.select().from(automationRuns).where(and(eq(automationRuns.enrolmentId, e.id), eq(automationRuns.outcome, "skipped_frequency_cap")));
    expect(capped).toMatchObject({ stepKey: "m3", reason: "cap_day:2", emailMessageId: null });
    expect((await messagesOf(e.id)).map((m) => m.idempotencyKey)).toEqual([`automation:${e.id}:m1`, `automation:${e.id}:m2`]);
    expect(await outcomes(e.id)).toEqual([
      [null, "completed"],
      ["m1", "sent"],
      ["m2", "sent"],
      ["m3", "skipped_frequency_cap"],
    ]);
  });

  it("the abandoned-checkout email carries the resumeUrl of commerce.getCheckoutRecoveryProps; recovery_message_id is set once over two runs", async () => {
    const remindAt = nextAt("11:00", 3 * HOUR);
    const { person, checkoutId, abandonedAt } = await abandonedCartOf("executor", new Date(remindAt.getTime() - 121 * MIN));
    await fire("automation.evaluate", abandonedAt, {}, { alone: true });
    const [e] = await enrolmentsOf(person.id, "abandoned-checkout");
    expect(e).toMatchObject({ status: "active", nextStepKey: "remind_1h", nextStepAt: remindAt });

    const first = await step(e!.id, "remind_1h", remindAt);
    expect(first).toMatchObject({ status: "ran", outcome: "sent", nextStepKey: "remind_24h" });
    const [m1] = await messagesOf(e!.id);
    const props = await h.db.transaction((tx) => getCheckoutRecoveryProps(tx, checkoutId));
    expect(m1!.context).toMatchObject({ checkout_id: checkoutId, resume_url: props.resumeUrl });
    const [run1] = await h.db.select().from(automationRuns).where(and(eq(automationRuns.enrolmentId, e!.id), eq(automationRuns.stepKey, "remind_1h"), eq(automationRuns.outcome, "sent")));
    expect(run1).toMatchObject({ emailMessageId: m1!.id, data: { checkout_id: checkoutId } });
    expect((await checkoutRow(checkoutId)).recoveryMessageId).toBe(m1!.id);

    // Run 1 again (a retried job): nothing new. Run 2 (the 24-hour reminder): a second email, the link stays on the first.
    expect(await step(e!.id, "remind_1h", remindAt)).toEqual({ status: "noop", reason: "not_next" });
    const second = await step(e!.id, "remind_24h", new Date(abandonedAt.getTime() + DAY));
    expect(second).toMatchObject({ status: "ran", outcome: "sent" });
    const messages = await messagesOf(e!.id);
    expect(messages.map((m) => m.idempotencyKey)).toEqual([`automation:${e!.id}:remind_1h`, `automation:${e!.id}:remind_24h`]);
    expect(messages[1]!.context).toMatchObject({ resume_url: props.resumeUrl });
    expect((await checkoutRow(checkoutId)).recoveryMessageId).toBe(m1!.id);
    expect((await h.db.transaction((tx) => getCheckoutRecoveryProps(tx, checkoutId))).resumeUrl).toBe(props.resumeUrl);
  });
});

describe("one home for the step executor (PL-96)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const REPO = path.resolve(here, "../../..");
  const SKIP = new Set(["node_modules", ".git", ".next", ".turbo", ".claude", "dist", "coverage", "playwright-report", "test-results"]);

  /** Every file named `step.ts` under `apps/`, `packages/` and `scripts/` (repository-relative). */
  function stepFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (SKIP.has(name)) continue;
        const full = path.join(dir, name);
        let isDir: boolean;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        if (isDir) walk(full);
        else if (name === "step.ts") out.push(path.relative(REPO, full).split(path.sep).join("/"));
      }
    };
    for (const top of ["apps", "packages", "scripts"]) walk(path.join(REPO, top));
    return out.sort();
  }

  const EXPORTS_RUN_STEP = /export\s+(?:async\s+)?function\s+runStep\b|export\s+(?:const|let)\s+runStep\b|export\s*\{[^}]*\brunStep\b[^}]*\}/;

  it("exactly one step.ts exports runStep, at apps/web/modules/automation/engine/step.ts", () => {
    const exporting = stepFiles().filter((f) => EXPORTS_RUN_STEP.test(readFileSync(path.join(REPO, f), "utf8")));
    expect(exporting).toEqual(["apps/web/modules/automation/engine/step.ts"]);
    expect(typeof runStep).toBe("function");
  });

  it("no step.ts exists under packages/db/src/ or packages/core/src/i18n/", () => {
    const stray = stepFiles().filter((f) => f.startsWith("packages/db/src/") || f.startsWith("packages/core/src/i18n/"));
    expect(stray).toEqual([]);
  });
});
