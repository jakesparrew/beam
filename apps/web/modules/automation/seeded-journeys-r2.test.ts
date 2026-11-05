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
