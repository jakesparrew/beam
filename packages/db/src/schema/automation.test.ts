/**
 * automation schema (automation-P1): the three partial unique indexes, the check constraints and
 * the three views, on a fresh PGlite database built from the TypeScript schema.
 */
import { WEBHOOK_ALLOWED_FIELDS } from "@beam/core/automation";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../client";
import { createTestDb, makePerson, makeUser } from "../testing";
import { APPEND_ONLY_TABLES, SENSITIVE_COLUMNS } from "./_shared";
import {
  AUTOMATION_RUN_OUTCOMES,
  automationEnrolments,
  automationGroups,
  automationRuns,
  automations,
  automationVersions,
} from "./automation";
import { vAutomationDue, vAutomationStats, vPersonAutomationTimeline } from "./automation.views";
import { activityEvents, tasks } from "./crm";

async function pgError(promise: Promise<unknown>): Promise<{ message: string; code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause =
      (error as { cause?: { message?: string; code?: string; constraint?: string } }).cause ??
      (error as { message?: string; code?: string; constraint?: string });
    return { message: String(cause.message ?? error), code: cause.code, constraint: cause.constraint };
  }
  throw new Error("expected the query to fail");
}

async function rejectsCheck(promise: Promise<unknown>, constraint: string) {
  const err = await pgError(promise);
  expect(err.code, err.message).toBe("23514");
  expect(`${err.constraint ?? ""} ${err.message}`).toContain(constraint);
}

async function rejectsUnique(promise: Promise<unknown>, constraint: string) {
  const err = await pgError(promise);
  expect(err.code, err.message).toBe("23505");
  expect(`${err.constraint ?? ""} ${err.message}`).toContain(constraint);
}

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

const actor = { kind: "job" as const, id: null };
const DEF = { schema_version: 1, trigger: { manual: true }, anchor: "enrolment", re_entry: "always", exit_on: [], steps: [] };
let seq = 0;

async function makeGroup(over: Partial<typeof automationGroups.$inferInsert> = {}) {
  seq += 1;
  const [g] = await h.db
    .insert(automationGroups)
    .values({ key: `group_${seq}`, name: `Group ${seq}`, ...over })
    .returning();
  return g!;
}

/** An active automation with a published version. */
async function makeAutomation(over: { groupId?: string; status?: "draft" | "active" | "paused" | "archived"; isMarketing?: boolean } = {}) {
  seq += 1;
  const groupId = over.groupId ?? (await makeGroup()).id;
  const [a] = await h.db
    .insert(automations)
    .values({ slug: `journey-${seq}`, name: `Journey ${seq}`, groupId, isMarketing: over.isMarketing ?? false })
    .returning();
  const [v] = await h.db
    .insert(automationVersions)
    .values({ automationId: a!.id, version: 1, definition: DEF, definitionHash: `hash-${seq}` })
    .returning();
  const status = over.status ?? "active";
  await h.db
    .update(automations)
    .set({ currentVersionId: v!.id, status, pausedAt: status === "paused" ? new Date() : null })
    .where(eq(automations.id, a!.id));
  return { automation: a!, version: v! };
}

async function makeEvent(personId: string, kind = "booking.confirmed") {
  const [ev] = await h.db.insert(activityEvents).values({ personId, kind, actor: { kind: "system", id: null }, data: {} }).returning();
  return ev!;
}

function enrolment(a: { automation: typeof automations.$inferSelect; version: typeof automationVersions.$inferSelect }, personId: string, over: Partial<typeof automationEnrolments.$inferInsert> = {}) {
  return {
    automationId: a.automation.id,
    automationVersionId: a.version.id,
    personId,
    groupId: a.automation.groupId,
    source: "trigger" as const,
    ...over,
  };
}

describe("automation enums and markings", () => {
  it("has the 23 run outcomes of section 2.1", () => {
    expect(AUTOMATION_RUN_OUTCOMES).toHaveLength(23);
  });

  it("lists both append-only tables in the frozen APPEND_ONLY_TABLES", () => {
    expect(APPEND_ONLY_TABLES).toEqual(expect.arrayContaining(["automation_runs", "automation_versions"]));
  });

  it("WEBHOOK_ALLOWED_FIELDS holds no sensitive column, email or phone (section 6)", () => {
    const sensitive = new Set(SENSITIVE_COLUMNS.map((c) => c.column));
    for (const f of WEBHOOK_ALLOWED_FIELDS) {
      expect(sensitive.has(f)).toBe(false);
      expect(f).not.toMatch(/email|phone/);
    }
  });
});

describe("automation_groups and automations checks", () => {
  it("rejects a bad group key, lane and priority", async () => {
    await rejectsCheck(h.db.insert(automationGroups).values({ key: "Bad-Key", name: "x" }), "automation_groups_key_ck");
    await rejectsCheck(h.db.insert(automationGroups).values({ key: "lane_bad", name: "x", lane: "Sales" }), "automation_groups_lane_ck");
    await rejectsCheck(h.db.insert(automationGroups).values({ key: "prio_bad", name: "x", priority: 1001 }), "automation_groups_priority_ck");
  });

  it("refuses active without a version, marketing without a purpose and a paused flag mismatch", async () => {
    const g = await makeGroup();
    await rejectsCheck(h.db.insert(automations).values({ slug: "no-version", name: "x", groupId: g.id, isMarketing: false, status: "active" }), "automations_version_ck");
    await rejectsCheck(h.db.insert(automations).values({ slug: "no-purpose", name: "x", groupId: g.id, isMarketing: true }), "automations_purpose_ck");
    await rejectsCheck(
      h.db.insert(automations).values({ slug: "paused-at", name: "x", groupId: g.id, isMarketing: false, pausedAt: new Date() }),
      "automations_paused_ck",
    );
    await rejectsCheck(h.db.insert(automations).values({ slug: "Bad Slug", name: "x", groupId: g.id, isMarketing: false }), "automations_slug_ck");
    await rejectsCheck(
      h.db.insert(automations).values({ slug: "prio", name: "x", groupId: g.id, isMarketing: false, priority: -1 }),
      "automations_priority_ck",
    );
    await rejectsCheck(
      h.db.insert(automations).values({ slug: "flag", name: "x", groupId: g.id, isMarketing: false, requiresFlag: "checkout" }),
      "automations_requires_flag_ck",
    );
  });

  it("refuses version 0 and a duplicate version number", async () => {
    const a = await makeAutomation();
    await rejectsCheck(
      h.db.insert(automationVersions).values({ automationId: a.automation.id, version: 0, definition: DEF, definitionHash: "h" }),
      "automation_versions_version_ck",
    );
    await rejectsUnique(
      h.db.insert(automationVersions).values({ automationId: a.automation.id, version: 1, definition: DEF, definitionHash: "h" }),
      "automation_versions_automation_version_uq",
    );
  });
});

describe("automation_enrolments", () => {
  it("uq_enrolment_active: one active enrolment per automation, person and subject", async () => {
    const a = await makeAutomation();
    const p = await makePerson(h.db);
    await h.db.insert(automationEnrolments).values(enrolment(a, p.id, { subjectKey: "booking:1" }));
    await h.db.insert(automationEnrolments).values(enrolment(a, p.id, { subjectKey: "booking:2" }));
    await rejectsUnique(h.db.insert(automationEnrolments).values(enrolment(a, p.id, { subjectKey: "booking:1" })), "uq_enrolment_active");
    // An ended enrolment does not block a new one.
    await h.db.insert(automationEnrolments).values(
      enrolment(a, p.id, { subjectKey: "booking:1", status: "completed", endedAt: new Date(), endReason: "completed" }),
    );
  });

  it("uq_enrolment_domain: two concurrent inserts into one exclusive domain, one fails", async () => {
    const g1 = await makeGroup({ isExclusive: true, lane: "sales_journey", priority: 10 });
    const g2 = await makeGroup({ isExclusive: true, lane: "sales_journey", priority: 30 });
    const a1 = await makeAutomation({ groupId: g1.id });
    const a2 = await makeAutomation({ groupId: g2.id });
    const p = await makePerson(h.db);
    const results = await Promise.allSettled([
      h.db.insert(automationEnrolments).values(enrolment(a1, p.id, { exclusiveDomain: "sales_journey" })),
      h.db.insert(automationEnrolments).values(enrolment(a2, p.id, { exclusiveDomain: "sales_journey" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    const cause = (failed.reason as { cause?: { constraint?: string; message?: string } }).cause;
    expect(`${cause?.constraint ?? ""} ${cause?.message ?? String(failed.reason)}`).toContain("uq_enrolment_domain");
    // Null domains (non-exclusive groups) never collide.
    await h.db.insert(automationEnrolments).values(enrolment(await makeAutomation(), p.id));
    await h.db.insert(automationEnrolments).values(enrolment(await makeAutomation(), p.id));
  });

  it("uq_enrolment_trigger: re-reading an event never enrols twice", async () => {
    const a = await makeAutomation();
    const p = await makePerson(h.db);
    const ev = await makeEvent(p.id);
    await h.db.insert(automationEnrolments).values(
      enrolment(a, p.id, { triggerEventId: ev.id, status: "completed", endedAt: new Date(), endReason: "completed" }),
    );
    await rejectsUnique(h.db.insert(automationEnrolments).values(enrolment(a, p.id, { triggerEventId: ev.id })), "uq_enrolment_trigger");
    // Staff rows without a trigger event are never blocked.
    await h.db.insert(automationEnrolments).values(enrolment(a, p.id, { source: "staff", subjectKey: "booking:9" }));
  });

  it("enforces the status, next step and end reason checks", async () => {
    const a = await makeAutomation();
    const p = await makePerson(h.db);
    await rejectsCheck(h.db.insert(automationEnrolments).values(enrolment(a, p.id, { endedAt: new Date() })), "automation_enrolments_ended_ck");
    await rejectsCheck(
      h.db.insert(automationEnrolments).values(enrolment(a, p.id, { status: "completed", endReason: "completed" })),
      "automation_enrolments_ended_ck",
    );
    await rejectsCheck(
      h.db
        .insert(automationEnrolments)
        .values(enrolment(a, p.id, { status: "completed", endedAt: new Date(), endReason: "completed", nextStepAt: new Date() })),
      "automation_enrolments_next_step_ck",
    );
    await rejectsCheck(
      h.db.insert(automationEnrolments).values(enrolment(a, p.id, { status: "exited", endedAt: new Date() })),
      "automation_enrolments_end_reason_ck",
    );
    await rejectsCheck(h.db.insert(automationEnrolments).values(enrolment(a, p.id, { subjectKey: "nocolon" })), "automation_enrolments_subject_key_ck");
  });
});

describe("automation_runs", () => {
  it("dedupe_key is unique and enrolment_id may be null for entry decisions", async () => {
    const a = await makeAutomation();
    const p = await makePerson(h.db);
    const row = { personId: p.id, automationId: a.automation.id, outcome: "skipped_exclusive" as const, actor, dedupeKey: `entry:${a.automation.id}:1` };
    await h.db.insert(automationRuns).values(row);
    await rejectsUnique(h.db.insert(automationRuns).values(row), "automation_runs_dedupe_key_unique");
  });

  it("is append-only on the schema-built database too (triggers from postSchemaSql)", async () => {
    const a = await makeAutomation();
    const p = await makePerson(h.db);
    const [run] = await h.db.insert(automationRuns).values({ personId: p.id, automationId: a.automation.id, outcome: "entered", actor }).returning();
    const err = await pgError(h.db.update(automationRuns).set({ reason: "x" }).where(eq(automationRuns.id, run!.id)));
    expect(err.code).toBe("55000");
  });

  it("task_id references tasks; deleting the task nulls it under beam.allow_rewrite only (fix-w05-schema-1)", async () => {
    const a = await makeAutomation();
    const p = await makePerson(h.db);
    const owner = await makeUser(h.db);
    const run = { personId: p.id, automationId: a.automation.id, outcome: "entered" as const, actor };
    const unknown = await pgError(h.db.insert(automationRuns).values({ ...run, taskId: crypto.randomUUID() }));
    expect(unknown.code).toBe("23503");
    expect(`${unknown.constraint ?? ""} ${unknown.message}`).toContain("automation_runs_task_id_tasks_id_fk");

    const [task] = await h.db
      .insert(tasks)
      .values({ ownerUserId: owner.id, personId: p.id, title: "Call back", kind: "call", source: "automation", createdBy: actor })
      .returning();
    const [row] = await h.db.insert(automationRuns).values({ ...run, taskId: task!.id }).returning();
    // The set-null action is an UPDATE of an append-only fact: refused outside erasure/retention.
    expect((await pgError(h.db.delete(tasks).where(eq(tasks.id, task!.id)))).code).toBe("55000");
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
      await tx.delete(tasks).where(eq(tasks.id, task!.id));
    });
    const [after] = await h.db.select().from(automationRuns).where(eq(automationRuns.id, row!.id));
    expect(after!.taskId).toBeNull();
  });
});

describe("automation views", () => {
  it("v_automation_stats, v_automation_due and v_person_automation_timeline return rows", async () => {
    const user = await makeUser(h.db);
    const a = await makeAutomation();
    const paused = await makeAutomation({ status: "paused" });
    const p = await makePerson(h.db);
    const past = new Date(Date.now() - 60_000);
    const [en] = await h.db
      .insert(automationEnrolments)
      .values(enrolment(a, p.id, { nextStepKey: "welcome", nextStepAt: past, source: "staff", enteredByUserId: user.id }))
      .returning();
    await h.db.insert(automationEnrolments).values(enrolment(paused, p.id, { nextStepKey: "welcome", nextStepAt: past }));
    await h.db.insert(automationRuns).values([
      { enrolmentId: en!.id, personId: p.id, automationId: a.automation.id, outcome: "entered", actor },
      { enrolmentId: en!.id, personId: p.id, automationId: a.automation.id, stepKey: "welcome", outcome: "sent", actor },
      { enrolmentId: en!.id, personId: p.id, automationId: a.automation.id, stepKey: "edu", outcome: "skipped_condition", actor },
      { enrolmentId: en!.id, personId: p.id, automationId: a.automation.id, stepKey: "edu2", outcome: "failed", actor },
    ]);

    const [stats] = await h.db.select().from(vAutomationStats).where(eq(vAutomationStats.automationId, a.automation.id));
    expect(stats).toMatchObject({ slug: a.automation.slug, status: "active", activeCount: 1, entered7d: 1, sent7d: 1, skipped7d: 1, failed7d: 1 });
    expect(stats!.lastRunAt).toBeInstanceOf(Date);

    const due = await h.db.select().from(vAutomationDue).where(eq(vAutomationDue.personId, p.id));
    expect(due.map((d) => d.enrolmentId)).toEqual([en!.id]);

    const timeline = await h.db.select().from(vPersonAutomationTimeline).where(eq(vPersonAutomationTimeline.personId, p.id));
    expect(timeline).toHaveLength(4);
    expect(timeline[0]).toMatchObject({ automationSlug: a.automation.slug, automationName: a.automation.name, emailStatus: null });

    const empty = await h.db.execute(sql`select count(*)::int as n from v_automation_stats where active_count = 0`);
    expect((empty as { rows: { n: number }[] }).rows[0]!.n).toBeGreaterThan(0);
  });
});
