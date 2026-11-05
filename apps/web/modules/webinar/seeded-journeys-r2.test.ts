/**
 * The webinar registration journey with this package's real events (webinar-P3; spec 4.8,
 * scenario 1): the `defaults` seed on a fresh database, the seeded `webinar-registration` journey
 * activated, registrations through `registerPerson`, then automation's `automation.evaluate` and
 * `automation.step` jobs (taken from the job registry). Email's queue functions are mocked to
 * their contract and record what was sent; the reminder's `loadProps` then builds the props from
 * the enrolment's context and step key.
 *
 * email's system rows come from its seed in the demo registry (the rows `pnpm seed` writes).
 *
 * - A Friday 10:00 registration for a Sunday 10:00 webinar gets only the `h3` reminder; `d7` and
 *   `d3` are `skipped_late_entry`.
 * - A replay registration (`mode = replay`) never enters the live journey (scenario 5).
 * - `webinar.registration_cancelled` exits the enrolment; registering again re-enrols
 *   (`re_entry: after_days:0`, the fresh `webinar.registered` of rule 14).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationEnrolments, automationRuns, automations, jobs as jobsTable } from "@beam/db/schema";
import { seedDefaults } from "@beam/db/seed";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { templates } from "@beam/email/templates/webinar";
import { and, asc, eq, sql } from "@/lib/ctx";
import { makeCtx, makeJobCtx, resetRuntime } from "@/lib/testing";
import { rowsOf } from "@/lib/sensitive";
import type * as EmailApi from "@/modules/email/api";
import { JOB_BY_KIND } from "@/registry/jobs.generated";
import { DEMO_SEEDS } from "@/registry/seeds.generated";
import { cancelRegistration, registerPerson } from "./server/registration";
import { FAKE_VIDEO_ID, makeWebinar } from "./test/factories";

const state = vi.hoisted(() => ({ sent: [] as { templateSlug: string; personId: string; stepKey?: string; context?: Record<string, string> }[] }));

vi.mock("@/modules/email/api", async (orig) => {
  const { sql: q } = await import("drizzle-orm");
  const queue = vi.fn(
    async (ctx: { tx: Tx }, input: { templateSlug: string; personId: string; enrolmentId: string; idempotencyKey: string; stepKey?: string; context?: Record<string, string> }) => {
      const res = await ctx.tx.execute(q`insert into email_messages (person_id, kind, enrolment_id, locale, idempotency_key)
        values (${input.personId}::uuid, 'transactional', ${input.enrolmentId}::uuid, 'nl-BE', ${input.idempotencyKey})
        on conflict (idempotency_key) do update set updated_at = now() returning id::text as id`);
      state.sent.push({ templateSlug: input.templateSlug, personId: input.personId, ...(input.stepKey ? { stepKey: input.stepKey } : {}), ...(input.context ? { context: input.context } : {}) });
      return { messageId: (res as { rows: { id: string }[] }).rows[0]!.id, status: "queued", created: true, templateVersionId: "00000000-0000-4000-8000-0000000000aa" };
    },
  );
  return { ...(await orig<typeof EmailApi>()), queueMarketingEmail: queue, queueAutomationEmail: queue };
});

type JobDef = { kind: string; run: (ctx: unknown, input: unknown) => Promise<unknown>; input: { parse: (v: unknown) => unknown } };
const evaluateJob = JOB_BY_KIND["automation.evaluate" as keyof typeof JOB_BY_KIND] as unknown as JobDef;
const stepJob = JOB_BY_KIND["automation.step" as keyof typeof JOB_BY_KIND] as unknown as JobDef;

let h: DbHandle;
let ownerId: string;
const HOUR = 3_600_000;
const T0 = new Date("2026-11-06T09:00:00Z"); // Friday 10:00 Brussels
const SUNDAY = new Date("2026-11-08T09:00:00Z"); // Sunday 10:00 Brussels

beforeAll(async () => {
  h = await createTestDb();
  expect(await seedDefaults(h.db)).toEqual(expect.arrayContaining(["automation", "webinar"]));
  // email's system rows from the template registry (`webinar.reminder`, ...), as `pnpm seed` writes them.
  const emailSeed = DEMO_SEEDS.find((s) => s.module === "email")!;
  await emailSeed.run({ db: h.db } as never);
  await h.db.update(automations).set({ status: "active", activatedAt: T0 }).where(eq(automations.slug, "webinar-registration"));
  ownerId = (await makeUser(h.db)).id;
}, 180_000);
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  state.sent = [];
  await h.db.execute(sql`delete from jobs`);
  const [m] = rowsOf<{ m: string | null }>(await h.db.execute(sql`select max(id)::text as m from activity_events`));
  await h.db.execute(sql`insert into settings (key, value) values ('automation_cursor', ${JSON.stringify({ last_event_id: m?.m ?? "0", gaps: [] })}::jsonb)
    on conflict (key) do update set value = excluded.value`);
});

/** One evaluator run at `now`, then every pending `automation.step` job at `now`. */
async function tick(now: Date): Promise<void> {
  await evaluateJob.run(makeJobCtx(h.db, "automation.evaluate", { now }), {});
  const pending = await h.db.select().from(jobsTable).where(and(eq(jobsTable.kind, "automation.step"), eq(jobsTable.status, "pending"))).orderBy(asc(jobsTable.createdAt));
  for (const job of pending) {
    await stepJob.run(makeJobCtx(h.db, "automation.step", { now, jobId: job.id }), stepJob.input.parse(job.payload));
    await h.db.delete(jobsTable).where(eq(jobsTable.id, job.id));
  }
}

async function enrolmentsOf(personId: string) {
  return (
    await h.db
      .select({ e: automationEnrolments })
      .from(automationEnrolments)
      .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
      .where(and(eq(automationEnrolments.personId, personId), eq(automations.slug, "webinar-registration")))
      .orderBy(asc(automationEnrolments.enteredAt))
  ).map((r) => r.e);
}

const outcomes = async (enrolmentId: string) =>
  (await h.db.select({ stepKey: automationRuns.stepKey, outcome: automationRuns.outcome }).from(automationRuns).where(eq(automationRuns.enrolmentId, enrolmentId)))
    .filter((r) => r.outcome !== "entered" && r.outcome !== "scheduled")
    .map((r) => [r.stepKey, r.outcome] as [string | null, string])
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? "") || a[1].localeCompare(b[1]));

const register = (webinarId: string, personId: string, now: Date) =>
  registerPerson(h.db as unknown as Tx, makeCtx(h.db, { actor: { kind: "public" }, now }), { webinarId, personId, source: "site", locale: "nl-BE", utm: {} });

describe("webinar-registration with webinar's events (scenario 1)", () => {
  it("a Friday 10:00 registration for a Sunday 10:00 webinar gets only the h3 reminder", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: SUNDAY }, { published: true });
    const p = await makePerson(h.db);
    const { registrationId } = await register(w.id, p.id, T0);
    await tick(T0);
    const [e] = await enrolmentsOf(p.id);
    expect(e).toMatchObject({ status: "active", subjectKey: `webinar_registration:${registrationId}`, nextStepKey: "h3", nextStepAt: new Date(SUNDAY.getTime() - 3 * HOUR) });
    expect(await outcomes(e!.id)).toEqual([
      ["d3", "skipped_late_entry"],
      ["d7", "skipped_late_entry"],
    ]);
    await tick(e!.nextStepAt!);
    const failed = await h.db.select({ reason: automationRuns.reason }).from(automationRuns).where(and(eq(automationRuns.enrolmentId, e!.id), eq(automationRuns.outcome, "failed")));
    expect(failed).toEqual([]);
    expect(await outcomes(e!.id)).toEqual(expect.arrayContaining([["h3", "sent"]]));
    expect(state.sent.map((s) => [s.templateSlug, s.stepKey])).toEqual([["webinar.reminder", "h3"]]);

    // The reminder's loadProps builds the props from the enrolment's registration and step key.
    const [after] = await enrolmentsOf(p.id);
    const context = { ...((after!.context ?? {}) as Record<string, string>), ...(state.sent[0]!.context ?? {}) };
    expect(context.registration_id).toBe(registrationId);
    const reminder = templates.find((t) => t.name === "reminder")!;
    const props = await reminder.loadProps!(h.db, { personId: p.id, locale: "nl-BE", context, stepKey: state.sent[0]!.stepKey ?? null });
    expect(props).toMatchObject({ variant: "h3", registrationId, webinarId: w.id });
  });

  it("a replay registration never enters the live journey (scenario 5)", async () => {
    const ended = new Date(T0.getTime() - 2 * HOUR);
    const w = await makeWebinar(
      h.db,
      { ownerUserId: ownerId, status: "ended", startsAt: new Date(ended.getTime() - HOUR), liveStartedAt: new Date(ended.getTime() - HOUR), liveEndedAt: ended, recordingVideoId: FAKE_VIDEO_ID, durationSec: 3600, isReplayGated: false },
      { published: true },
    );
    const p = await makePerson(h.db);
    await register(w.id, p.id, T0);
    await tick(T0);
    expect(await enrolmentsOf(p.id)).toEqual([]);
  });

  it("webinar.registration_cancelled exits the enrolment; registering again re-enrols", async () => {
    const starts = new Date(T0.getTime() + 20 * 24 * HOUR);
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: starts }, { published: true });
    const p = await makePerson(h.db);
    const { registrationId } = await register(w.id, p.id, T0);
    await tick(T0);
    expect((await enrolmentsOf(p.id))[0]).toMatchObject({ status: "active", nextStepKey: "d7" });

    const later = new Date(T0.getTime() + HOUR);
    await cancelRegistration(h.db as unknown as Tx, makeCtx(h.db, { actor: { kind: "public" }, now: later }), registrationId, "customer");
    await tick(later);
    expect((await enrolmentsOf(p.id))[0]).toMatchObject({ status: "exited", endReason: "exit_event:webinar.registration_cancelled" });

    const again = new Date(T0.getTime() + 2 * HOUR);
    await register(w.id, p.id, again);
    await tick(again);
    const rows = await enrolmentsOf(p.id);
    expect(rows.map((r) => r.status)).toEqual(["exited", "active"]);
    expect(rows[1]).toMatchObject({ subjectKey: `webinar_registration:${registrationId}`, nextStepKey: "d7" });
    expect(state.sent).toEqual([]);
  });
});
