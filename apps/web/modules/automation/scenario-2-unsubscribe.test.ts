/**
 * Scenario 2, fast unsubscribe (A-23, architecture section 7): crm's `addSuppression` inserts the
 * suppression and calls `requestSuppressionExit` in the same transaction; the
 * `automation.exit_for_suppression` job ends the person's marketing journeys with
 * `unsubscribed` (merged rows with the same address too), the transactional journey keeps
 * running, and the job takes well under one second.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationEnrolments, automationRuns, jobs } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { emailHash } from "@beam/core/crm";
import { and, createCtx, eq } from "@/lib/ctx";
import { runJobs } from "@/lib/job-runner";
import { createFakeIntegrations, resetRuntime } from "@/lib/testing";
import { addSuppression } from "@/modules/crm/api";
import { def, makeAutomation } from "./engine/automation-p2.fixtures";

import type * as EmailApi from "@/modules/email/api";
vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  getReachability: vi.fn(() => Promise.resolve({ isReachable: true, blockedReason: null })),
}));

const { enrol } = await import("./engine/enrol");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const SYSTEM = { kind: "system", jobId: "" } as const;
const status = async (id: string) => (await h.db.select().from(automationEnrolments).where(eq(automationEnrolments.id, id)))[0]!;

describe("scenario 2: unsubscribe ends marketing journeys within seconds", () => {
  it("suppression inserted -> requestSuppressionExit -> job ends marketing journeys with unsubscribed; transactional keeps running", async () => {
    const email = `scenario2-${Date.now()}@example.com`;
    const person = await makePerson(h.db, { email, emailHash: emailHash(email) });
    const winner = await makePerson(h.db);
    const mergedRow = await makePerson(h.db, { email, emailHash: emailHash(email), mergedIntoPersonId: winner.id });
    const welcome = await makeAutomation(h.db, { purpose: "newsletter", definition: def({ trigger: { manual: true } }) });
    const events = await makeAutomation(h.db, { purpose: "events", definition: def({ trigger: { manual: true } }) });
    const waitlist = await makeAutomation(h.db, { isMarketing: false, definition: def({ trigger: { manual: true } }) });
    const ids: Record<string, string> = {};
    for (const [name, a] of Object.entries({ welcome, events, waitlist })) {
      const r = await enrol(h.db as unknown as Tx, { automation: a.id, personId: person.id, source: "staff", actor: SYSTEM, now: new Date() });
      if (r.status !== "enrolled") throw new Error(name);
      ids[name] = r.enrolmentId;
    }
    // A merged row with the same address is found by the hash lookup but is never enrolled (A-11).
    const loserJourney = await enrol(h.db as unknown as Tx, { automation: welcome.id, personId: mergedRow.id, source: "staff", actor: SYSTEM, now: new Date(), override: true });
    expect(loserJourney.status).toBe("skipped");

    const { suppressionId } = await h.db.transaction(async (tx) => {
      const ctx = createCtx({ tx, actor: SYSTEM });
      return addSuppression(tx, ctx, { email, scope: "newsletter", reason: "unsubscribe", source: "one_click", personId: person.id });
    });
    const [job] = await h.db.select().from(jobs).where(and(eq(jobs.kind, "automation.exit_for_suppression"), eq(jobs.idempotencyKey, `supp:${suppressionId}`)));
    expect(job).toMatchObject({ lane: "fast", priority: 1, status: "pending", payload: { suppressionId } });

    const started = performance.now();
    const summary = await runJobs({ db: h.db, ids: [job!.id], budgetMs: 5_000, integrations: createFakeIntegrations() });
    const elapsed = performance.now() - started;
    expect(summary).toMatchObject({ succeeded: 1, dead: 0 });
    expect(elapsed).toBeLessThan(1_000);

    expect(await status(ids.welcome!)).toMatchObject({ status: "exited", endReason: "unsubscribed", nextStepAt: null });
    expect((await status(ids.events!)).status).toBe("active");
    expect((await status(ids.waitlist!)).status).toBe("active");
    const exitRuns = await h.db.select().from(automationRuns).where(and(eq(automationRuns.enrolmentId, ids.welcome!), eq(automationRuns.outcome, "exited")));
    expect(exitRuns).toEqual([expect.objectContaining({ reason: "unsubscribed", data: { suppression_id: suppressionId }, actor: { kind: "job", id: job!.id } })]);

    // A second suppression for the same scope enqueues nothing new (key supp:<id>) and a
    // scope `all` suppression ends the events journey too; transactional still runs.
    const again = await h.db.transaction(async (tx) => addSuppression(tx, createCtx({ tx, actor: SYSTEM }), { email, scope: "newsletter", reason: "unsubscribe", source: "one_click" }));
    expect(again.suppressionId).toBe(suppressionId);
    expect((await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `supp:${suppressionId}`))).length).toBe(1);
    const all = await h.db.transaction(async (tx) => addSuppression(tx, createCtx({ tx, actor: SYSTEM }), { email, scope: "all", reason: "complaint", source: "resend" }));
    const [allJob] = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `supp:${all.suppressionId}`));
    await runJobs({ db: h.db, ids: [allJob!.id], budgetMs: 5_000, integrations: createFakeIntegrations() });
    expect(await status(ids.events!)).toMatchObject({ status: "exited", endReason: "unsubscribed" });
    expect((await status(ids.waitlist!)).status).toBe("active");
  });
});
