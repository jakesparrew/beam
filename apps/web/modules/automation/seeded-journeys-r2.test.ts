/**
 * The R2 seeded journeys of spec 3.6 and 3.7 end to end (automation-P8): the `defaults` seed and
 * email's registry system rows on a fresh database, `activateReleaseSequences(tx, 'R2')`, then
 * activity events through `automation.evaluate` (enrolment, exits, exclusivity) and the
 * `automation.step` job (send-time checks). Email's queue functions and the reachability read
 * are mocked (`state.reachable` decides), ops' `isDpiaApproved` follows `state.dpia`, commerce's
 * checkout recovery functions are mocked to the shape of their contract; crm tasks and tags,
 * bookings and the flag row are real.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import {
  auditLog,
  automationEnrolments,
  automationRuns,
  automations,
  bookings,
  featureFlags,
  jobs as jobsTable,
  personTags,
  roles,
  tags,
  tasks,
} from "@beam/db/schema";
import { seedDefaults } from "@beam/db/seed";
import { activateReleaseSequences } from "@beam/db/seed/automation";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { b2cPlaybookSlug, SEED_AUTOMATIONS } from "@beam/core/automation/seeds";
import { and, asc, eq, sql } from "@/lib/ctx";
import { clearFlagCache } from "@/lib/flags";
import { makeJobCtx, resetRuntime } from "@/lib/testing";
import type * as CommerceApi from "@/modules/commerce/api";
import type * as EmailApi from "@/modules/email/api";
import type * as OpsApi from "@/modules/ops/api";

const state = vi.hoisted(() => ({
  reachable: new Set<string>(),
  dpia: false,
  sent: [] as { templateSlug: string; personId: string; stepKey?: string; kind: "marketing" | "transactional"; context: Record<string, string> }[],
}));

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.58" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

vi.mock("@/modules/email/api", async (orig) => {
  const { sql: q } = await import("drizzle-orm");
  const queue = (kind: "marketing" | "transactional") =>
    vi.fn(async (ctx: { tx: Tx }, input: { templateSlug: string; personId: string; enrolmentId: string; idempotencyKey: string; stepKey?: string; context?: Record<string, string> }) => {
      const res = await ctx.tx.execute(q`insert into email_messages (person_id, kind, enrolment_id, locale, idempotency_key)
        values (${input.personId}::uuid, 'transactional', ${input.enrolmentId}::uuid, 'nl-BE', ${input.idempotencyKey})
        on conflict (idempotency_key) do update set updated_at = now() returning id::text as id`);
      state.sent.push({ templateSlug: input.templateSlug, personId: input.personId, kind, context: input.context ?? {}, ...(input.stepKey ? { stepKey: input.stepKey } : {}) });
      return { messageId: (res as { rows: { id: string }[] }).rows[0]!.id, status: "queued", created: true, templateVersionId: "00000000-0000-4000-8000-0000000000aa" };
    });
  return {
    ...(await orig<typeof EmailApi>()),
    getReachability: vi.fn((_tx: unknown, personId: string) =>
      Promise.resolve(state.reachable.has(personId) ? { isReachable: true, blockedReason: null } : { isReachable: false, blockedReason: "no_consent" }),
    ),
    queueMarketingEmail: queue("marketing"),
    queueAutomationEmail: queue("transactional"),
  };
});
vi.mock("@/modules/ops/api", async (orig) => ({
  ...(await orig<typeof OpsApi>()),
  isDpiaApproved: vi.fn(() => Promise.resolve(state.dpia)),
}));
vi.mock("@/modules/commerce/api", async (orig) => ({
  ...(await orig<typeof CommerceApi>()),
  getCheckoutRecoveryProps: vi.fn((_tx: unknown, checkoutId: string) =>
    Promise.resolve({ resumeUrl: `https://beam.example.com/nl-BE/checkout/resume/${checkoutId.slice(0, 8)}`, items: [], totalCents: 35_000, locale: "nl-BE" }),
  ),
  markCheckoutRecoveryMessage: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/modules/booking/api", async (orig) => ({ ...(await orig<object>()), nextOpeningAt: vi.fn(() => Promise.resolve(null)) }));

// The engine first, so its imports resolve to the mocks (see step.test.ts).
const { jobs } = await import("./jobs");
const f = await import("./engine/automation-p3.fixtures");
const actions = await import("./actions");
const ops = await import("@/modules/ops/api");
const commerce = await import("@/modules/commerce/api");
const { seedSystemTemplates } = await import("@/modules/email/seed");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { setAppDb } = await import("@/lib/ctx");

let h: DbHandle;
let marketingUserId: string;

const MIN = 60_000;
const HOURS = 60 * MIN;
const DAYS = 24 * HOURS;
const T0 = new Date("2026-11-06T09:00:00Z"); // Friday 10:00 Brussels
const at = (ms: number) => new Date(T0.getTime() + ms);

const R2 = SEED_AUTOMATIONS.filter((s) => s.release === "R2");
const DPIA = ["webinar-attended", "webinar-watched-15", "webinar-watched-30", "webinar-watched-end", "webinar-replay", "webinar-on-demand", "webinar-cta-click", "webinar-cta-sales-task"];
/** Archived by "BEAM" before the release: activation must leave it alone. */
const SWITCHED_OFF = "webinar-on-demand";

const activate = () => h.db.transaction((tx) => activateReleaseSequences(tx, "R2", { isDpiaApproved: ops.isDpiaApproved, now: T0 }));

async function setCheckoutFlag(state: "on" | "off"): Promise<void> {
  await h.db.insert(featureFlags).values({ key: "ff_commerce_checkout_recovery", state }).onConflictDoUpdate({ target: featureFlags.key, set: { state } });
  clearFlagCache();
}

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  expect(await seedDefaults(h.db)).toContain("automation");
  // Email's registry system rows (`webinar.reminder`, `webinar.replay_available`, `commerce.checkout_recovery`).
  await seedSystemTemplates(h.db);
  await makeUser(h.db, { roleKey: "sales", name: "Sam Sales" });
  await makeUser(h.db, { roleKey: "customer_service", name: "Cas Service" });
  const marketing = await makeUser(h.db, { roleKey: "marketing", name: "Mia Marketing" });
  marketingUserId = marketing.id;
  await h.db.update(roles).set({ permissions: ["automations.write", "automations.publish", "reports.read"] }).where(eq(roles.key, "marketing"));
  await setCheckoutFlag("off");
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  state.reachable.clear();
  state.sent = [];
  vi.mocked(commerce.markCheckoutRecoveryMessage).mockClear();
  vi.mocked(commerce.getCheckoutRecoveryProps).mockClear();
  await h.db.execute(sql`delete from jobs`);
  await f.setCursor(h.db, await f.maxEventId(h.db));
});

const stepJob = jobs.find((j) => j.kind === "automation.step")!;
const evaluateJob = jobs.find((j) => j.kind === "automation.evaluate")!;

/** One `automation.evaluate` run at `now`, then every enqueued `automation.step` job at `now`. */
async function tick(now: Date): Promise<void> {
  await evaluateJob.run(makeJobCtx(h.db, "automation.evaluate", { now }), {});
  const pending = await h.db.select().from(jobsTable).where(and(eq(jobsTable.kind, "automation.step"), eq(jobsTable.status, "pending"))).orderBy(asc(jobsTable.createdAt));
  for (const job of pending) {
    await stepJob.run(makeJobCtx(h.db, "automation.step", { now, jobId: job.id }), stepJob.input.parse(job.payload));
    await h.db.delete(jobsTable).where(eq(jobsTable.id, job.id));
  }
}

async function enrolmentsOf(personId: string, slug: string) {
  return (
    await h.db
      .select({ e: automationEnrolments })
      .from(automationEnrolments)
      .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
      .where(and(eq(automationEnrolments.personId, personId), eq(automations.slug, slug)))
      .orderBy(asc(automationEnrolments.enteredAt), asc(automationEnrolments.createdAt))
  ).map((r) => r.e);
}
const enrolmentOf = async (personId: string, slug: string) => (await enrolmentsOf(personId, slug))[0] ?? null;

/** Slugs the person is or was enrolled in. */
async function slugsOf(personId: string): Promise<string[]> {
  const rows = await h.db
    .select({ slug: automations.slug })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .where(eq(automationEnrolments.personId, personId));
  return [...new Set(rows.map((r) => r.slug))].sort();
}

/** Runs the journey step by step until it ends or the next step is after `until`. */
async function drive(personId: string, slug: string, until: Date) {
  for (let i = 0; i < 40; i++) {
    const list = await enrolmentsOf(personId, slug);
    const e = list.find((x) => x.status === "active") ?? list.at(-1);
    if (!e) throw new Error(`${slug}: no enrolment`);
    if (e.status !== "active" || !e.nextStepAt || e.nextStepAt > until) return e;
    await tick(e.nextStepAt);
  }
  throw new Error(`${slug}: did not settle`);
}

const outcomes = async (enrolmentId: string) => (await f.stepOutcomes(h.db, enrolmentId)).sort((x, y) => (x[0] ?? "").localeCompare(y[0] ?? "") || x[1].localeCompare(y[1]));
const sentTo = (personId: string) => state.sent.filter((s) => s.personId === personId);

async function event(personId: string, kind: string, when: Date, data: Record<string, unknown> = {}, o: { ref?: { type: string; id: string }; mode?: "live" | "replay" | "on_demand" } = {}) {
  return f.makeEvent(h.db, { personId, kind, occurredAt: when, data, refType: o.ref?.type ?? null, refId: o.ref?.id ?? null, ...(o.mode ? { mode: o.mode } : {}) });
}

/** A webinar registration id with the events webinar 4.1 emits for it. */
function webinarOf(personId: string, mode: "live" | "replay" | "on_demand" = "live") {
  const webinarId = randomUUID();
  const registrationId = randomUUID();
  const ref = { type: "webinar_registration", id: registrationId };
  const base = { webinar_id: webinarId, registration_id: registrationId };
  return {
    registrationId,
    registered: (when: Date, startsAt: Date, extra: Record<string, unknown> = {}) =>
      event(
        personId,
        "webinar.registered",
        when,
        {
          ...base,
          slug: "slaap-beter",
          title: { "nl-BE": "Beter slapen", "fr-BE": "Mieux dormir", en: "Sleep better" },
          webinar_mode: "live",
          starts_at: startsAt.toISOString(),
          ends_at: new Date(startsAt.getTime() + HOURS).toISOString(),
          session: null,
          person_status: "lead",
          source: "site",
          utm: {},
          ...extra,
        },
        { ref, mode },
      ),
    happened: (kind: string, when: Date, data: Record<string, unknown> = {}, m: "live" | "replay" | "on_demand" = mode) => event(personId, kind, when, { ...base, ...data }, { ref, mode: m }),
  };
}

async function tasksOf(personId: string) {
  return h.db.select({ id: tasks.id, title: tasks.title, status: tasks.status, source: tasks.source }).from(tasks).where(eq(tasks.personId, personId)).orderBy(asc(tasks.createdAt));
}

async function hasTag(personId: string, key: string): Promise<boolean> {
  const rows = await h.db.select({ id: personTags.personId }).from(personTags).innerJoin(tags, eq(tags.id, personTags.tagId)).where(and(eq(personTags.personId, personId), eq(tags.key, key)));
  return rows.length > 0;
}

async function automationBySlug(slug: string) {
  const [a] = await h.db.select().from(automations).where(eq(automations.slug, slug));
  return a!;
}

// ---------------------------------------------------------------------------
// Activation (A-5a, decision 30): runs first; every later suite needs the active journeys.
// ---------------------------------------------------------------------------

describe("activateReleaseSequences (A-5a, decision 30)", () => {
  it("the seed writes every R2 journey as a draft with a published version and no activation", async () => {
    for (const s of R2) expect(await automationBySlug(s.slug), s.slug).toMatchObject({ status: "draft", activatedAt: null, currentVersionId: expect.any(String) });
  });

  it("activates the ungated R2 drafts, leaves the eight DPIA journeys draft until the DPIA is approved, and is idempotent", async () => {
    await h.db.update(automations).set({ status: "archived" }).where(eq(automations.slug, SWITCHED_OFF));
    state.dpia = false;
    const first = await activate();
    expect(first.activated).toEqual(expect.arrayContaining(["webinar-registration", "webinar-no-show", "webinar-poll-answer", "abandoned-checkout", "waitlist-follow-up", "event-follow-up", b2cPlaybookSlug("engaged_lead")]));
    for (const slug of DPIA) expect(first.activated).not.toContain(slug);
    expect(first.blocked.sort()).toEqual(DPIA.filter((s) => s !== SWITCHED_OFF).map((s) => `${s}:watch_time_profiling`).sort());
    for (const slug of DPIA.filter((s) => s !== SWITCHED_OFF)) expect((await automationBySlug(slug)).status, slug).toBe("draft");
    // Staff cannot switch one on by hand either while the DPIA is open.
    const { token } = await createAuthSession(h.db, { userId: marketingUserId, audience: "staff", roleKey: "marketing", now: new Date(), mfaAt: new Date() });
    jar.set(SESSION_COOKIE, token);
    const refused = await actions.activateAutomation({ automationId: (await automationBySlug("webinar-attended")).id });
    expect(refused).toMatchObject({ ok: false, error: { code: "conflict", message: "dpia_not_approved:watch_time_profiling" } });

    state.dpia = true;
    const second = await activate();
    expect(second.activated.sort()).toEqual(DPIA.filter((s) => s !== SWITCHED_OFF).sort());
    expect(second.blocked).toEqual([]);
    expect(await activate()).toEqual({ activated: [], blocked: [] });

    for (const s of R2.filter((x) => x.slug !== SWITCHED_OFF)) expect(await automationBySlug(s.slug), s.slug).toMatchObject({ status: "active", activatedAt: T0 });
    expect((await automationBySlug(SWITCHED_OFF)).status).toBe("archived");
    const a = await automationBySlug("webinar-registration");
    expect(await h.db.select({ actor: auditLog.actor, newValue: auditLog.newValue }).from(auditLog).where(and(eq(auditLog.action, "automation.activate"), eq(auditLog.entityId, a.id)))).toEqual([
      { actor: { kind: "system", id: null }, newValue: { status: "active", release: "R2" } },
    ]);
  });

  it("a journey activated once and paused later is never re-activated", async () => {
    await h.db.update(automations).set({ status: "paused", pausedAt: T0 }).where(eq(automations.slug, b2cPlaybookSlug("lost")));
    expect((await activate()).activated).toEqual([]);
    expect((await automationBySlug(b2cPlaybookSlug("lost"))).status).toBe("paused");
    await h.db.update(automations).set({ status: "active", pausedAt: null }).where(eq(automations.slug, b2cPlaybookSlug("lost")));
  });
});

// ---------------------------------------------------------------------------
// Webinar journeys (spec 3.6, cross-module D52)
// ---------------------------------------------------------------------------

describe("webinar-registration (scenario 1 in R2)", () => {
  it("A-18 a Friday 10:00 registrant of a Sunday 10:00 live webinar gets only the h3 reminder, with no confirmation step", async () => {
    const p = await makePerson(h.db);
    const w = webinarOf(p.id);
    const startsAt = new Date("2026-11-08T09:00:00Z"); // Sunday 10:00 Brussels
    await w.registered(T0, startsAt);
    await tick(T0);
    const e = await enrolmentOf(p.id, "webinar-registration");
    expect(e).toMatchObject({ status: "active", subjectKey: `webinar_registration:${w.registrationId}`, nextStepKey: "h3", nextStepAt: new Date("2026-11-08T06:00:00Z") });
    expect(await outcomes(e!.id)).toEqual([
      ["d3", "skipped_late_entry"],
      ["d7", "skipped_late_entry"],
    ]);
    const done = await drive(p.id, "webinar-registration", new Date("2026-11-09T00:00:00Z"));
    expect(done).toMatchObject({ status: "completed" });
    expect(await outcomes(e!.id)).toEqual([
      [null, "completed"],
      ["d3", "skipped_late_entry"],
      ["d7", "skipped_late_entry"],
      ["h3", "sent"],
    ]);
    expect(sentTo(p.id).map((s) => [s.templateSlug, s.stepKey, s.kind])).toEqual([["webinar.reminder", "h3", "transactional"]]);
    expect(sentTo(p.id)[0]!.context).toMatchObject({ ref_type: "webinar_registration", ref_id: w.registrationId, registration_id: w.registrationId });
  });

  it("an early registrant gets webinar.reminder with stepKey d7, d3 and h3", async () => {
    const p = await makePerson(h.db);
    const w = webinarOf(p.id);
    await w.registered(T0, at(20 * DAYS));
    await tick(T0);
    await drive(p.id, "webinar-registration", at(21 * DAYS));
    expect(sentTo(p.id).map((s) => [s.templateSlug, s.stepKey])).toEqual([
      ["webinar.reminder", "d7"],
      ["webinar.reminder", "d3"],
      ["webinar.reminder", "h3"],
    ]);
  });

  it("webinar.rescheduled exits it and the fresh webinar.registered re-enrols on the new anchor (A-22)", async () => {
    const p = await makePerson(h.db);
    const w = webinarOf(p.id);
    const first = at(20 * DAYS);
    const moved = at(27 * DAYS);
    await w.registered(T0, first);
    await tick(T0);
    const later = at(HOURS);
    await w.happened("webinar.rescheduled", later, { starts_at: moved.toISOString(), previous_starts_at: first.toISOString() });
    await w.registered(later, moved, { rescheduled: true });
    await tick(later);
    const rows = await enrolmentsOf(p.id, "webinar-registration");
    expect(rows.map((r) => [r.status, r.endReason, r.anchorAt?.toISOString()])).toEqual([
      ["exited", "exit_event:webinar.rescheduled", first.toISOString()],
      ["active", null, moved.toISOString()],
    ]);
    expect(rows[1]).toMatchObject({ subjectKey: `webinar_registration:${w.registrationId}`, nextStepKey: "d7", nextStepAt: new Date(moved.getTime() - 7 * DAYS) });
  });

  it("webinar.registration_cancelled and webinar.cancelled exit it", async () => {
    const a = await makePerson(h.db);
    const b = await makePerson(h.db);
    const wa = webinarOf(a.id);
    const wb = webinarOf(b.id);
    await wa.registered(T0, at(20 * DAYS));
    await wb.registered(T0, at(20 * DAYS));
    await tick(T0);
    await wa.happened("webinar.registration_cancelled", at(HOURS), { by: "customer" });
    await wb.happened("webinar.cancelled", at(HOURS), { reason: "speaker_ill" });
    await tick(at(HOURS));
    expect(await enrolmentOf(a.id, "webinar-registration")).toMatchObject({ status: "exited", endReason: "exit_event:webinar.registration_cancelled" });
    expect(await enrolmentOf(b.id, "webinar-registration")).toMatchObject({ status: "exited", endReason: "exit_event:webinar.cancelled" });
  });

  it("a registration alone triggers no follow-up journey (webinar rule 17)", async () => {
    const p = await makePerson(h.db);
    state.reachable.add(p.id);
    await webinarOf(p.id).registered(T0, at(20 * DAYS));
    await tick(T0);
    expect(await slugsOf(p.id)).toEqual(["webinar-registration"]);
  });

  it("an on-demand registration does not enter the live reminders", async () => {
    const p = await makePerson(h.db);
    await webinarOf(p.id, "on_demand").registered(T0, at(20 * DAYS), { webinar_mode: "on_demand", starts_at: null, ends_at: null });
    await tick(T0);
    expect(await slugsOf(p.id)).toEqual([]);
  });
});

describe("webinar behaviour journeys (exclusive webinar group, A-15)", () => {
  it("webinar.attended (live) then webinar.watched end: webinar-watched-end supersedes webinar-attended before its first step", async () => {
    const p = await makePerson(h.db);
    state.reachable.add(p.id);
    const w = webinarOf(p.id);
    await w.happened("webinar.attended", T0, { watched_sec: 900 });
    await tick(T0);
    const attended = await enrolmentOf(p.id, "webinar-attended");
    expect(attended).toMatchObject({ status: "active", nextStepKey: "follow_up", nextStepAt: at(HOURS) });
    await w.happened("webinar.watched", at(40 * MIN), { threshold: "end", watched_sec: 3_600 });
    await tick(at(40 * MIN));
    expect(await enrolmentOf(p.id, "webinar-attended")).toMatchObject({ status: "exited", endReason: "superseded" });
    expect(await outcomes(attended!.id)).not.toContainEqual(["follow_up", "sent"]);
    const end = await drive(p.id, "webinar-watched-end", at(3 * DAYS));
    expect(end).toMatchObject({ status: "completed" });
    expect(await outcomes(end.id)).toEqual([
      [null, "completed"],
      ["follow_up", "sent"],
      ["sales_task", "task_created"],
    ]);
    expect(sentTo(p.id).map((s) => [s.templateSlug, s.kind])).toEqual([["webinar-follow-up", "marketing"]]);
  });

  it("scenario 5: replay events never trigger live journeys and do trigger webinar-replay", async () => {
    const p = await makePerson(h.db);
    state.reachable.add(p.id);
    const w = webinarOf(p.id, "replay");
    await w.happened("webinar.watched", T0, { threshold: "end", watched_sec: 3_600 });
    await w.happened("webinar.watched", T0, { threshold: "30m", watched_sec: 1_800 });
    await w.happened("webinar.watched", T0, { threshold: "15m", watched_sec: 900 });
    await w.happened("webinar.cta_clicked", T0, { cta_key: "book_now", url: "https://beam.be/nl-BE/booking" });
    await w.happened("webinar.attended", T0, { watched_sec: 900 });
    await tick(T0);
    const slugs = await slugsOf(p.id);
    for (const live of ["webinar-attended", "webinar-watched-end", "webinar-watched-30", "webinar-watched-15", "webinar-cta-click"]) expect(slugs).not.toContain(live);
    expect(slugs).toContain("webinar-replay");
    // The CTA sales task acts in any mode (cross-module D52).
    expect(slugs).toContain("webinar-cta-sales-task");
    await drive(p.id, "webinar-replay", at(DAYS));
    expect(sentTo(p.id).map((s) => s.templateSlug)).toEqual(["webinar-follow-up"]);
  });

  it("webinar-watched-15 tags the person engaged and sends its follow-up", async () => {
    const p = await makePerson(h.db);
    state.reachable.add(p.id);
    await webinarOf(p.id).happened("webinar.watched", T0, { threshold: "15m", watched_sec: 900 });
    await tick(T0);
    expect(await hasTag(p.id, "engaged")).toBe(true);
    const e = await drive(p.id, "webinar-watched-15", at(DAYS));
    expect(await outcomes(e.id)).toEqual([
      [null, "completed"],
      ["follow_up", "sent"],
      ["tag_engaged", "tag_applied"],
    ]);
  });

  it("webinar-no-show enrols only with replay_available = true, sends webinar.replay_available, and exits on webinar.attended", async () => {
    const none = await makePerson(h.db);
    const sends = await makePerson(h.db);
    const watches = await makePerson(h.db);
    for (const p of [none, sends, watches]) state.reachable.add(p.id);
    await webinarOf(none.id).happened("webinar.no_show", T0, { replay_available: false, replay_until_at: null });
    await webinarOf(sends.id).happened("webinar.no_show", T0, { replay_available: true, replay_until_at: at(7 * DAYS).toISOString() });
    const w = webinarOf(watches.id);
    await w.happened("webinar.no_show", T0, { replay_available: true, replay_until_at: at(7 * DAYS).toISOString() });
    await tick(T0);
    expect(await slugsOf(none.id)).toEqual([]);
    expect(await enrolmentOf(watches.id, "webinar-no-show")).toMatchObject({ status: "active", nextStepKey: "replay" });

    await w.happened("webinar.attended", at(30 * MIN), { watched_sec: 900 }, "replay");
    await tick(at(30 * MIN));
    expect(await enrolmentOf(watches.id, "webinar-no-show")).toMatchObject({ status: "exited", endReason: "exit_event:webinar.attended" });
    expect(await enrolmentOf(watches.id, "webinar-replay")).toMatchObject({ status: "active" });

    const e = await drive(sends.id, "webinar-no-show", at(DAYS));
    expect(e).toMatchObject({ status: "completed" });
    expect(sentTo(sends.id).map((s) => [s.templateSlug, s.stepKey, s.kind])).toEqual([["webinar.replay_available", "replay", "transactional"]]);
  });

  it("webinar.poll_answered enrols webinar-poll-answer, which adds the engaged tag", async () => {
    const p = await makePerson(h.db);
    await webinarOf(p.id).happened("webinar.poll_answered", T0, { poll_key: "sleep", option_keys: ["bad"], option_key: "bad" });
    await tick(T0);
    const e = await enrolmentOf(p.id, "webinar-poll-answer");
    expect(e).toMatchObject({ status: "completed" });
    expect(await outcomes(e!.id)).toEqual([
      [null, "completed"],
      ["tag_engaged", "tag_applied"],
    ]);
    expect(await hasTag(p.id, "engaged")).toBe(true);
  });
});

describe("webinar CTA clicks (cross-module D52)", () => {
  const click = (w: ReturnType<typeof webinarOf>, when: Date, mode: "live" | "replay" = "live") =>
    w.happened("webinar.cta_clicked", when, { cta_key: "book_now", url: "https://beam.be/nl-BE/booking" }, mode);

  it("creates one sales task through webinar-cta-sales-task even while a sales_journey enrolment blocks the webinar group", async () => {
    const p = await makePerson(h.db);
    state.reachable.add(p.id);
    // A first visit puts the person in after-first-visit (customer_journey, ahead of webinar in the lane).
    const visit = await f.makeBooking(h.db, { personId: p.id, startsAt: at(-2 * HOURS), status: "attended", kind: "day" });
    await event(p.id, "booking.attended", at(-HOURS), { is_first_visit: true, session_kind: "day", booking_id: visit.booking.id }, { ref: { type: "booking", id: visit.booking.id } });
    await tick(T0);
    expect(await enrolmentOf(p.id, "after-first-visit")).toMatchObject({ status: "active" });
    const w = webinarOf(p.id);
    await click(w, at(MIN));
    await click(w, at(2 * MIN));
    await tick(at(2 * MIN));
    expect(await enrolmentOf(p.id, "webinar-cta-click")).toBeNull();
    const skipped = await h.db
      .select({ outcome: automationRuns.outcome })
      .from(automationRuns)
      .innerJoin(automations, eq(automations.id, automationRuns.automationId))
      .where(and(eq(automationRuns.personId, p.id), eq(automations.slug, "webinar-cta-click")));
    expect(skipped.map((r) => r.outcome)).toContain("skipped_exclusive");
    const salesTasks = (await tasksOf(p.id)).filter((t) => t.title.startsWith("Webinar CTA clicked"));
    expect(salesTasks).toEqual([{ id: expect.any(String), title: "Webinar CTA clicked: book_now", status: "open", source: "automation" }]);
    expect(await enrolmentsOf(p.id, "webinar-cta-sales-task")).toHaveLength(1);
  });

  it("creates no task when the person has a future booking", async () => {
    const p = await makePerson(h.db);
    await f.makeBooking(h.db, { personId: p.id, startsAt: at(5 * DAYS), status: "confirmed", kind: "day" });
    await click(webinarOf(p.id), T0, "replay");
    await tick(T0);
    const e = await enrolmentOf(p.id, "webinar-cta-sales-task");
    expect(await outcomes(e!.id)).toEqual([
      [null, "completed"],
      ["sales_task", "skipped_condition"],
    ]);
    expect(await tasksOf(p.id)).toEqual([]);
  });

  it("webinar-cta-click sends only its follow_up email (the task is the sales journey's)", async () => {
    const p = await makePerson(h.db);
    state.reachable.add(p.id);
    await click(webinarOf(p.id), T0);
    await tick(T0);
    const e = await drive(p.id, "webinar-cta-click", at(2 * DAYS));
    expect(await outcomes(e.id)).toEqual([
      [null, "completed"],
      ["follow_up", "sent"],
    ]);
    expect(sentTo(p.id).map((s) => s.templateSlug)).toEqual(["webinar-follow-up"]);
    expect((await tasksOf(p.id)).map((t) => t.title)).toEqual(["Webinar CTA clicked: book_now"]);
  });
});
