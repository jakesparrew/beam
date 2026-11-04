/**
 * The read side of automation's api.ts (automation-P2): `listPersonEnrolments`,
 * `getTimelineItems`, `hasActiveEnrolment`, `countAutomationIssues` and `enrolPersonBySlug`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationEnrolments } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { eq } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { def, makeAutomation, makeEvent, setCursor } from "./engine/automation-p2.fixtures";
import { writeRun } from "./engine/runs";

vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof import("@/modules/email/api")>()),
  getReachability: vi.fn(() => Promise.resolve({ isReachable: true, blockedReason: null })),
}));

const api = await import("./api");

let h: DbHandle;
let tx: Tx;
beforeAll(async () => {
  h = await createTestDb();
  tx = h.db as unknown as Tx;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const SYSTEM = { kind: "system", jobId: "" } as const;

describe("automation api reads", () => {
  it("enrolPersonBySlug enrols with source api and the given context; an unknown slug is inactive", async () => {
    const a = await makeAutomation(h.db, { slug: "forms-outcome-test", definition: def({ trigger: { manual: true } }) });
    const p = await makePerson(h.db);
    expect(await api.enrolPersonBySlug(tx, { slug: "no-such-slug", personId: p.id })).toEqual({ status: "skipped", outcome: "inactive" });
    const r = await api.enrolPersonBySlug(tx, { slug: a.slug, personId: p.id, subjectKey: "form_submission:s1", context: { outcome: "high" } });
    expect(r.status).toBe("enrolled");
    const [row] = await h.db.select().from(automationEnrolments).where(eq(automationEnrolments.personId, p.id));
    expect(row).toMatchObject({ source: "api", subjectKey: "form_submission:s1", context: { subject: "form_submission:s1", vars: { outcome: "high" } } });
    expect(await api.hasActiveEnrolment(h.db, p.id, a.slug)).toBe(true);
    expect(await api.hasActiveEnrolment(h.db, p.id, "other-slug")).toBe(false);
  });

  it("listPersonEnrolments and getTimelineItems list the person's journeys and runs, newest first", async () => {
    const a = await makeAutomation(h.db, { slug: "timeline-test", definition: def({ trigger: { manual: true } }) });
    const p = await makePerson(h.db);
    const r = await api.enrolPersonBySlug(tx, { slug: a.slug, personId: p.id });
    if (r.status !== "enrolled") throw new Error("not enrolled");
    await api.endEnrolment(tx, r.enrolmentId, "exited", "manual", SYSTEM);
    const list = await api.listPersonEnrolments(h.db, p.id);
    expect(list).toEqual([
      expect.objectContaining({ enrolmentId: r.enrolmentId, automationSlug: a.slug, automationName: a.name, status: "exited", endReason: "manual", nextStepKey: null }),
    ]);
    const items = await api.getTimelineItems(h.db, p.id);
    expect(items.map((i) => i.outcome)).toEqual(expect.arrayContaining(["entered", "scheduled", "exited"]));
    expect(items[0]).toMatchObject({ automationSlug: a.slug, endReason: "manual", emailMessageId: null, emailStatus: null, taskId: null });
    for (let i = 1; i < items.length; i++) expect(items[i - 1]!.occurredAt.getTime()).toBeGreaterThanOrEqual(items[i]!.occurredAt.getTime());
    expect(await api.getTimelineItems(h.db, p.id, { limit: 1 })).toHaveLength(1);
    expect(await api.getTimelineItems(h.db, p.id, { before: new Date(0) })).toEqual([]);
  });

  it("countAutomationIssues counts failed and skipped_translation runs, stuck enrolments and the evaluator lag", async () => {
    const since = new Date(Date.now() - 60_000);
    const before = await api.countAutomationIssues(h.db, since);
    const a = await makeAutomation(h.db, { definition: def({ trigger: { manual: true } }) });
    const p = await makePerson(h.db);
    await writeRun(tx, { enrolmentId: null, personId: p.id, automationId: a.id, outcome: "failed", reason: "x", actor: SYSTEM });
    await writeRun(tx, { enrolmentId: null, personId: p.id, automationId: a.id, outcome: "skipped_translation", reason: "y", actor: SYSTEM });
    const r = await api.enrolPersonBySlug(tx, { slug: a.slug, personId: p.id });
    if (r.status !== "enrolled") throw new Error("not enrolled");
    await h.db.update(automationEnrolments).set({ nextStepAt: new Date(Date.now() - 31 * 60_000) }).where(eq(automationEnrolments.id, r.enrolmentId));
    const ev = await makeEvent(h.db, { personId: p.id, kind: "test.happened", occurredAt: new Date(Date.now() - 6 * 60_000) });
    await setCursor(h.db, BigInt(ev.id) - 1n);
    const after = await api.countAutomationIssues(h.db, since);
    expect(after.failed).toBe(before.failed + 1);
    expect(after.skippedTranslation).toBe(before.skippedTranslation + 1);
    expect(after.stuck).toBe(before.stuck + 1);
    expect(after.evaluatorLagSeconds).toBeGreaterThanOrEqual(6 * 60 - 5);
    await setCursor(h.db, BigInt(ev.id));
    expect((await api.countAutomationIssues(h.db, since)).evaluatorLagSeconds).toBe(0);
  });
});
