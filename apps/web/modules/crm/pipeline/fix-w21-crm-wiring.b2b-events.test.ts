/**
 * fix-w21-crm-wiring (automation-P9 request): crm records the `opportunity.*` events with the
 * primary contact as the person, the opportunity as the ref and `owner_user_id` in the data, so
 * automation's seeded B2B journeys (decision 35) enrol the contact when staff move a stage.
 * End to end: the `defaults` seed, the R3 journeys activated, `moveStaffOpportunity`, then the real
 * `automation.evaluate` and `automation.step` jobs.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, automationEnrolments, automations, companies, jobs as jobsTable, opportunities, tasks } from "@beam/db/schema";
import { seedDefaults } from "@beam/db/seed";
import { activateReleaseSequences } from "@beam/db/seed/automation";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { b2bJourneySlug } from "@beam/core/automation/seeds";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");

vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/booking/api", async (orig) => ({ ...(await orig<object>()), nextOpeningAt: vi.fn(() => Promise.resolve(null)) }));

const { jobs } = await import("@/modules/automation/jobs");
const api = await import("./api");
const { and, asc, eq, setAppDb, sql } = await import("@/lib/ctx");
const { rowsOf } = await import("@/lib/sensitive");
const { makeCtx, makeJobCtx, resetRuntime, staffActor } = await import("@/lib/testing");

let h: DbHandle;
let ownerId: string;
let actor: ReturnType<typeof staffActor>;

// The events take the database clock (`occurred_at` defaults to now()) and automation ignores
// trigger events older than its max age, so the actions and the jobs run at the real now. No
// assertion depends on the day or the hour.
const T0 = new Date();

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await seedDefaults(h.db);
  await h.db.transaction((tx) => activateReleaseSequences(tx, "R3", { now: T0 }));
  ownerId = (await makeUser(h.db, { roleKey: "sales", name: "Olga Owner" })).id;
  actor = staffActor({ userId: ownerId, roleKey: "sales", permissions: ["persons.read", "crm.b2b"] });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await h.db.execute(sql`delete from jobs`);
  // Each test sees only its own events (the cursor starts after everything recorded so far).
  const max = rowsOf<{ m: string }>(await h.db.execute(sql`select coalesce(max(id), 0)::text as m from activity_events`))[0]!.m;
  await h.db.execute(sql`insert into settings (key, value) values ('automation_cursor', ${JSON.stringify({ last_event_id: max, gaps: [] })}::jsonb)
    on conflict (key) do update set value = excluded.value`);
});

const ctx = () => makeCtx(h.db, { actor, now: T0 });
const stepJob = jobs.find((j) => j.kind === "automation.step")!;
const evaluateJob = jobs.find((j) => j.kind === "automation.evaluate")!;

/** One `automation.evaluate` run, then every enqueued `automation.step` job. */
async function tick(now: Date): Promise<void> {
  await evaluateJob.run(makeJobCtx(h.db, "automation.evaluate", { now }), {});
  const pending = await h.db.select().from(jobsTable).where(and(eq(jobsTable.kind, "automation.step"), eq(jobsTable.status, "pending"))).orderBy(asc(jobsTable.createdAt));
  for (const job of pending) {
    await stepJob.run(makeJobCtx(h.db, "automation.step", { now, jobId: job.id }), stepJob.input.parse(job.payload));
    await h.db.delete(jobsTable).where(eq(jobsTable.id, job.id));
  }
}

async function newOpportunity(contactId: string | null) {
  const [c] = await h.db.insert(companies).values({ name: `Acme ${randomUUID().slice(0, 6)}` }).returning();
  const { opportunityId } = await api.saveStaffOpportunity(ctx(), {
    companyId: c!.id,
    title: "Team wellness days",
    valueCents: 1_200_000,
    ownerUserId: ownerId,
    primaryContactPersonId: contactId,
  });
  return (await h.db.select().from(opportunities).where(eq(opportunities.id, opportunityId)))[0]!;
}

async function moveTo(o: { id: string }, stages: Parameters<typeof api.moveStaffOpportunity>[1]["stage"][]) {
  for (const stage of stages) {
    const [row] = await h.db.select().from(opportunities).where(eq(opportunities.id, o.id));
    await api.moveStaffOpportunity(ctx(), { id: o.id, version: row!.version, stage });
  }
}

const eventsOf = (opportunityId: string) =>
  h.db
    .select({ kind: activityEvents.kind, personId: activityEvents.personId, companyId: activityEvents.companyId, refType: activityEvents.refType, refId: activityEvents.refId, data: activityEvents.data })
    .from(activityEvents)
    .where(and(eq(activityEvents.refType, "opportunity"), eq(activityEvents.refId, opportunityId)))
    .orderBy(asc(activityEvents.id));

const enrolmentsOf = async (personId: string, slug: string) =>
  (
    await h.db
      .select({ e: automationEnrolments })
      .from(automationEnrolments)
      .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
      .where(and(eq(automationEnrolments.personId, personId), eq(automations.slug, slug)))
  ).map((r) => r.e);

describe("opportunity events: the primary contact as the person, owner_user_id in the data", () => {
  it("every opportunity.* event of an opportunity with a contact names the contact, the company and the owner", async () => {
    const contact = await makePerson(h.db);
    const o = await newOpportunity(contact.id);
    await moveTo(o, ["response", "won"]);
    const list = await eventsOf(o.id);
    expect(list.map((e) => e.kind)).toEqual(["opportunity.created", "opportunity.stage_changed", "opportunity.stage_changed", "opportunity.won"]);
    for (const e of list) {
      expect(e, e.kind).toMatchObject({ personId: contact.id, companyId: o.companyId, refType: "opportunity", refId: o.id });
      expect(e.data, e.kind).toMatchObject({ opportunity_id: o.id, owner_user_id: ownerId });
    }
    expect(list[1]!.data).toMatchObject({ from_stage: "target", to_stage: "response", value_cents: 1_200_000 });
  });

  it("without a primary contact the events stay company events", async () => {
    const o = await newOpportunity(null);
    await moveTo(o, ["qualified"]);
    const list = await eventsOf(o.id);
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const e of list) expect(e, e.kind).toMatchObject({ personId: null, companyId: o.companyId, data: expect.objectContaining({ owner_user_id: ownerId }) });
  });
});

describe("automation's B2B journeys enrol the primary contact (decision 35)", () => {
  it("moving to qualified enrols the contact once per opportunity and creates the owner's discovery call task", async () => {
    const contact = await makePerson(h.db);
    const o = await newOpportunity(contact.id);
    await moveTo(o, ["response", "qualified"]);
    await tick(new Date());
    const [e, ...more] = await enrolmentsOf(contact.id, b2bJourneySlug("qualified"));
    expect(more).toEqual([]);
    expect(e).toMatchObject({ subjectKey: `opportunity:${o.id}` });
    const automationTasks = await h.db
      .select({ ownerUserId: tasks.ownerUserId, source: tasks.source })
      .from(tasks)
      .where(and(eq(tasks.personId, contact.id), eq(tasks.source, "automation")));
    expect(automationTasks).toEqual([{ ownerUserId: ownerId, source: "automation" }]);
  });

  it("an opportunity without a contact enrols nobody", async () => {
    const before = (await h.db.select({ id: automationEnrolments.id }).from(automationEnrolments)).length;
    const o = await newOpportunity(null);
    await moveTo(o, ["response", "qualified"]);
    await tick(new Date());
    expect((await h.db.select({ id: automationEnrolments.id }).from(automationEnrolments)).length).toBe(before);
  });
});
