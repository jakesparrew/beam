/**
 * automation-P5 staff queries (automation spec 4.2): the list joins group and stats and filters
 * by status, group and search; `getAutomation` returns the draft issues and whether the draft
 * differs from the published version; versions come newest first and `getVersion` diffs against
 * the previous one; enrolments and runs page with keyset cursors; groups count their automations;
 * `canViewAutomations` accepts `automations.write` or `reports.read`. Email's
 * `getPublishedTemplateInfo` and `listPublishedTemplates` are mocked to their contract shapes.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { automationEnrolments, automationRuns, automationVersions } from "@beam/db/schema";
import type { Definition } from "@beam/core/automation";
import type * as EmailApi from "@/modules/email/api";

vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  getPublishedTemplateInfo: (_db: unknown, slugs: string[]) =>
    Promise.resolve(new Map(slugs.filter((s) => s === "q-mail").map((s) => [s, { templateVersionId: randomUUID(), kind: "marketing" as const, purpose: "newsletter" as const, locales: ["nl-BE", "fr-BE", "en"] as const }]))),
  listPublishedTemplates: () => Promise.resolve([{ slug: "q-mail", name: "Q mail", kind: "marketing" as const, purpose: "newsletter" as const, locales: ["nl-BE", "fr-BE", "en"] as const }]),
}));

const q = await import("./queries");
const { eq, setAppDb, sql } = await import("@/lib/ctx");
const { resetRuntime, staffActor } = await import("@/lib/testing");
const { def, makeAutomation, makeGroup } = await import("./engine/automation-p2.fixtures");

let handle: DbHandle;

const emailDef = (minutes: number): Definition => ({
  schema_version: 1,
  trigger: { event: "booking.confirmed" },
  anchor: "enrolment",
  re_entry: "never",
  exit_on: [],
  steps: [{ key: "mail", type: "email", template: "q-mail", at: { from: "enrolment", minutes } }],
});

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

describe("automation-P5 queries", () => {
  it("canViewAutomations needs automations.write or reports.read", () => {
    expect(q.canViewAutomations(staffActor({ permissions: ["reports.read"] }))).toBe(true);
    expect(q.canViewAutomations(staffActor({ permissions: ["automations.write"] }))).toBe(true);
    expect(q.canViewAutomations(staffActor({ permissions: ["persons.read"] }))).toBe(false);
    expect(q.canViewAutomations({ kind: "public" })).toBe(false);
  });

  it("listAutomations filters by status, group and search and carries group and stats", async () => {
    const group = await makeGroup(handle.db, { isExclusive: true, lane: "q_lane" });
    const a = await makeAutomation(handle.db, { slug: "q-list-active", group });
    await makeAutomation(handle.db, { slug: "q-list-paused", group, status: "paused" });
    const person = await makePerson(handle.db);
    await handle.db.insert(automationRuns).values({ personId: person.id, automationId: a.id, outcome: "failed", actor: { kind: "system", id: "" } });
    const rows = await q.listAutomations(handle.db, { groupKey: group.key });
    expect(rows.map((r) => r.slug).sort()).toEqual(["q-list-active", "q-list-paused"]);
    const active = rows.find((r) => r.slug === "q-list-active")!;
    expect(active).toMatchObject({ groupIsExclusive: true, currentVersion: 1, failed7d: 1, status: "active" });
    expect((await q.listAutomations(handle.db, { groupKey: group.key, status: "paused" })).map((r) => r.slug)).toEqual(["q-list-paused"]);
    expect((await q.listAutomations(handle.db, { q: "LIST-ACT" })).map((r) => r.slug)).toEqual(["q-list-active"]);
  });

  it("getAutomation returns draft issues and whether the draft differs from the published version", async () => {
    const a = await makeAutomation(handle.db, { definition: emailDef(0), draftDefinition: emailDef(0) });
    // The fixture's version hash is random, so a draft equal to the definition still "differs" until published by the action.
    const [v] = await handle.db.select().from(automationVersions).where(eq(automationVersions.automationId, a.id));
    await handle.db.execute(sql`update automation_versions set definition_hash = ${q.definitionHash(emailDef(0))} where id = ${v!.id}`);
    const same = await q.getAutomation(handle.db, { id: a.id });
    expect(same).toMatchObject({ draftDiffers: false, draftIssues: [] });
    expect(same!.currentVersion).toMatchObject({ version: 1 });

    const b = await makeAutomation(handle.db, { definition: emailDef(0), draftDefinition: { ...emailDef(0), steps: [{ key: "mail", type: "email", template: "nope-mail" }] } });
    const changed = await q.getAutomation(handle.db, { id: b.id });
    expect(changed!.draftDiffers).toBe(true);
    expect(changed!.draftIssues.map((i) => i.code)).toContain("template_unavailable");
    expect(await q.getAutomation(handle.db, { id: "not-a-uuid" })).toBeNull();
    expect(await q.getAutomation(handle.db, { id: randomUUID() })).toBeNull();
  });

  it("listVersions is newest first and getVersion diffs against the previous version", async () => {
    const a = await makeAutomation(handle.db, { definition: emailDef(0) });
    const [v2] = await handle.db.insert(automationVersions).values({ automationId: a.id, version: 2, definition: emailDef(60), definitionHash: q.definitionHash(emailDef(60)), changeNote: "later" }).returning();
    const versions = await q.listVersions(handle.db, { automationId: a.id });
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    const detail = await q.getVersion(handle.db, { versionId: v2!.id });
    expect(detail!.previous).toMatchObject({ version: 1 });
    expect(detail!.diff).toEqual([{ path: "steps.mail.at.minutes", kind: "changed", before: 0, after: 60 }]);
    const first = await q.getVersion(handle.db, { versionId: a.versionId! });
    expect(first!.previous).toBeNull();
    expect(first!.diff.map((c) => c.kind)).toContain("added");
  });

  it("listEnrolments and listRuns page with keyset cursors and carry the person's name", async () => {
    const a = await makeAutomation(handle.db, { definition: def() });
    for (let i = 0; i < 3; i++) {
      const p = await makePerson(handle.db, { firstName: `Q${i}` });
      const [e] = await handle.db
        .insert(automationEnrolments)
        .values({ automationId: a.id, automationVersionId: a.versionId!, personId: p.id, groupId: a.groupId, source: "staff", enteredAt: new Date(Date.now() - i * 60_000), nextStepKey: "s1", nextStepAt: new Date() })
        .returning();
      await handle.db.insert(automationRuns).values({ enrolmentId: e!.id, personId: p.id, automationId: a.id, outcome: "entered", actor: { kind: "system", id: "" }, occurredAt: new Date(Date.now() - i * 60_000) });
    }
    const page1 = await q.listEnrolments(handle.db, { automationId: a.id, limit: 2 });
    expect(page1.rows.map((r) => r.firstName)).toEqual(["Q0", "Q1"]);
    const page2 = await q.listEnrolments(handle.db, { automationId: a.id, limit: 2, cursor: page1.nextCursor! });
    expect(page2.rows.map((r) => r.firstName)).toEqual(["Q2"]);
    expect(page2.nextCursor).toBeNull();
    expect((await q.listEnrolments(handle.db, { automationId: a.id, status: "exited" })).rows).toEqual([]);

    const runs1 = await q.listRuns(handle.db, { automationId: a.id, limit: 2 });
    expect(runs1.rows.map((r) => r.firstName)).toEqual(["Q0", "Q1"]);
    const runs2 = await q.listRuns(handle.db, { automationId: a.id, limit: 2, cursor: runs1.nextCursor! });
    expect(runs2.rows.map((r) => r.firstName)).toEqual(["Q2"]);
    expect((await q.listRuns(handle.db, { automationId: a.id, outcome: "failed" })).rows).toEqual([]);
    expect((await q.listRuns(handle.db, { automationId: a.id, from: new Date(Date.now() + 60_000) })).rows).toEqual([]);
  });

  it("listGroups counts non-archived automations; listTemplateOptions maps email's published templates", async () => {
    const group = await makeGroup(handle.db);
    await makeAutomation(handle.db, { group });
    await makeAutomation(handle.db, { group, status: "archived" });
    const row = (await q.listGroups(handle.db)).find((g) => g.key === group.key);
    expect(row).toMatchObject({ automationCount: 1 });
    expect(await q.listTemplateOptions(handle.db)).toEqual([{ slug: "q-mail", name: "Q mail", kind: "marketing", purpose: "newsletter", locales: ["nl-BE", "fr-BE", "en"] }]);
  });

  it("automationLabels flattens the catalogue under the given prefixes", () => {
    const l = q.automationLabels("en", ["panel", "outcome"]);
    expect(l["panel.empty"]).toBe("This person is in no journey");
    expect(Object.keys(l).filter((k) => k.startsWith("outcome.")).length).toBe(23);
    expect(Object.keys(l).some((k) => k.startsWith("editor."))).toBe(false);
  });
});
