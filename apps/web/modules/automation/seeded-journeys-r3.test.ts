/**
 * The R3 B2B follow-up task journeys (automation-P9, spec 1 and 12, decision 35) end to end: the
 * `defaults` seed on a fresh database, `activateReleaseSequences(tx, 'R3')`, then crm's
 * `opportunity.stage_changed` events through `automation.evaluate` and the `automation.step` job.
 *
 * The events are written the way crm records a stage change for an opportunity with a primary
 * contact: the contact as the person, the opportunity as the ref, and `from_stage`, `to_stage`
 * and `owner_user_id` in the data (spec 8, the event list). crm tasks are real; booking's
 * `nextOpeningAt` is mocked to "no move" so the due dates are the journeys' own deadlines.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { automationEnrolments, automations, automationVersions, jobs as jobsTable, tasks, users } from "@beam/db/schema";
import { seedDefaults } from "@beam/db/seed";
import { activateReleaseSequences } from "@beam/db/seed/automation";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { parseDefinition, type Definition } from "@beam/core/automation";
import { B2B_JOURNEY_STAGES, b2bJourneySlug, SEED_AUTOMATIONS, seedsOfRelease } from "@beam/core/automation/seeds";
import { and, asc, eq, sql } from "@/lib/ctx";
import { makeJobCtx, resetRuntime } from "@/lib/testing";

vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/booking/api", async (orig) => ({ ...(await orig<object>()), nextOpeningAt: vi.fn(() => Promise.resolve(null)) }));

// The engine first, so its imports resolve to the mocks (see step.test.ts).
const { jobs } = await import("./jobs");
const f = await import("./engine/automation-p3.fixtures");
const { setAppDb } = await import("@/lib/ctx");

let h: DbHandle;
let ownerId: string;
let salesId: string;

const MIN = 60_000;
const HOURS = 60 * MIN;
const DAYS = 24 * HOURS;
const T0 = new Date("2026-11-10T09:00:00Z"); // Tuesday 10:00 Brussels
const at = (ms: number) => new Date(T0.getTime() + ms);

const R3 = seedsOfRelease("R3");
const B2B_SLUGS = B2B_JOURNEY_STAGES.map(b2bJourneySlug);
const activate = () => h.db.transaction((tx) => activateReleaseSequences(tx, "R3", { now: T0 }));

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  expect(await seedDefaults(h.db)).toContain("automation");
  // The opportunity owner is not in the sales role, so "owner" and "sales role" are told apart.
  ownerId = (await makeUser(h.db, { roleKey: "management", name: "Olga Owner" })).id;
  salesId = (await makeUser(h.db, { roleKey: "sales", name: "Sam Sales" })).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
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

async function slugsOf(personId: string): Promise<string[]> {
  const rows = await h.db
    .select({ slug: automations.slug })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .where(eq(automationEnrolments.personId, personId));
  return [...new Set(rows.map((r) => r.slug))].sort();
}

/** Runs one enrolment step by step until it ends or its next step is after `until`. */
async function drive(enrolmentId: string, until: Date) {
  for (let i = 0; i < 20; i++) {
    const e = await f.enrolmentRow(h.db, enrolmentId);
    if (!e) throw new Error(`no enrolment ${enrolmentId}`);
    if (e.status !== "active" || !e.nextStepAt || e.nextStepAt > until) return e;
    await tick(e.nextStepAt);
  }
  throw new Error(`${enrolmentId}: did not settle`);
}

const outcomes = async (enrolmentId: string) => (await f.stepOutcomes(h.db, enrolmentId)).sort((x, y) => (x[0] ?? "").localeCompare(y[0] ?? "") || x[1].localeCompare(y[1]));

async function tasksOf(personId: string) {
  return h.db
    .select({ title: tasks.title, kind: tasks.kind, status: tasks.status, source: tasks.source, ownerUserId: tasks.ownerUserId, dueAt: tasks.dueAt })
    .from(tasks)
    .where(eq(tasks.personId, personId))
    .orderBy(asc(tasks.createdAt));
}

/** An opportunity with a primary contact, and the stage changes crm records for it. */
async function opportunity(o: { owner?: string | null } = {}) {
  const contact = await makePerson(h.db);
  const id = randomUUID();
  const owner = o.owner === undefined ? ownerId : o.owner;
  return {
    id,
    contact,
    move: (from: string, to: string, when: Date) =>
      f.makeEvent(h.db, {
        personId: contact.id,
        kind: "opportunity.stage_changed",
        occurredAt: when,
        refType: "opportunity",
        refId: id,
        data: { opportunity_id: id, from_stage: from, to_stage: to, value_cents: 1_200_000, ...(owner ? { owner_user_id: owner } : {}) },
      }),
  };
}

// ---------------------------------------------------------------------------
// The seeded definitions
// ---------------------------------------------------------------------------

describe("B2B journeys: definitions (decision 35)", () => {
  it("the R3 seeds are the B2B journeys, task-only drafts in the non-exclusive sales group", () => {
    expect(R3.map((s) => s.slug).sort()).toEqual([...B2B_SLUGS].sort());
    for (const s of R3) {
      expect(s, s.slug).toMatchObject({ status: "draft", groupKey: "sales", isMarketing: false, purpose: null, requiresDpia: null, requiresFlag: null, templates: [] });
      expect(parseDefinition(s.definition), s.slug).toMatchObject({ ok: true });
      expect(s.definition.trigger, s.slug).toMatchObject({ event: "opportunity.stage_changed" });
    }
  });

  it("no email step exists in any B2B journey, neither in the seed nor in the published version", async () => {
    const allowed = new Set(["task", "notify_slack", "wait", "condition"]);
    for (const s of SEED_AUTOMATIONS.filter((x) => x.slug.startsWith("b2b-"))) {
      for (const st of s.definition.steps) expect(allowed.has(st.type), `${s.slug}.${st.key}`).toBe(true);
    }
    const published = await h.db
      .select({ slug: automations.slug, definition: automationVersions.definition })
      .from(automations)
      .innerJoin(automationVersions, eq(automationVersions.id, automations.currentVersionId));
    const b2b = published.filter((r) => B2B_SLUGS.includes(r.slug));
    expect(b2b.map((r) => r.slug).sort()).toEqual([...B2B_SLUGS].sort());
    for (const r of b2b) expect((r.definition as Definition).steps.filter((st) => st.type === "email"), r.slug).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Activation (decision 30): runs first; every later suite needs the active journeys.
// ---------------------------------------------------------------------------

describe("activateReleaseSequences(tx, 'R3')", () => {
  it("enrols nobody while the B2B journeys are still drafts", async () => {
    const o = await opportunity();
    await o.move("response", "qualified", T0);
    await tick(T0);
    expect(await slugsOf(o.contact.id)).toEqual([]);
  });

  it("activates the three B2B drafts, leaves the R2 drafts alone, and is idempotent", async () => {
    const r2Drafts = (await h.db.select({ slug: automations.slug }).from(automations).where(eq(automations.status, "draft"))).map((r) => r.slug).filter((s) => !B2B_SLUGS.includes(s));
    const first = await activate();
    expect(first.activated.sort()).toEqual([...B2B_SLUGS].sort());
    expect(first.blocked).toEqual([]);
    expect(await activate()).toEqual({ activated: [], blocked: [] });
    for (const slug of B2B_SLUGS) {
      const [a] = await h.db.select().from(automations).where(eq(automations.slug, slug));
      expect(a, slug).toMatchObject({ status: "active", activatedAt: T0 });
    }
    for (const slug of r2Drafts) {
      const [a] = await h.db.select({ status: automations.status }).from(automations).where(eq(automations.slug, slug));
      expect(a!.status, slug).toBe("draft");
    }
  });
});

// ---------------------------------------------------------------------------
// The stage journeys
// ---------------------------------------------------------------------------

describe("B2B follow-up tasks on opportunity.stage_changed", () => {
  it("qualified creates the discovery call task for the opportunity owner, due in 2 days", async () => {
    const o = await opportunity();
    await o.move("response", "qualified", T0);
    await tick(T0);
    expect(await tasksOf(o.contact.id)).toEqual([
      { title: "Plan een discovery call", kind: "call", status: "open", source: "automation", ownerUserId: ownerId, dueAt: at(2 * DAYS) },
    ]);
    const [e] = await enrolmentsOf(o.contact.id, b2bJourneySlug("qualified"));
    expect(e).toMatchObject({ status: "completed", subjectKey: `opportunity:${o.id}` });
  });

  it("without an owner, or with an owner who is no longer active staff, the task goes to the sales role", async () => {
    const ownerless = await opportunity({ owner: null });
    const formerId = (await makeUser(h.db, { roleKey: "management", name: "Fred Former" })).id;
    await h.db.update(users).set({ status: "disabled" }).where(eq(users.id, formerId));
    const former = await opportunity({ owner: formerId });
    await ownerless.move("response", "qualified", T0);
    await former.move("discovery", "won", T0);
    await tick(T0);
    expect((await tasksOf(ownerless.contact.id)).map((t) => [t.title, t.ownerUserId])).toEqual([["Plan een discovery call", salesId]]);
    expect((await tasksOf(former.contact.id)).map((t) => [t.title, t.ownerUserId])).toEqual([["Start het accountbeheer: plan een kick-off met de klant", salesId]]);
  });

  it("won creates the account-management task for the owner, due in 7 days", async () => {
    const o = await opportunity();
    await o.move("negotiation", "won", T0);
    await tick(T0);
    expect(await tasksOf(o.contact.id)).toEqual([
      { title: "Start het accountbeheer: plan een kick-off met de klant", kind: "follow_up", status: "open", source: "automation", ownerUserId: ownerId, dueAt: at(7 * DAYS) },
    ]);
  });

  it("proposal creates the follow-up task 5 days later and escalates to Slack after 10 days only while the task is open", async () => {
    const open = await opportunity();
    const done = await opportunity({ owner: null });
    await open.move("discovery", "proposal", T0);
    await done.move("discovery", "proposal", T0);
    await tick(T0);
    expect(await tasksOf(open.contact.id)).toEqual([]);
    const [eOpen] = await enrolmentsOf(open.contact.id, b2bJourneySlug("proposal"));
    const [eDone] = await enrolmentsOf(done.contact.id, b2bJourneySlug("proposal"));
    await drive(eOpen!.id, at(5 * DAYS));
    await drive(eDone!.id, at(5 * DAYS));
    expect(await tasksOf(open.contact.id)).toEqual([
      { title: "Volg het voorstel op", kind: "follow_up", status: "open", source: "automation", ownerUserId: ownerId, dueAt: at(7 * DAYS) },
    ]);
    expect((await tasksOf(done.contact.id)).map((t) => t.ownerUserId)).toEqual([salesId]);
    await h.db.update(tasks).set({ status: "done", doneAt: at(6 * DAYS) }).where(eq(tasks.personId, done.contact.id));

    expect(await drive(eOpen!.id, at(11 * DAYS))).toMatchObject({ status: "completed" });
    expect(await drive(eDone!.id, at(11 * DAYS))).toMatchObject({ status: "completed" });
    expect(await outcomes(eOpen!.id)).toEqual([
      [null, "completed"],
      ["escalate", "notified"],
      ["follow_up", "task_created"],
    ]);
    expect(await outcomes(eDone!.id)).toEqual([
      [null, "completed"],
      ["escalate", "skipped_condition"],
      ["follow_up", "task_created"],
    ]);
  });

  it("an opportunity that leaves proposal before 5 days gets no follow-up task and no escalation", async () => {
    const o = await opportunity();
    await o.move("discovery", "proposal", T0);
    await tick(T0);
    await o.move("proposal", "negotiation", at(3 * DAYS));
    await tick(at(3 * DAYS));
    const [e] = await enrolmentsOf(o.contact.id, b2bJourneySlug("proposal"));
    expect(e).toMatchObject({ status: "exited", endReason: "exit_event:opportunity.stage_changed" });
    expect(await tasksOf(o.contact.id)).toEqual([]);
  });

  it("another opportunity's stage change never ends the journey (same subject only)", async () => {
    const o = await opportunity();
    await o.move("discovery", "proposal", T0);
    await tick(T0);
    // The same contact on a second opportunity, which leaves proposal.
    await f.makeEvent(h.db, {
      personId: o.contact.id,
      kind: "opportunity.stage_changed",
      occurredAt: at(DAYS),
      refType: "opportunity",
      refId: randomUUID(),
      data: { from_stage: "proposal", to_stage: "lost", owner_user_id: ownerId },
    });
    await tick(at(DAYS));
    const [e] = await enrolmentsOf(o.contact.id, b2bJourneySlug("proposal"));
    expect(e).toMatchObject({ status: "active", nextStepKey: "follow_up" });
  });

  it("a contact of two opportunities gets a journey per opportunity; a stage without a journey enrols nothing", async () => {
    const a = await opportunity();
    const contact = a.contact.id;
    const otherId = randomUUID();
    await a.move("response", "qualified", T0);
    await f.makeEvent(h.db, {
      personId: contact,
      kind: "opportunity.stage_changed",
      occurredAt: T0,
      refType: "opportunity",
      refId: otherId,
      data: { opportunity_id: otherId, from_stage: "response", to_stage: "qualified", owner_user_id: ownerId },
    });
    const idle = await opportunity();
    await idle.move("qualified", "discovery", T0);
    await idle.move("discovery", "negotiation", T0);
    await tick(T0);
    const list = await enrolmentsOf(contact, b2bJourneySlug("qualified"));
    expect(list.map((e) => e.subjectKey).sort()).toEqual([`opportunity:${a.id}`, `opportunity:${otherId}`].sort());
    expect((await tasksOf(contact)).map((t) => t.title)).toEqual(["Plan een discovery call", "Plan een discovery call"]);
    expect(await slugsOf(idle.contact.id)).toEqual([]);
  });
});
