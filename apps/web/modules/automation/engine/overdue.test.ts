/**
 * Overdue and resume rules (automation-P3): A-28 (email, Slack and webhook steps more than
 * 24 hours late are skipped, `skipped_paused` after a pause, else `skipped_stale`; other steps
 * still run), A-29 (`automation.resume_enrolments` after a paused race, with the `:resume:`
 * key) and the `:defer:` key of A-26a. Email is mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automations, jobs as jobsTable } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { like } from "drizzle-orm";
import { eq } from "@/lib/ctx";
import { makeCtx, resetRuntime } from "@/lib/testing";
import type * as EmailApi from "@/modules/email/api";

vi.mock("@/modules/email/api", async (orig) => {
  const { sql: q } = await import("drizzle-orm");
  const queue = vi.fn(async (ctx: { tx: Tx }, input: { personId: string; enrolmentId: string; idempotencyKey: string }) => {
    const res = await ctx.tx.execute(q`insert into email_messages (person_id, kind, enrolment_id, locale, idempotency_key)
      values (${input.personId}::uuid, 'transactional', ${input.enrolmentId}::uuid, 'nl-BE', ${input.idempotencyKey})
      on conflict (idempotency_key) do update set updated_at = now() returning id::text as id`);
    return { messageId: (res as { rows: { id: string }[] }).rows[0]!.id, status: "queued", created: true, templateVersionId: "v" };
  });
  return {
    ...(await orig<typeof EmailApi>()),
    getPublishedTemplateInfo: vi.fn((_db: unknown, slugs: string[]) =>
      Promise.resolve(new Map(slugs.map((s) => [s, { templateVersionId: "v", kind: "transactional", purpose: null, locales: ["nl-BE", "fr-BE", "en"] }]))),
    ),
    getReachability: vi.fn(() => Promise.resolve({ isReachable: true, blockedReason: null })),
    queueAutomationEmail: queue,
    queueMarketingEmail: queue,
  };
});

const { runStep, stepJobKey } = await import("./step");
const { resumeEnrolments, resumeJobKey } = await import("./bulk");
const f = await import("./automation-p3.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  await f.makeTag(h.db, "engaged");
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await f.resetJobs(h.db);
});

const H = 3_600_000;
const t0 = new Date("2026-11-06T09:00:00Z");
const tx = () => h.db as unknown as Tx;
const run = (enrolmentId: string, stepKey: string, at: Date) => runStep(tx(), { enrolmentId, stepKey, now: at }, { ctx: makeCtx(h.db, { now: at }) });

const mailThenTag = () =>
  f.steps([
    { key: "mail", type: "email", template: "automation.test_mail", at: { from: "enrolment", minutes: 0 } },
    { key: "later", type: "tag", tag: "engaged", at: { from: "enrolment", minutes: 3 * 24 * 60 } },
  ]);

async function pause(automationId: string, at: Date) {
  await h.db.update(automations).set({ status: "paused", pausedAt: at }).where(eq(automations.id, automationId));
}
async function resume(automationId: string, at: Date) {
  await h.db.update(automations).set({ status: "active", pausedAt: null, lastResumedAt: at }).where(eq(automations.id, automationId));
}

describe("A-28 overdue rule", () => {
  it("A-28 an email step more than 24 hours late is skipped_stale; 23 hours late it still sends", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: mailThenTag() });
    const late = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now: t0 });
    expect(await run(late, "mail", new Date(t0.getTime() + 25 * H))).toMatchObject({ outcome: "skipped_stale", nextStepKey: "later" });
    const onTime = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now: t0 });
    expect(await run(onTime, "mail", new Date(t0.getTime() + 23 * H))).toMatchObject({ outcome: "sent" });
  });

  it("A-28 after a pause in that window the outcome is skipped_paused", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: mailThenTag() });
    const id = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now: t0 });
    await pause(a.id, new Date(t0.getTime() - H));
    await resume(a.id, new Date(t0.getTime() + 26 * H));
    expect(await run(id, "mail", new Date(t0.getTime() + 26 * H))).toMatchObject({ outcome: "skipped_paused" });
  });

  it("A-28 a tag step still runs 30 hours late", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: f.steps([{ key: "t", type: "tag", tag: "engaged", at: { from: "enrolment", minutes: 0 } }]) });
    const id = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now: t0 });
    expect(await run(id, "t", new Date(t0.getTime() + 30 * H))).toMatchObject({ outcome: "tag_applied" });
  });
});

describe("A-29 resume", () => {
  it("A-29 a step paused between enqueue and run is re-enqueued with the :resume: key; >24 h overdue steps are skipped_paused; later ones wait", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: mailThenTag() });
    const raced = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now: t0 });
    const old = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now: new Date(t0.getTime() - 30 * H) });
    const resumedAt = new Date(t0.getTime() + 2 * H + 17_000);
    const future = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now: new Date(resumedAt.getTime() + H) });

    // The evaluator's job already ran (succeeded) while the automation was paused: a no-op.
    await h.db.insert(jobsTable).values({ kind: "automation.step", payload: { enrolmentId: raced, stepKey: "mail" }, idempotencyKey: stepJobKey(raced, "mail"), lane: "fast", status: "succeeded" });
    await pause(a.id, new Date(t0.getTime() - 60_000));
    expect(await run(raced, "mail", new Date(t0.getTime() + 60_000))).toEqual({ status: "noop", reason: "automation_inactive" });
    expect((await f.enrolmentRow(h.db, raced)).nextStepKey).toBe("mail");

    await resume(a.id, resumedAt);
    const ctx = makeCtx(h.db, { now: resumedAt });
    const input = { automationId: a.id, resumedAt: resumedAt.toISOString() };
    const res = await resumeEnrolments(tx(), ctx, input);
    expect(res).toMatchObject({ handled: 2, skipped: 1, enqueued: 1, continued: false });

    const resumeKey = `automation:${raced}:mail:resume:2026-11-06T11:00`;
    expect(stepJobKey(raced, "mail", { kind: "resume", at: resumedAt })).toBe(resumeKey);
    const stepJobs = await h.db.select().from(jobsTable).where(like(jobsTable.idempotencyKey, `automation:${raced}:%`));
    expect(stepJobs.map((j) => j.idempotencyKey).sort()).toEqual([`automation:${raced}:mail`, resumeKey]);
    expect(stepJobs.find((j) => j.idempotencyKey === resumeKey)).toMatchObject({ kind: "automation.step", status: "pending", priority: 2 });

    expect(await f.stepOutcomes(h.db, old)).toEqual([["mail", "skipped_paused"]]);
    expect((await f.enrolmentRow(h.db, old)).nextStepKey).toBe("later");
    expect((await f.enrolmentRow(h.db, future)).nextStepKey).toBe("mail");
    expect(await h.db.select().from(jobsTable).where(like(jobsTable.idempotencyKey, `automation:${future}:%`))).toEqual([]);

    // The resumed job sends now (2 hours late is inside the 24-hour window).
    expect(await run(raced, "mail", resumedAt)).toMatchObject({ outcome: "sent", nextStepKey: "later" });
    // A second resume pass at the same time enqueues nothing new.
    expect(await resumeEnrolments(tx(), ctx, input)).toMatchObject({ enqueued: 0, skipped: 0 });
  });

  it("A-29 the resume job key carries the automation, the UTC minute and the chunk start", () => {
    const at = "2026-11-06T11:00:17.000Z";
    expect(resumeJobKey({ automationId: "a1", resumedAt: at })).toBe("automation_resume:a1:2026-11-06T11:00:start");
    expect(resumeJobKey({ automationId: "a1", resumedAt: at, after: "e9" })).toBe("automation_resume:a1:2026-11-06T11:00:e9");
  });

  it("A-29 a paused automation's resume job does nothing", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: mailThenTag() });
    await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now: t0 });
    await pause(a.id, t0);
    expect(await resumeEnrolments(tx(), makeCtx(h.db, { now: t0 }), { automationId: a.id, resumedAt: t0.toISOString() })).toMatchObject({ handled: 0 });
  });
});

describe("A-26a :defer: key", () => {
  it("A-26a the :defer: key is unique per run time (UTC minute bucket)", () => {
    const a = new Date("2026-11-06T07:00:00Z");
    const b = new Date("2026-11-07T07:00:00Z");
    const ka = stepJobKey("e1", "mail", { kind: "defer", at: a });
    expect(ka).toBe("automation:e1:mail:defer:2026-11-06T07:00");
    expect(stepJobKey("e1", "mail", { kind: "defer", at: b })).not.toBe(ka);
    expect(stepJobKey("e1", "mail", { kind: "defer", at: new Date(a.getTime() + 30_000) })).toBe(ka);
    expect(ka).not.toBe(stepJobKey("e1", "mail"));
  });
});
