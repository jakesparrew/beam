/**
 * The real seeded journeys of spec 3.6 end to end (automation-P4): the `defaults` seed on a fresh
 * database, then activity events through `automation.evaluate` (enrolment, exits) and the
 * `automation.step` job (send-time checks, A-26 to A-34). Email's queue functions and the
 * reachability read are mocked (no consent fixtures; `state.reachable` decides), forms'
 * `getPublishedFormMeta` is mocked so the health declaration can be published; crm, credits and
 * booking facts are real rows.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationEnrolments, automationRuns, automations, automationVersions, bookings, formSubmissions, formVersions, forms, jobs as jobsTable, personTags, tags } from "@beam/db/schema";
import { seedDefaults } from "@beam/db/seed";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeCreditGrant, makeMembership } from "@beam/db/testing/credits-factories";
import { and, asc, eq, sql } from "@/lib/ctx";
import { makeJobCtx, resetRuntime } from "@/lib/testing";
import type * as EmailApi from "@/modules/email/api";
import type * as FormsApi from "@/modules/forms/api";

const state = vi.hoisted(() => ({
  reachable: new Set<string>(),
  formAvailable: false,
  sent: [] as { templateSlug: string; personId: string; stepKey?: string; kind: "marketing" | "transactional" }[],
}));

vi.mock("@/modules/email/api", async (orig) => {
  const { sql: q } = await import("drizzle-orm");
  const queue = (kind: "marketing" | "transactional") =>
    vi.fn(async (ctx: { tx: Tx }, input: { templateSlug: string; personId: string; enrolmentId: string; idempotencyKey: string; stepKey?: string }) => {
      const res = await ctx.tx.execute(q`insert into email_messages (person_id, kind, enrolment_id, locale, idempotency_key)
        values (${input.personId}::uuid, 'transactional', ${input.enrolmentId}::uuid, 'nl-BE', ${input.idempotencyKey})
        on conflict (idempotency_key) do update set updated_at = now() returning id::text as id`);
      state.sent.push({ templateSlug: input.templateSlug, personId: input.personId, kind, ...(input.stepKey ? { stepKey: input.stepKey } : {}) });
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
vi.mock("@/modules/forms/api", async (orig) => ({
  ...(await orig<typeof FormsApi>()),
  getPublishedFormMeta: vi.fn(() => Promise.resolve(state.formAvailable ? { formId: "00000000-0000-4000-8000-0000000000f1", locales: ["nl-BE", "fr-BE", "en"] } : null)),
}));
vi.mock("@/modules/booking/api", async (orig) => ({ ...(await orig<object>()), nextOpeningAt: vi.fn(() => Promise.resolve(null)) }));

// The engine first, so its imports resolve to the mocks (see step.test.ts).
const { jobs } = await import("./jobs");
const { seedAutomation } = await import("./engine/seed-automations");
const f = await import("./engine/automation-p3.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  // `pnpm seed` on a fresh database: the defaults profile loads this module's seed.
  const ran = await seedDefaults(h.db);
  expect(ran).toContain("automation");
  await makeUser(h.db, { roleKey: "sales", name: "Sam Sales" });
  await makeUser(h.db, { roleKey: "customer_service", name: "Cas Service" });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  state.reachable.clear();
  state.formAvailable = false;
  state.sent = [];
  await h.db.execute(sql`delete from jobs`);
  await f.setCursor(h.db, await f.maxEventId(h.db));
});

const MIN = 60_000;
const HOURS = 60 * MIN;
const DAYS = 24 * HOURS;
const T0 = new Date("2026-11-06T09:00:00Z"); // Friday 10:00 Brussels

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

async function enrolmentOf(personId: string, slug: string) {
  const [row] = await h.db
    .select({ e: automationEnrolments })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .where(and(eq(automationEnrolments.personId, personId), eq(automations.slug, slug)))
    .orderBy(asc(automationEnrolments.enteredAt));
  return row?.e ?? null;
}

async function enrolmentsOf(personId: string, slug: string) {
  return (
    await h.db
      .select({ e: automationEnrolments })
      .from(automationEnrolments)
      .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
      .where(and(eq(automationEnrolments.personId, personId), eq(automations.slug, slug)))
  ).map((r) => r.e);
}

/** Runs the journey of `personId` in `slug` step by step until it ends or the next step is after `until`. */
async function drive(personId: string, slug: string, until: Date): Promise<NonNullable<Awaited<ReturnType<typeof enrolmentOf>>>> {
  for (let i = 0; i < 40; i++) {
    const e = await enrolmentOf(personId, slug);
    if (!e) throw new Error(`${slug}: no enrolment`);
    if (e.status !== "active" || !e.nextStepAt || e.nextStepAt > until) return e;
    await tick(e.nextStepAt);
  }
  throw new Error(`${slug}: did not settle`);
}

/** Step outcomes of an enrolment, sorted (planning-time rows carry the wall clock, step rows the job time). */
const outcomes = async (enrolmentId: string) => (await f.stepOutcomes(h.db, enrolmentId)).sort((x, y) => (x[0] ?? "").localeCompare(y[0] ?? "") || x[1].localeCompare(y[1]));
const sentTo = (personId: string) => state.sent.filter((s) => s.personId === personId).map((s) => s.templateSlug);

async function event(personId: string, kind: string, at: Date, data: Record<string, unknown> = {}, ref?: { type: string; id: string }) {
  return f.makeEvent(h.db, { personId, kind, occurredAt: at, data, refType: ref?.type ?? null, refId: ref?.id ?? null });
}

describe("scenario 1: event-registration with the real seed", () => {
  it("A-18 a Friday 10:00 registration for a Sunday 10:00 event gets only the day-of reminder", async () => {
    const p = await makePerson(h.db);
    const startsAt = new Date("2026-11-08T09:00:00Z"); // Sunday 10:00 Brussels
    const { booking, session } = await f.makeBooking(h.db, { personId: p.id, startsAt, status: "confirmed", kind: "event" });
    await event(p.id, "booking.confirmed", T0, { session_kind: "event", starts_at: startsAt.toISOString(), is_first_booking: false, session_id: session.id, booking_id: booking.id }, { type: "booking", id: booking.id });
    await tick(T0);
    const e = await enrolmentOf(p.id, "event-registration");
    expect(e).toMatchObject({ status: "active", subjectKey: `booking:${booking.id}`, nextStepKey: "reminder_day_of", nextStepAt: new Date("2026-11-08T06:00:00Z") });
    expect(await outcomes(e!.id)).toEqual([
      ["reminder_3d", "skipped_late_entry"],
      ["reminder_7d", "skipped_late_entry"],
    ]);
    const done = await drive(p.id, "event-registration", new Date("2026-11-09T00:00:00Z"));
    expect(done).toMatchObject({ status: "completed", endReason: "completed" });
    expect(await outcomes(e!.id)).toEqual([
      [null, "completed"],
      ["reminder_3d", "skipped_late_entry"],
      ["reminder_7d", "skipped_late_entry"],
      ["reminder_day_of", "sent"],
    ]);
    expect(state.sent).toEqual([{ templateSlug: "automation.event_reminder_day_of", personId: p.id, kind: "transactional", stepKey: "reminder_day_of" }]);
  });

  it("a cancelled event booking exits the journey of that booking only", async () => {
    const p = await makePerson(h.db);
    const startsAt = new Date(T0.getTime() + 20 * DAYS);
    const one = await f.makeBooking(h.db, { personId: p.id, startsAt, status: "confirmed", kind: "event" });
    const two = await f.makeBooking(h.db, { personId: p.id, startsAt: new Date(startsAt.getTime() + DAYS), status: "confirmed", kind: "event" });
    for (const b of [one, two]) await event(p.id, "booking.confirmed", T0, { session_kind: "event", starts_at: b.session.startsAt.toISOString() }, { type: "booking", id: b.booking.id });
    await tick(T0);
    await event(p.id, "booking.cancelled", new Date(T0.getTime() + HOURS), { cancel_reason_code: "customer" }, { type: "booking", id: one.booking.id });
    await tick(new Date(T0.getTime() + HOURS));
    const rows = await enrolmentsOf(p.id, "event-registration");
    expect(rows.map((r) => [r.subjectKey, r.status, r.endReason]).sort()).toEqual(
      [
        [`booking:${one.booking.id}`, "exited", "exit_event:booking.cancelled"],
        [`booking:${two.booking.id}`, "active", null],
      ].sort(),
    );
  });
});

describe("lead journeys", () => {
  const created = (p: { id: string }, at = T0) => event(p.id, "person.created", at, { acquisition_source: "website" });

  it("welcome-lead exits on order.paid, and on membership.started", async () => {
    const a = await makePerson(h.db);
    const b = await makePerson(h.db);
    state.reachable.add(a.id).add(b.id);
    await created(a);
    await created(b);
    await tick(T0);
    // The +0 welcome is due at entry, so the same tick sends it.
    expect(await enrolmentOf(a.id, "welcome-lead")).toMatchObject({ status: "active", nextStepKey: "edu_1" });
    expect(sentTo(a.id)).toEqual(["welcome-lead-welcome"]);
    expect(await enrolmentOf(a.id, "lead-sales-follow-up")).toMatchObject({ status: "active", nextStepKey: "call_1" });
    await event(a.id, "order.paid", new Date(T0.getTime() + HOURS), { order_id: randomUUID(), lines: [{ kind: "package" }] });
    await event(b.id, "membership.started", new Date(T0.getTime() + HOURS), { membership_id: randomUUID(), status: "active" });
    await tick(new Date(T0.getTime() + HOURS));
    expect(await enrolmentOf(a.id, "welcome-lead")).toMatchObject({ status: "exited", endReason: "exit_event:order.paid" });
    expect(await enrolmentOf(a.id, "lead-sales-follow-up")).toMatchObject({ status: "exited", endReason: "exit_event:order.paid" });
    expect(await enrolmentOf(b.id, "welcome-lead")).toMatchObject({ status: "exited", endReason: "exit_event:membership.started" });
  });

  it("welcome-lead sends the welcome at once and tags a clicker engaged", async () => {
    const p = await makePerson(h.db);
    state.reachable.add(p.id);
    await created(p);
    await tick(T0);
    await event(p.id, "email.clicked", new Date(T0.getTime() + 2 * DAYS), { link_index: 0, url: "https://beam.be/nl-BE/" });
    const e = await drive(p.id, "welcome-lead", new Date(T0.getTime() + 8 * DAYS));
    expect(sentTo(p.id).slice(0, 4)).toEqual(["welcome-lead-welcome", "welcome-lead-edu-1", "welcome-lead-edu-2", "welcome-lead-webinar-invite"]);
    expect((await outcomes(e.id)).filter(([k]) => k === "engaged" || k === "tag_engaged")).toEqual([
      ["engaged", "branched"],
      ["tag_engaged", "tag_applied"],
    ]);
  });

  it("an imported person or a staff-typed contact enrols in no lead journey", async () => {
    const p = await makePerson(h.db);
    state.reachable.add(p.id);
    await event(p.id, "person.created", T0, { acquisition_source: "import" });
    await event(p.id, "person.created", T0, { acquisition_source: "manual" });
    await tick(T0);
    expect(await enrolmentOf(p.id, "welcome-lead")).toBeNull();
    expect(await enrolmentOf(p.id, "lead-sales-follow-up")).toBeNull();
  });
});

describe("assessment-follow-up", () => {
  const result = (p: { id: string }, at: Date) => event(p.id, "assessment.result_generated", at, { form_slug: "sleep-check", outcome_key: "high", submission_id: randomUUID() });

  it("A-14 enrols nobody without newsletter consent (a result does not create consent)", async () => {
    const p = await makePerson(h.db);
    await result(p, T0);
    await tick(T0);
    expect(await enrolmentOf(p.id, "assessment-follow-up")).toBeNull();
    const [run] = await h.db
      .select({ outcome: automationRuns.outcome, enrolmentId: automationRuns.enrolmentId })
      .from(automationRuns)
      .innerJoin(automations, eq(automations.id, automationRuns.automationId))
      .where(and(eq(automationRuns.personId, p.id), eq(automations.slug, "assessment-follow-up")));
    expect(run).toEqual({ outcome: "skipped_unreachable", enrolmentId: null });
  });

  it("A-15 with consent it supersedes welcome-lead in the lead_nurture group", async () => {
    const p = await makePerson(h.db);
    state.reachable.add(p.id);
    await event(p.id, "person.created", T0, { acquisition_source: "website" });
    await tick(T0);
    expect(await enrolmentOf(p.id, "welcome-lead")).toMatchObject({ status: "active" });
    const at = new Date(T0.getTime() + HOURS);
    await result(p, at);
    await tick(at);
    expect(await enrolmentOf(p.id, "welcome-lead")).toMatchObject({ status: "exited", endReason: "superseded" });
    expect(await enrolmentOf(p.id, "assessment-follow-up")).toMatchObject({ status: "active", nextStepKey: "result_follow_up" });
  });
});

describe("booking journeys", () => {
  async function firstBooking(o: { declared: boolean }) {
    const p = await makePerson(h.db);
    const startsAt = new Date(T0.getTime() + 5 * DAYS);
    const { booking, session } = await f.makeBooking(h.db, { personId: p.id, startsAt, status: "confirmed", kind: "day" });
    if (o.declared) {
      const [form] = await h.db.select({ id: forms.id }).from(forms).where(eq(forms.slug, "health-declaration"));
      const [version] = await h.db.select({ id: formVersions.id }).from(formVersions).where(eq(formVersions.formId, form!.id));
      await h.db.insert(formSubmissions).values({
        formId: form!.id,
        formVersionId: version!.id,
        personId: p.id,
        status: "completed",
        identifiedBy: "token",
        funnel: "form:health-declaration",
        locale: "nl-BE",
        completedAt: new Date(T0.getTime() - 30 * DAYS),
      });
    }
    await event(p.id, "booking.confirmed", T0, { session_kind: "day", starts_at: startsAt.toISOString(), is_first_booking: true, session_id: session.id }, { type: "booking", id: booking.id });
    await tick(T0);
    return { p, booking };
  }

  it("after-first-booking sends preparation and skips intake_reminder when a health declaration exists", async () => {
    state.formAvailable = true;
    const { p } = await firstBooking({ declared: true });
    const e = await drive(p.id, "after-first-booking", new Date(T0.getTime() + 10 * DAYS));
    expect(await outcomes(e.id)).toEqual([
      [null, "completed"],
      ["intake_reminder", "skipped_condition"],
      ["preparation", "sent"],
    ]);
    expect(sentTo(p.id)).toEqual(["automation.first_booking_preparation"]);
  });

  it("after-first-booking sends the intake reminder when the form is published and nothing is declared", async () => {
    state.formAvailable = true;
    const { p } = await firstBooking({ declared: false });
    await drive(p.id, "after-first-booking", new Date(T0.getTime() + 10 * DAYS));
    expect(sentTo(p.id)).toEqual(["automation.first_booking_preparation", "automation.first_booking_intake_reminder"]);
  });

  it("DM-15 while health-declaration is not published the intake reminder is skipped", async () => {
    const { p } = await firstBooking({ declared: false });
    await drive(p.id, "after-first-booking", new Date(T0.getTime() + 10 * DAYS));
    expect(sentTo(p.id)).toEqual(["automation.first_booking_preparation"]);
  });

  it("after-first-visit starts after the first attendance and sends the follow-up", async () => {
    const p = await makePerson(h.db);
    await event(p.id, "booking.attended", T0, { session_kind: "day", is_first_visit: true }, { type: "booking", id: randomUUID() });
    await tick(T0);
    expect(await enrolmentOf(p.id, "after-first-visit")).toMatchObject({ status: "active", nextStepKey: "follow_up" });
    await drive(p.id, "after-first-visit", new Date(T0.getTime() + 3 * DAYS));
    expect(sentTo(p.id)).toEqual(["automation.first_visit_follow_up", "automation.first_visit_feedback"]);
  });

  it("A-7 an imported booking.attended (data.source = import) enrols nobody", async () => {
    const p = await makePerson(h.db);
    state.reachable.add(p.id);
    await event(p.id, "booking.attended", T0, { session_kind: "day", is_first_visit: true, source: "import" }, { type: "booking", id: randomUUID() });
    await tick(T0);
    expect(await enrolmentOf(p.id, "after-first-visit")).toBeNull();
    expect(await enrolmentOf(p.id, "review-request")).toBeNull();
  });
});

describe("package journeys", () => {
  const grantRef = (id: string) => ({ type: "credit_grant", id });

  it("package 90 % is not sent after a purchase of the same credit kind, and still sent after a purchase of another kind", async () => {
    const same = await makePerson(h.db);
    const other = await makePerson(h.db);
    // p90 is a marketing template in a transactional journey: reachability is checked per step (A-31).
    state.reachable.add(same.id).add(other.id);
    for (const p of [same, other]) {
      const g = await makeCreditGrant(h.db, { personId: p.id, creditKind: "day", source: "manual" });
      await event(p.id, "credits.threshold_reached", T0, { grant_id: g.id, credit_kind: "day", pct: 90, remaining_units: 1 }, grantRef(g.id));
    }
    // The purchase lands after the threshold event (higher id) and before the email is due.
    await event(same.id, "credits.granted", T0, { grant_id: randomUUID(), credit_kind: "day", units: 5, source: "purchase" });
    await event(other.id, "credits.granted", T0, { grant_id: randomUUID(), credit_kind: "night", units: 5, source: "purchase" });
    await evaluateJob.run(makeJobCtx(h.db, "automation.evaluate", { now: T0 }), {});
    expect(await enrolmentOf(same.id, "package-usage")).toMatchObject({ status: "exited", endReason: "exit_event:credits.granted" });
    expect(await enrolmentOf(other.id, "package-usage")).toMatchObject({ status: "active" });
    await h.db.execute(sql`delete from jobs`);
    const done = await drive(other.id, "package-usage", new Date(T0.getTime() + DAYS));
    expect(done.status).toBe("completed");
    expect(sentTo(same.id)).toEqual([]);
    expect(sentTo(other.id)).toEqual(["package-usage-90"]);
  });

  it("package-usage 80 % tags package_nearly_used and sends nothing", async () => {
    const p = await makePerson(h.db);
    const g = await makeCreditGrant(h.db, { personId: p.id, creditKind: "night", source: "manual" });
    await event(p.id, "credits.threshold_reached", T0, { grant_id: g.id, credit_kind: "night", pct: 80, remaining_units: 1 }, grantRef(g.id));
    await tick(T0);
    await drive(p.id, "package-usage", new Date(T0.getTime() + DAYS));
    const [tag] = await h.db.select({ id: tags.id }).from(tags).where(eq(tags.key, "package_nearly_used"));
    expect(await h.db.select().from(personTags).where(and(eq(personTags.personId, p.id), eq(personTags.tagId, tag!.id)))).toHaveLength(1);
    expect(sentTo(p.id)).toEqual([]);
  });

  it("package-expiry sends the voucher text for a euro grant and the package text for a day grant", async () => {
    const v = await makePerson(h.db);
    const d = await makePerson(h.db);
    const gv = await makeCreditGrant(h.db, { personId: v.id, creditKind: "euro", source: "manual", units: 5000 });
    const gd = await makeCreditGrant(h.db, { personId: d.id, creditKind: "day", source: "manual" });
    await event(v.id, "credits.expiry_approaching", T0, { grant_id: gv.id, credit_kind: "euro", days: 30, remaining_units: 5000 }, grantRef(gv.id));
    await event(d.id, "credits.expiry_approaching", T0, { grant_id: gd.id, credit_kind: "day", days: 7, remaining_units: 2 }, grantRef(gd.id));
    await tick(T0);
    await drive(v.id, "package-expiry", new Date(T0.getTime() + 2 * DAYS));
    await drive(d.id, "package-expiry", new Date(T0.getTime() + 2 * DAYS));
    expect(sentTo(v.id)).toEqual(["automation.voucher_expiry"]);
    expect(sentTo(d.id)).toEqual(["automation.package_expiry"]);
  });

  it("package-finished: the repurchase email is skipped when another grant of the kind exists", async () => {
    const p = await makePerson(h.db);
    const q = await makePerson(h.db);
    state.reachable.add(p.id).add(q.id);
    for (const person of [p, q]) {
      const g = await makeCreditGrant(h.db, { personId: person.id, creditKind: "day", source: "manual" });
      await event(person.id, "credits.grant_exhausted", T0, { grant_id: g.id, credit_kind: "day", source: "purchase", product_id: null }, grantRef(g.id));
    }
    await makeCreditGrant(h.db, { personId: p.id, creditKind: "day", source: "manual" });
    await tick(T0);
    const e = await drive(p.id, "package-finished", new Date(T0.getTime() + 4 * DAYS));
    expect((await outcomes(e.id)).find(([k]) => k === "repurchase")).toEqual(["repurchase", "skipped_condition"]);
    await drive(q.id, "package-finished", new Date(T0.getTime() + 4 * DAYS));
    expect(sentTo(p.id)).toEqual([]);
    expect(sentTo(q.id)).toEqual(["package-finished-repurchase"]);
  });
});

describe("inactivity, membership and review journeys", () => {
  it("inactivity is skipped with a future booking; d180 tags dormant", async () => {
    const busy = await makePerson(h.db, { statusOverride: "customer", statusOverrideReason: "test customer", statusOverrideAt: T0 });
    const gone = await makePerson(h.db, { statusOverride: "customer", statusOverrideReason: "test customer", statusOverrideAt: T0 });
    state.reachable.add(busy.id).add(gone.id);
    await f.makeBooking(h.db, { personId: busy.id, startsAt: new Date(T0.getTime() + 10 * DAYS), status: "confirmed" });
    await event(busy.id, "person.inactive_days", T0, { days: 30, anchor_at: T0.toISOString(), has_future_booking: true });
    await event(gone.id, "person.inactive_days", T0, { days: 180, anchor_at: T0.toISOString(), has_future_booking: false });
    await tick(T0);
    const b = await drive(busy.id, "inactivity", new Date(T0.getTime() + DAYS));
    expect((await outcomes(b.id)).find(([k]) => k === "d30")).toEqual(["d30", "skipped_condition"]);
    await drive(gone.id, "inactivity", new Date(T0.getTime() + DAYS));
    expect(sentTo(busy.id)).toEqual([]);
    expect(sentTo(gone.id)).toEqual(["inactivity-180"]);
    const [dormant] = await h.db.select({ id: tags.id }).from(tags).where(eq(tags.key, "dormant"));
    expect(await h.db.select().from(personTags).where(and(eq(personTags.personId, gone.id), eq(personTags.tagId, dormant!.id)))).toHaveLength(1);
  });

  it("A-12 inactivity skips a lead (audience customer and member)", async () => {
    const p = await makePerson(h.db);
    state.reachable.add(p.id);
    await event(p.id, "person.inactive_days", T0, { days: 60, anchor_at: T0.toISOString(), has_future_booking: false });
    await tick(T0);
    expect(await enrolmentOf(p.id, "inactivity")).toBeNull();
  });

  it("member-welcome starts on membership.started and sends the welcome", async () => {
    const p = await makePerson(h.db);
    const m = await makeMembership(h.db, { personId: p.id });
    await event(p.id, "membership.started", T0, { membership_id: m.id, product_id: m.productId, status: "active" }, { type: "membership", id: m.id });
    await tick(T0);
    expect(await enrolmentOf(p.id, "member-welcome")).toMatchObject({ status: "active", subjectKey: `membership:${m.id}`, nextStepKey: "first_booking" });
    expect(sentTo(p.id)).toEqual(["automation.member_welcome"]);
  });

  it("membership-renewal sends r7_ending when cancel_at is set, r7 otherwise", async () => {
    const ending = await makePerson(h.db);
    const renewing = await makePerson(h.db);
    const m1 = await makeMembership(h.db, { personId: ending.id, cancelAt: new Date(T0.getTime() + 7 * DAYS) });
    const m2 = await makeMembership(h.db, { personId: renewing.id });
    for (const [p, m] of [
      [ending, m1],
      [renewing, m2],
    ] as const) {
      await event(p.id, "membership.renewal_due", T0, { membership_id: m.id, days: 7, period_end_on: "2026-11-13", is_ending: p === ending, amount_cents: 4900 }, { type: "membership", id: m.id });
    }
    await tick(T0);
    await drive(ending.id, "membership-renewal", new Date(T0.getTime() + DAYS));
    await drive(renewing.id, "membership-renewal", new Date(T0.getTime() + DAYS));
    expect(sentTo(ending.id)).toEqual(["automation.membership_ending_7"]);
    expect(sentTo(renewing.id)).toEqual(["automation.membership_renewal_7"]);
  });

  it("review-request: never after a no-show, and once per 30 days across two bookings", async () => {
    const p = await makePerson(h.db);
    state.reachable.add(p.id);
    const one = await f.makeBooking(h.db, { personId: p.id, startsAt: new Date(T0.getTime() - 2 * HOURS), status: "attended" });
    await event(p.id, "booking.attended", T0, { session_kind: "day", is_first_visit: false }, { type: "booking", id: one.booking.id });
    await tick(T0);
    expect(await enrolmentOf(p.id, "review-request")).toMatchObject({ status: "active", subjectKey: `booking:${one.booking.id}`, nextStepKey: "ask" });
    // Staff correct the check-in to a no-show before the request is due (A-27 re-checks at send time).
    await h.db.update(bookings).set({ status: "no_show", attendedAt: null }).where(eq(bookings.id, one.booking.id));
    const e = await drive(p.id, "review-request", new Date(T0.getTime() + 2 * DAYS));
    expect((await outcomes(e.id)).find(([k]) => k === "ask")).toEqual(["ask", "skipped_condition"]);
    const two = await f.makeBooking(h.db, { personId: p.id, startsAt: new Date(T0.getTime() + 3 * DAYS), status: "attended" });
    const later = new Date(T0.getTime() + 3 * DAYS + 2 * HOURS);
    await event(p.id, "booking.attended", later, { session_kind: "day", is_first_visit: false }, { type: "booking", id: two.booking.id });
    await tick(later);
    expect(await enrolmentsOf(p.id, "review-request")).toHaveLength(1);
    expect(sentTo(p.id)).toEqual([]);
  });

  it("review-request exits on booking.no_show of the same booking", async () => {
    const p = await makePerson(h.db);
    state.reachable.add(p.id);
    const ref = { type: "booking", id: randomUUID() };
    await event(p.id, "booking.attended", T0, { session_kind: "night", is_first_visit: false }, ref);
    await tick(T0);
    await event(p.id, "booking.no_show", new Date(T0.getTime() + HOURS), { session_kind: "night" }, ref);
    await tick(new Date(T0.getTime() + HOURS));
    expect(await enrolmentOf(p.id, "review-request")).toMatchObject({ status: "exited", endReason: "exit_event:booking.no_show" });
  });
});

describe("booking R59 and R60 on the seeded rows", () => {
  it("no seeded definition has a confirm step and after-first-booking has no reminder step", async () => {
    const rows = await h.db
      .select({ slug: automations.slug, definition: automationVersions.definition })
      .from(automations)
      .innerJoin(automationVersions, eq(automationVersions.id, automations.currentVersionId));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const steps = (r.definition as { steps: { key: string; type: string; template?: string }[] }).steps;
      expect(steps.some((s) => /confirm/.test(s.key) || /confirm/.test(s.template ?? "")), r.slug).toBe(false);
      if (r.slug === "after-first-booking") expect(steps.some((s) => /reminder/.test(s.key) && s.key !== "intake_reminder")).toBe(false);
    }
  });
});

describe("waitlist-offer and reseed", () => {
  it("waitlist-offer exits on waitlist.confirmed of the same entry", async () => {
    const p = await makePerson(h.db);
    const ref = { type: "waitlist_entry", id: randomUUID() };
    await event(p.id, "waitlist.offered", T0, { offer_expires_at: new Date(T0.getTime() + 4 * HOURS).toISOString(), session_kind: "day" }, ref);
    await tick(T0);
    expect(await enrolmentOf(p.id, "waitlist-offer")).toMatchObject({ status: "active", nextStepKey: "expiring", nextStepAt: new Date(T0.getTime() + 210 * MIN) });
    await event(p.id, "waitlist.confirmed", new Date(T0.getTime() + HOURS), { session_kind: "day" }, ref);
    await tick(new Date(T0.getTime() + HOURS));
    expect(await enrolmentOf(p.id, "waitlist-offer")).toMatchObject({ status: "exited", endReason: "exit_event:waitlist.confirmed" });
    expect(sentTo(p.id)).toEqual([]);
  });

  it("the defaults seed left V1 journeys active and R2 journeys draft; reseed changes nothing", async () => {
    const snapshot = () => h.db.select({ slug: automations.slug, status: automations.status, updatedAt: automations.updatedAt, version: automations.currentVersionId }).from(automations).orderBy(asc(automations.slug));
    const rows = await snapshot();
    expect(rows.find((r) => r.slug === "abandoned-checkout")!.status).toBe("draft");
    expect(rows.find((r) => r.slug === "webinar-attended")!.status).toBe("draft");
    expect(rows.find((r) => r.slug === "event-registration")!.status).toBe("active");
    expect(await seedAutomation(h.db as unknown as Tx)).toEqual({ groups: 0, automations: 0, templates: 0 });
    expect(await seedDefaults(h.db)).toContain("automation");
    expect(await snapshot()).toEqual(rows);
  });
});
