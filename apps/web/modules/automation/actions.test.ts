/**
 * automation-P5 staff actions (automation spec 4.1, A-2, A-3, A-5, A-5a, A-29, A-40). Publishing
 * increments the version and refuses an unchanged hash; a missing locale blocks the publish;
 * every allowed status move works and every refused move is `conflict`; a `requires_dpia`
 * automation cannot be activated or resumed until the (mocked) ops decision approves its key;
 * resume, archive, migrate and segment enrolment enqueue their bulk jobs; every action writes one
 * audit row. Email's `getPublishedTemplateInfo` and ops' `isDpiaApproved` are mocked to the
 * shapes their contracts promise (CONVENTIONS 11).
 *
 * automation-P7 (R2): `upsertGroup` creates and edits groups with one audit row each and refuses
 * a taken or changed key; `updateAutomationRules` saves caps with `automations.publish`, a stale
 * `expectedVersion` is `conflict` and a webhook host change without `settings.write` is
 * `forbidden`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, automationEnrolments, automationGroups, automations, automationVersions, jobs, roles, segmentMembers, segments, settings, tags } from "@beam/db/schema";
import type { Definition } from "@beam/core/automation";
import type * as EmailApi from "@/modules/email/api";
import type * as OpsApi from "@/modules/ops/api";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.51" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const fx = vi.hoisted(() => ({
  approved: new Set<string>(),
  templates: new Map<string, { templateVersionId: string; kind: "transactional" | "marketing"; purpose: string | null; locales: string[] }>(),
}));
vi.mock("@/modules/ops/api", async (orig) => ({
  ...(await orig<typeof OpsApi>()),
  isDpiaApproved: (_db: unknown, key: string) => Promise.resolve(fx.approved.has(key)),
}));
vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  getPublishedTemplateInfo: (_db: unknown, slugs: string[]) => Promise.resolve(new Map([...fx.templates].filter(([s]) => slugs.includes(s)))),
}));

const actions = await import("./actions");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { makeAutomation, makeGroup } = await import("./engine/automation-p2.fixtures");

let handle: DbHandle;
let userId: string;
const ALL = ["nl-BE", "fr-BE", "en"];

type Result = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; fields?: Record<string, string> } };
function ok<T>(r: Result): T {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  return (r as { ok: true; data: T }).data;
}
function err(r: Result, code: string): { code: string; message: string; fields?: Record<string, string> } {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: false, error: { code } });
  return (r as { ok: false; error: { code: string; message: string } }).error;
}

const emailDef = (template: string, minutes = 0): Definition => ({
  schema_version: 1,
  trigger: { event: "booking.confirmed" },
  anchor: "enrolment",
  re_entry: "never",
  exit_on: [],
  steps: [{ key: "welcome", type: "email", template, at: { from: "enrolment", minutes } }],
});

async function audits(action: string, entityId: string) {
  return handle.db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));
}
async function jobsOf(kind: string) {
  return handle.db.select().from(jobs).where(eq(jobs.kind, kind));
}
async function automationRow(id: string) {
  const [a] = await handle.db.select().from(automations).where(eq(automations.id, id));
  return a!;
}

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  const user = await makeUser(handle.db, { roleKey: "marketing" });
  userId = user.id;
  await handle.db.update(roles).set({ permissions: ["automations.write", "automations.publish", "reports.read"] }).where(eq(roles.key, "marketing"));
  await handle.db.insert(tags).values({ key: "engaged", name: { en: "Engaged", "nl-BE": "Betrokken", "fr-BE": "Engagé" } }).onConflictDoNothing();
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  jar.clear();
  fx.approved.clear();
  fx.templates.clear();
  fx.templates.set("welcome-mail", { templateVersionId: crypto.randomUUID(), kind: "marketing", purpose: "newsletter", locales: ALL });
  fx.templates.set("half-mail", { templateVersionId: crypto.randomUUID(), kind: "marketing", purpose: "newsletter", locales: ["nl-BE", "en"] });
  const { token } = await createAuthSession(handle.db, { userId, audience: "staff", roleKey: "marketing", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
});

describe("createAutomation and saveDraft", () => {
  it("creates a draft with one email step at +0 and one automation.create audit row", async () => {
    const group = await makeGroup(handle.db);
    const { id } = ok<{ id: string }>(await actions.createAutomation({ slug: "p5-new", name: "P5 new", groupKey: group.key, isMarketing: true, purpose: "newsletter" }));
    const a = await automationRow(id);
    expect(a).toMatchObject({ status: "draft", currentVersionId: null, purpose: "newsletter", createdByUserId: userId });
    expect((a.draftDefinition as Definition).steps).toEqual([expect.objectContaining({ type: "email", at: { from: "enrolment", minutes: 0 } })]);
    expect(await audits("automation.create", id)).toHaveLength(1);
    expect(await audits("automation.save_draft", id)).toHaveLength(0);
  });

  it("refuses a marketing automation without purpose (validation) and a taken slug (conflict)", async () => {
    const group = await makeGroup(handle.db);
    err(await actions.createAutomation({ slug: "p5-nopurpose", name: "x", groupKey: group.key, isMarketing: true }), "validation");
    ok(await actions.createAutomation({ slug: "p5-taken", name: "x", groupKey: group.key, isMarketing: false }));
    err(await actions.createAutomation({ slug: "p5-taken", name: "y", groupKey: group.key, isMarketing: false }), "conflict");
  });

  it("a duplicate copies the source definition and its DPIA and flag gates", async () => {
    const src = await makeAutomation(handle.db, { definition: emailDef("welcome-mail"), requiresDpia: "watch_time_profiling", requiresFlag: "ff_commerce_checkout_recovery", status: "archived" });
    const group = await makeGroup(handle.db);
    const { id } = ok<{ id: string }>(await actions.createAutomation({ slug: "p5-dup", name: "Dup", groupKey: group.key, isMarketing: true, purpose: "newsletter", duplicateOfId: src.id }));
    const a = await automationRow(id);
    expect(a).toMatchObject({ requiresDpia: "watch_time_profiling", requiresFlag: "ff_commerce_checkout_recovery", status: "draft" });
    expect(a.draftDefinition).toEqual(emailDef("welcome-mail"));
  });

  it("saveDraft stores the draft even with issues, returns them and audits automation.update_draft once", async () => {
    const a = await makeAutomation(handle.db, { definition: emailDef("welcome-mail") });
    const r = ok<{ issues: { code: string }[] }>(await actions.saveDraft({ automationId: a.id, definition: emailDef("missing-mail"), name: "Renamed" }));
    expect(r.issues.map((i) => i.code)).toContain("template_unavailable");
    const row = await automationRow(a.id);
    expect(row).toMatchObject({ name: "Renamed", draftDefinition: emailDef("missing-mail"), draftUpdatedByUserId: userId });
    const audit = await audits("automation.update_draft", a.id);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.newValue)).not.toContain("missing-mail");
    const junk = ok<{ issues: { code: string }[] }>(await actions.saveDraft({ automationId: a.id, definition: { steps: "nope" } }));
    expect(junk.issues.length).toBeGreaterThan(0);
  });
});

describe("publishVersion (A-2, A-3, A-40)", () => {
  it("publishes version max+1, sets current_version_id and refuses an unchanged hash", async () => {
    const a = await makeAutomation(handle.db, { definition: emailDef("welcome-mail") });
    ok(await actions.saveDraft({ automationId: a.id, definition: emailDef("welcome-mail", 60) }));
    const v2 = ok<{ versionId: string; version: number; migrationJobId?: string }>(await actions.publishVersion({ automationId: a.id, changeNote: "One hour later", migrateActive: false }));
    expect(v2.version).toBe(2);
    expect(v2.migrationJobId).toBeUndefined();
    expect((await automationRow(a.id)).currentVersionId).toBe(v2.versionId);
    const [row] = await handle.db.select().from(automationVersions).where(eq(automationVersions.id, v2.versionId));
    expect(row).toMatchObject({ version: 2, changeNote: "One hour later", createdByUserId: userId, definition: emailDef("welcome-mail", 60) });
    expect(row!.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await audits("automation.publish", a.id)).toHaveLength(1);

    const again = err(await actions.publishVersion({ automationId: a.id, migrateActive: false }), "conflict");
    expect(again.message).toBe("definition_unchanged");
    expect(await handle.db.select().from(automationVersions).where(eq(automationVersions.automationId, a.id))).toHaveLength(2);
  });

  it("a template missing a locale of the audience blocks the publish and names it", async () => {
    const a = await makeAutomation(handle.db, { definition: emailDef("welcome-mail") });
    ok(await actions.saveDraft({ automationId: a.id, definition: emailDef("half-mail") }));
    const e = err(await actions.publishVersion({ automationId: a.id, migrateActive: false }), "validation");
    expect(e.message).toBe("translation_missing:half-mail:fr-BE");
    expect(e.fields).toMatchObject({ "steps.0.template": "translation_missing" });
    expect(await handle.db.select().from(automationVersions).where(eq(automationVersions.automationId, a.id))).toHaveLength(1);

    // Narrowing the audience to the template's locales makes it publishable.
    ok(await actions.saveDraft({ automationId: a.id, definition: { ...emailDef("half-mail"), audience: { locales: ["nl-BE", "en"] } } }));
    expect(ok<{ version: number }>(await actions.publishVersion({ automationId: a.id, migrateActive: false })).version).toBe(2);
  });

  it("the migrate checkbox enqueues automation.migrate_enrolments and audits it", async () => {
    const a = await makeAutomation(handle.db, { definition: emailDef("welcome-mail") });
    const person = await makePerson(handle.db);
    await handle.db.insert(automationEnrolments).values({ automationId: a.id, automationVersionId: a.versionId!, personId: person.id, groupId: a.groupId, source: "staff", nextStepKey: "welcome", nextStepAt: new Date() });
    ok(await actions.saveDraft({ automationId: a.id, definition: emailDef("welcome-mail", 30) }));
    const r = ok<{ versionId: string; migrationJobId?: string }>(await actions.publishVersion({ automationId: a.id, migrateActive: true }));
    const job = (await jobsOf("automation.migrate_enrolments")).find((j) => j.id === r.migrationJobId);
    expect(job).toMatchObject({ idempotencyKey: `automation_migrate:${r.versionId}:start`, lane: "bulk", payload: { automationId: a.id, toVersionId: r.versionId } });
    const audit = await audits("automation.migrate_enrolments", a.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.newValue).toMatchObject({ activeEnrolments: 1 });
  });

  it("a draft that does not validate is refused with validation", async () => {
    const a = await makeAutomation(handle.db, { definition: emailDef("welcome-mail") });
    ok(await actions.saveDraft({ automationId: a.id, definition: { ...emailDef("welcome-mail"), trigger: { event: "ops.history_imported" } } }));
    const e = err(await actions.publishVersion({ automationId: a.id, migrateActive: false }), "validation");
    expect(e.fields).toMatchObject({ "trigger.event": "trigger_history_imported" });
  });
});

describe("status moves (A-5)", () => {
  it("draft -> active -> paused -> active -> archived, each audited", async () => {
    const a = await makeAutomation(handle.db, { definition: emailDef("welcome-mail"), status: "draft" });
    expect(ok(await actions.activateAutomation({ automationId: a.id }))).toEqual({ status: "active" });
    expect((await automationRow(a.id)).activatedAt).not.toBeNull();
    expect(ok(await actions.pauseAutomation({ automationId: a.id }))).toEqual({ status: "paused" });
    expect((await automationRow(a.id)).pausedAt).not.toBeNull();
    const resumed = ok<{ status: string; jobId: string }>(await actions.resumeAutomation({ automationId: a.id }));
    expect(resumed.status).toBe("active");
    const row = await automationRow(a.id);
    expect(row).toMatchObject({ status: "active", pausedAt: null });
    expect(row.lastResumedAt).not.toBeNull();
    ok(await actions.archiveAutomation({ automationId: a.id, confirmSlug: a.slug }));
    expect((await automationRow(a.id)).status).toBe("archived");
    for (const name of ["automation.activate", "automation.pause", "automation.resume", "automation.archive"]) expect(await audits(name, a.id), name).toHaveLength(1);
  });

  it("draft and paused automations can be archived too", async () => {
    for (const status of ["draft", "paused"] as const) {
      const a = await makeAutomation(handle.db, { definition: emailDef("welcome-mail"), status });
      ok(await actions.archiveAutomation({ automationId: a.id, confirmSlug: a.slug }));
      expect(await automationRow(a.id)).toMatchObject({ status: "archived", pausedAt: null });
    }
  });

  it("refuses draft -> paused, active -> active, archived -> active and archived -> archived with conflict", async () => {
    const draft = await makeAutomation(handle.db, { definition: emailDef("welcome-mail"), status: "draft" });
    err(await actions.pauseAutomation({ automationId: draft.id }), "conflict");
    err(await actions.resumeAutomation({ automationId: draft.id }), "conflict");
    const active = await makeAutomation(handle.db, { definition: emailDef("welcome-mail") });
    err(await actions.activateAutomation({ automationId: active.id }), "conflict");
    err(await actions.resumeAutomation({ automationId: active.id }), "conflict");
    const archived = await makeAutomation(handle.db, { definition: emailDef("welcome-mail"), status: "archived" });
    err(await actions.activateAutomation({ automationId: archived.id }), "conflict");
    err(await actions.resumeAutomation({ automationId: archived.id }), "conflict");
    err(await actions.pauseAutomation({ automationId: archived.id }), "conflict");
    err(await actions.archiveAutomation({ automationId: archived.id, confirmSlug: archived.slug }), "conflict");
    err(await actions.saveDraft({ automationId: archived.id, definition: emailDef("welcome-mail") }), "conflict");
    expect((await automationRow(draft.id)).status).toBe("draft");
    expect((await automationRow(archived.id)).status).toBe("archived");
  });

  it("activating a draft without a published version is conflict; an unknown id is not_found", async () => {
    const a = await makeAutomation(handle.db, { unpublished: true });
    expect(err(await actions.activateAutomation({ automationId: a.id }), "conflict").message).toBe("not_published");
    err(await actions.activateAutomation({ automationId: crypto.randomUUID() }), "not_found");
  });

  it("archive needs the typed slug", async () => {
    const a = await makeAutomation(handle.db, { definition: emailDef("welcome-mail") });
    err(await actions.archiveAutomation({ automationId: a.id, confirmSlug: "something-else" }), "validation");
    expect((await automationRow(a.id)).status).toBe("active");
  });
});

describe("DPIA gate (A-5a)", () => {
  it("activate and resume of a requires_dpia automation are conflict until ops approves the key", async () => {
    const draft = await makeAutomation(handle.db, { definition: emailDef("welcome-mail"), status: "draft", requiresDpia: "watch_time_profiling" });
    const paused = await makeAutomation(handle.db, { definition: emailDef("welcome-mail"), status: "paused", requiresDpia: "watch_time_profiling" });
    expect(err(await actions.activateAutomation({ automationId: draft.id }), "conflict").message).toBe("dpia_not_approved:watch_time_profiling");
    expect(err(await actions.resumeAutomation({ automationId: paused.id }), "conflict").message).toBe("dpia_not_approved:watch_time_profiling");
    expect((await automationRow(draft.id)).status).toBe("draft");
    expect((await automationRow(paused.id)).status).toBe("paused");

    fx.approved.add("watch_time_profiling");
    expect(ok(await actions.activateAutomation({ automationId: draft.id }))).toEqual({ status: "active" });
    expect(ok<{ status: string }>(await actions.resumeAutomation({ automationId: paused.id })).status).toBe("active");
  });
});

describe("bulk jobs", () => {
  it("pause enqueues nothing; resume enqueues automation.resume_enrolments with the resume key", async () => {
    const a = await makeAutomation(handle.db, { definition: emailDef("welcome-mail") });
    const before = (await handle.db.select().from(jobs)).length;
    ok(await actions.pauseAutomation({ automationId: a.id }));
    expect((await handle.db.select().from(jobs)).length).toBe(before);
    const { jobId } = ok<{ jobId: string }>(await actions.resumeAutomation({ automationId: a.id }));
    const job = (await jobsOf("automation.resume_enrolments")).find((j) => j.id === jobId);
    expect(job).toMatchObject({ lane: "bulk", payload: { automationId: a.id } });
    expect(job!.idempotencyKey).toMatch(new RegExp(`^automation_resume:${a.id}:\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:start$`));
  });

  it("archive enqueues automation.end_enrolments with reason archived", async () => {
    const a = await makeAutomation(handle.db, { definition: emailDef("welcome-mail") });
    const { jobId } = ok<{ jobId: string }>(await actions.archiveAutomation({ automationId: a.id, confirmSlug: a.slug }));
    const job = (await jobsOf("automation.end_enrolments")).find((j) => j.id === jobId);
    expect(job).toMatchObject({ idempotencyKey: `automation_end:${a.id}:archived:start`, lane: "bulk", payload: { automationId: a.id, reason: "archived" } });
  });

  it("enrolSegment enqueues automation.enrol_segment with the member count; inactive automations are conflict", async () => {
    const a = await makeAutomation(handle.db, { definition: emailDef("welcome-mail") });
    const [segment] = await handle.db.insert(segments).values({ name: "P5 segment", kind: "static" }).returning();
    for (let i = 0; i < 3; i++) {
      const p = await makePerson(handle.db);
      await handle.db.insert(segmentMembers).values({ segmentId: segment!.id, personId: p.id, source: "manual" });
    }
    const r = ok<{ jobId: string; estimatedCount: number }>(await actions.enrolSegment({ automationId: a.id, segmentId: segment!.id }));
    expect(r.estimatedCount).toBe(3);
    const job = (await jobsOf("automation.enrol_segment")).find((j) => j.id === r.jobId);
    expect(job).toMatchObject({ lane: "bulk", payload: { automationId: a.id, segmentId: segment!.id } });
    expect(job!.idempotencyKey).toMatch(new RegExp(`^automation_enrol_segment:${a.id}:${segment!.id}:.+:start$`));
    expect(await audits("automation.enrol_segment", a.id)).toHaveLength(1);

    const paused = await makeAutomation(handle.db, { definition: emailDef("welcome-mail"), status: "paused" });
    err(await actions.enrolSegment({ automationId: paused.id, segmentId: segment!.id }), "conflict");
    err(await actions.enrolSegment({ automationId: a.id, segmentId: crypto.randomUUID() }), "not_found");
  });
});

// ---------------------------------------------------------------------------
// automation-P7 (R2): groups and the rules page
// ---------------------------------------------------------------------------

const BASE_PERMS = ["automations.write", "automations.publish", "reports.read"];

/** Re-grants the marketing role and signs in again with it. */
async function grant(perms: readonly string[]) {
  await handle.db.update(roles).set({ permissions: [...perms] }).where(eq(roles.key, "marketing"));
  const { token } = await createAuthSession(handle.db, { userId, audience: "staff", roleKey: "marketing", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
}

async function groupRow(id: string) {
  const [g] = await handle.db.select().from(automationGroups).where(eq(automationGroups.id, id));
  return g!;
}

async function rulesRow() {
  const [s] = await handle.db.select().from(settings).where(eq(settings.key, "automation_rules"));
  return s;
}

const RULES = { maxMarketingPerDay: 1, maxMarketingPerWeek: 3, quietStart: "21:00", quietEnd: "08:00", webhookHosts: [] as string[] };

describe("upsertGroup (automation-P7)", () => {
  it("creates a group and edits its exclusivity, lane and priority, one automation.group_update row each", async () => {
    const { id } = ok<{ id: string }>(await actions.upsertGroup({ key: "p7_journey", name: "P7 journey", isExclusive: false, priority: 100 }));
    expect(await groupRow(id)).toMatchObject({ key: "p7_journey", name: "P7 journey", isExclusive: false, lane: null, priority: 100 });
    const created = await audits("automation.group_update", id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ entityType: "automation_group", oldValue: null });

    ok(await actions.upsertGroup({ id, key: "p7_journey", name: "P7 journey", description: "Edited", isExclusive: true, lane: "sales_journey", priority: 15 }));
    expect(await groupRow(id)).toMatchObject({ isExclusive: true, lane: "sales_journey", priority: 15, description: "Edited" });
    const all = await audits("automation.group_update", id);
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.newValue)).toContainEqual(expect.objectContaining({ isExclusive: true, lane: "sales_journey", priority: 15 }));
    expect(all.map((a) => a.oldValue)).toContainEqual(expect.objectContaining({ isExclusive: false, lane: null, priority: 100 }));
  });

  it("a taken key is conflict, a key change is conflict, an unknown id is not_found, a bad lane is validation", async () => {
    const { id } = ok<{ id: string }>(await actions.upsertGroup({ key: "p7_fixed", name: "Fixed", isExclusive: false, priority: 100 }));
    expect(err(await actions.upsertGroup({ key: "p7_fixed", name: "Again", isExclusive: false, priority: 100 }), "conflict").message).toBe("group_key_taken");
    expect(err(await actions.upsertGroup({ id, key: "p7_renamed", name: "Fixed", isExclusive: false, priority: 100 }), "conflict").message).toBe("group_key_immutable");
    err(await actions.upsertGroup({ id: crypto.randomUUID(), key: "p7_ghost", name: "Ghost", isExclusive: false, priority: 100 }), "not_found");
    err(await actions.upsertGroup({ key: "p7_lane", name: "Lane", isExclusive: true, lane: "Sales Journey", priority: 100 }), "validation");
    err(await actions.upsertGroup({ key: "p7_prio", name: "Prio", isExclusive: true, priority: 1001 }), "validation");
    expect((await groupRow(id)).key).toBe("p7_fixed");
  });

  it("A-1 a group cannot become exclusive while one of its automations sets subject", async () => {
    const { id } = ok<{ id: string }>(await actions.upsertGroup({ key: "p7_subject", name: "Subject", isExclusive: false, priority: 100 }));
    const g = await groupRow(id);
    const a = await makeAutomation(handle.db, { group: g, definition: { ...emailDef("welcome-mail"), subject: "ref" } });
    expect(err(await actions.upsertGroup({ id, key: "p7_subject", name: "Subject", isExclusive: true, priority: 100 }), "conflict").message).toBe(`exclusive_subject:${a.slug}`);
    expect((await groupRow(id)).isExclusive).toBe(false);
    // Once that automation is archived the group may become exclusive.
    await handle.db.update(automations).set({ status: "archived", pausedAt: null }).where(eq(automations.id, a.id));
    ok(await actions.upsertGroup({ id, key: "p7_subject", name: "Subject", isExclusive: true, priority: 100 }));
  });
});

describe("updateAutomationRules (automation-P7)", () => {
  it("automations.publish saves caps and quiet hours; platform's settings.update and automation.rules_update are audited", async () => {
    await handle.db.delete(settings).where(eq(settings.key, "automation_rules"));
    const r = ok<{ ok: true; version: number }>(await actions.updateAutomationRules({ ...RULES, expectedVersion: 0, maxMarketingPerDay: 2, maxMarketingPerWeek: 4, quietStart: "22:00", quietEnd: "07:30" }));
    expect(r).toEqual({ ok: true, version: 1 });
    expect((await rulesRow())!.value).toEqual({ max_marketing_per_day: 2, max_marketing_per_week: 4, quiet_start: "22:00", quiet_end: "07:30", webhook_hosts: [] });
    const own = await audits("automation.rules_update", "automation_rules");
    expect(own.length).toBeGreaterThanOrEqual(1);
    expect(own.at(-1)!.newValue).toMatchObject({ max_marketing_per_day: 2, version: 1, webhookHostsChanged: false });
    expect((await audits("settings.update", "automation_rules")).length).toBeGreaterThanOrEqual(1);
  });

  it("a stale expectedVersion is conflict and changes nothing", async () => {
    await handle.db.delete(settings).where(eq(settings.key, "automation_rules"));
    ok(await actions.updateAutomationRules({ ...RULES, expectedVersion: 0 }));
    err(await actions.updateAutomationRules({ ...RULES, expectedVersion: 0, maxMarketingPerDay: 3 }), "conflict");
    expect((await rulesRow())!).toMatchObject({ version: 1, value: expect.objectContaining({ max_marketing_per_day: 1 }) });
  });

  it("a webhook host change without settings.write is forbidden; with it the hosts are normalised and saved", async () => {
    await handle.db.delete(settings).where(eq(settings.key, "automation_rules"));
    const e = err(await actions.updateAutomationRules({ ...RULES, expectedVersion: 0, webhookHosts: ["hooks.example.com"] }), "forbidden");
    expect(e.message).toContain("settings.write");
    expect(await rulesRow()).toBeUndefined();

    await grant([...BASE_PERMS, "settings.write"]);
    try {
      ok(await actions.updateAutomationRules({ ...RULES, expectedVersion: 0, webhookHosts: [" Hooks.Example.com ", "api.example.com", "hooks.example.com"] }));
      expect(((await rulesRow())!.value as { webhook_hosts: string[] }).webhook_hosts).toEqual(["api.example.com", "hooks.example.com"]);
      err(await actions.updateAutomationRules({ ...RULES, expectedVersion: 1, webhookHosts: ["https://hooks.example.com/x"] }), "validation");
    } finally {
      await grant(BASE_PERMS);
    }
    // Without settings.write the caps can still change while the hosts are sent unchanged.
    ok(await actions.updateAutomationRules({ ...RULES, expectedVersion: 1, maxMarketingPerDay: 2, webhookHosts: ["hooks.example.com", "api.example.com"] }));
    expect((await rulesRow())!.value).toMatchObject({ max_marketing_per_day: 2, webhook_hosts: ["api.example.com", "hooks.example.com"] });
    err(await actions.updateAutomationRules({ ...RULES, expectedVersion: 2, webhookHosts: [] }), "forbidden");
  });

  it("refuses out-of-range caps, a bad time and a day cap above the week cap", async () => {
    err(await actions.updateAutomationRules({ ...RULES, expectedVersion: 0, maxMarketingPerDay: 11, maxMarketingPerWeek: 30 }), "validation");
    err(await actions.updateAutomationRules({ ...RULES, expectedVersion: 0, maxMarketingPerWeek: 31 }), "validation");
    err(await actions.updateAutomationRules({ ...RULES, expectedVersion: 0, quietStart: "24:00" }), "validation");
    err(await actions.updateAutomationRules({ ...RULES, expectedVersion: 0, maxMarketingPerDay: 4, maxMarketingPerWeek: 3 }), "validation");
  });
});
