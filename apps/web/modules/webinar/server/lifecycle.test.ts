/**
 * The webinar lifecycle (webinar-P2; spec section 2.3 state table, rules 8-13, edge cases 6, 9,
 * 15, 25): one case per arrow of the state table and refusals for moves outside it, publish
 * checks, the live publish through `webinar.create_broadcast` (success, 403, lost response,
 * booking conflict), simulive by time, reschedule and cancel side effects, duplicate and the
 * poll edit rule. booking's webinar session functions are mocked to their contract
 * (`{ sessionId, created }` / `{ cancelled }`); YouTube is the fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, emailMessages, jobs, webinarCtas, webinarInteractions, webinarPolls, webinarPresenters, webinars } from "@beam/db/schema";
import { createTestDb, makeSession, makeUser } from "@beam/db/testing";
import { createYouTubeFake, type FakeYouTube } from "@beam/integrations/youtube";
import { ConflictError, and, eq, sql, type Ctx } from "@/lib/ctx";
import { runJobs } from "@/lib/job-runner";
import { createFakeIntegrations, makeCtx, makeJobCtx, runJobTwice, staffActor } from "@/lib/testing";
import { cancelWebinarSession, upsertWebinarSession } from "@/modules/booking/api";
import { runSyncStatus, setYouTubeClient } from "../jobs";
import { FAKE_VIDEO_ID, makeCta, makePoll, makeRegistration, makeWebinar, tomorrowEvening, type WebinarRow } from "../test/factories";
import {
  WEBINAR_TRANSITIONS,
  archiveWebinar,
  canTransition,
  cancelWebinar,
  duplicateWebinar,
  forceLiveState,
  jobKeys,
  publishWebinar,
  updateWebinar,
  upsertPoll,
} from "./lifecycle";

vi.mock("@/modules/booking/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), upsertWebinarSession: vi.fn(), cancelWebinarSession: vi.fn() }));

let h: DbHandle;
let fake: FakeYouTube;
let ownerId: string;
const sessionsByWebinar = new Map<string, string>();

beforeAll(async () => {
  h = await createTestDb();
  ownerId = (await makeUser(h.db)).id;
}, 120_000);
afterAll(async () => {
  setYouTubeClient(undefined);
  await h.close();
});

beforeEach(() => {
  fake = createYouTubeFake();
  setYouTubeClient(fake);
  vi.mocked(upsertWebinarSession)
    .mockReset()
    .mockImplementation(async (tx, _ctx, input) => {
      const known = sessionsByWebinar.get(input.webinarId);
      if (known) return { sessionId: known, created: false };
      const s = await makeSession(tx, { kind: "event", creditKind: null, eventCategory: "webinar", capacitySeats: 0, startsAt: input.startsAt, endsAt: input.endsAt });
      sessionsByWebinar.set(input.webinarId, s.id);
      return { sessionId: s.id, created: true };
    });
  vi.mocked(cancelWebinarSession).mockReset().mockResolvedValue({ cancelled: true });
});

const staff = (): Ctx => makeCtx(h.db, staffActor({ userId: ownerId, permissions: ["webinars.host"] }));
const reload = async (id: string): Promise<WebinarRow> => (await h.db.select().from(webinars).where(eq(webinars.id, id)))[0]!;
const jobByKey = async (key: string) => (await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, key)))[0];
const runJob = (id: string) => runJobs({ db: h.db, ids: [id], budgetMs: 20_000, integrations: createFakeIntegrations() });
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3600_000);
const expectConflict = async (p: Promise<unknown>, message?: string) => {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ConflictError);
  if (message) expect((error as Error).message).toBe(message);
};

/** A live draft, published through the action and the `create_broadcast` job. */
async function publishedLive(overrides: Partial<WebinarRow> = {}): Promise<WebinarRow> {
  const w = await makeWebinar(h.db, { ownerUserId: ownerId, ...overrides });
  await publishWebinar(staff(), { webinarId: w.id, version: w.version });
  await runJob((await jobByKey(jobKeys.broadcast(w.id)))!.id);
  return reload(w.id);
}

describe("state table (section 2.3)", () => {
  it("canTransition holds exactly the arrows of the table", () => {
    const statuses = ["draft", "published", "live", "ended", "cancelled", "archived"] as const;
    const expected = new Set([
      "draft>published:live", "draft>published:simulive", "draft>published:on_demand",
      "draft>cancelled:live", "draft>cancelled:simulive", "draft>cancelled:on_demand",
      "published>cancelled:live", "published>cancelled:simulive", "published>cancelled:on_demand",
      "published>live:live", "published>live:simulive", "live>ended:live", "live>ended:simulive",
      "ended>archived:live", "ended>archived:simulive", "ended>archived:on_demand",
      "cancelled>archived:live", "cancelled>archived:simulive", "cancelled>archived:on_demand",
      "published>archived:on_demand",
    ]);
    for (const from of statuses) for (const to of statuses) for (const mode of ["live", "simulive", "on_demand"] as const) {
      expect(canTransition(from, to, mode), `${from}>${to}:${mode}`).toBe(expected.has(`${from}>${to}:${mode}`));
    }
    expect(WEBINAR_TRANSITIONS).toHaveLength(6);
  });

  it("draft -> published (on-demand: no session)", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "on_demand", recordingVideoId: FAKE_VIDEO_ID, durationSec: 1800 });
    expect(await publishWebinar(staff(), { webinarId: w.id, version: 1 })).toEqual({ status: "published" });
    expect(await reload(w.id)).toMatchObject({ status: "published", sessionId: null });
    expect(upsertWebinarSession).not.toHaveBeenCalled();
  });

  it("draft -> published (simulive) calls booking.upsertWebinarSession and stores the session", async () => {
    const startsAt = hoursFromNow(30);
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "simulive", startsAt, recordingVideoId: FAKE_VIDEO_ID, durationSec: 2700 });
    expect(await publishWebinar(staff(), { webinarId: w.id, version: 1 })).toEqual({ status: "published" });
    expect(upsertWebinarSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      webinarId: w.id,
      title: w.title,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 2700_000),
    });
    const after = await reload(w.id);
    expect(after.status).toBe("published");
    expect(after.sessionId).toBe(sessionsByWebinar.get(w.id));
  });

  it("draft -> cancelled and published -> cancelled", async () => {
    const draft = await makeWebinar(h.db, { ownerUserId: ownerId });
    await cancelWebinar(staff(), { webinarId: draft.id, reason: "Speaker ill", notify: false });
    expect((await reload(draft.id)).status).toBe("cancelled");
    const pub = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    await cancelWebinar(staff(), { webinarId: pub.id, reason: "Speaker ill", notify: false });
    expect(await reload(pub.id)).toMatchObject({ status: "cancelled", cancelledReason: "Speaker ill" });
  });

  it("published -> live -> ended by forceLiveState (live)", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    await forceLiveState(staff(), { webinarId: w.id, to: "live" });
    const live = await reload(w.id);
    expect(live.status).toBe("live");
    expect(live.liveStartedAt).toBeInstanceOf(Date);
    await forceLiveState(staff(), { webinarId: w.id, to: "ended" });
    expect((await reload(w.id)).status).toBe("ended");
  });

  it("published -> live -> ended by sync_status from YouTube's lifecycle (live)", async () => {
    const w = await publishedLive({ startsAt: hoursFromNow(0.25) });
    const started = new Date(Date.now() - 60_000);
    fake.setLifecycle(w.youtubeVideoId!, "live", started);
    await runSyncStatus(makeJobCtx(h.db, "webinar.sync_status"), { webinarId: w.id });
    expect(await reload(w.id)).toMatchObject({ status: "live", youtubeLifecycle: "live", liveStartedAt: started });
    const ended = new Date();
    fake.setLifecycle(w.youtubeVideoId!, "complete", ended);
    await runSyncStatus(makeJobCtx(h.db, "webinar.sync_status"), { webinarId: w.id });
    expect(await reload(w.id)).toMatchObject({ status: "ended", youtubeLifecycle: "complete", liveEndedAt: ended });
  });

  it("ended -> archived, cancelled -> archived, on-demand published -> archived", async () => {
    const ended = await makeWebinar(h.db, { ownerUserId: ownerId, status: "ended", sessionId: (await makeSession(h.db, { kind: "event", creditKind: null })).id, youtubeVideoId: FAKE_VIDEO_ID });
    await archiveWebinar(staff(), { webinarId: ended.id });
    expect((await reload(ended.id)).status).toBe("archived");
    const cancelled = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    await cancelWebinar(staff(), { webinarId: cancelled.id, reason: "Speaker ill", notify: false });
    await archiveWebinar(staff(), { webinarId: cancelled.id });
    expect((await reload(cancelled.id)).status).toBe("archived");
    const neverPublished = await makeWebinar(h.db, { ownerUserId: ownerId, status: "cancelled" });
    await expectConflict(archiveWebinar(staff(), { webinarId: neverPublished.id }), "never_published");
    const od = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "on_demand" }, { published: true });
    await archiveWebinar(staff(), { webinarId: od.id });
    expect((await reload(od.id)).status).toBe("archived");
  });

  it("refuses moves outside the table: ended -> live, cancelled -> published, live published -> archived, live -> cancelled", async () => {
    const ended = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    await forceLiveState(staff(), { webinarId: ended.id, to: "live" });
    await forceLiveState(staff(), { webinarId: ended.id, to: "ended" });
    await expectConflict(forceLiveState(staff(), { webinarId: ended.id, to: "live" }), "invalid_transition:ended->live");
    const cancelled = await makeWebinar(h.db, { ownerUserId: ownerId, status: "cancelled" });
    await expectConflict(publishWebinar(staff(), { webinarId: cancelled.id, version: 1 }), "invalid_transition:cancelled->published");
    const pub = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    await expectConflict(archiveWebinar(staff(), { webinarId: pub.id }), "invalid_transition:published->archived");
    await forceLiveState(staff(), { webinarId: pub.id, to: "live" });
    await expectConflict(cancelWebinar(staff(), { webinarId: pub.id, reason: "late", notify: false }), "invalid_transition:live->cancelled");
    await expectConflict(forceLiveState(staff(), { webinarId: (await makeWebinar(h.db, { ownerUserId: ownerId })).id, to: "ended" }), "invalid_transition:draft->ended");
  });
});

describe("publish checks (rule 9)", () => {
  it("lists missing locales per field, including active polls and CTAs", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, title: { "nl-BE": "Slapen" }, description: { "nl-BE": "x", en: "x", "fr-BE": "x" } });
    await makePoll(h.db, { webinarId: w.id, key: "q1", question: { "nl-BE": "Vraag", en: "Question" } });
    await makeCta(h.db, { webinarId: w.id, key: "c1", label: { en: "Book" } });
    await makeCta(h.db, { webinarId: w.id, key: "c2", label: { en: "Old" }, isActive: false });
    const error = await publishWebinar(staff(), { webinarId: w.id, version: 1 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "validation", message: "missing_locales" });
    expect((error as { fields: Record<string, string> }).fields).toEqual({ title: "fr-BE,en", "poll:q1.question": "fr-BE", "cta:c1.label": "nl-BE,fr-BE" });
    expect((await reload(w.id)).status).toBe("draft");
  });

  it("simulive and on-demand refuse while duration_sec is unknown", async () => {
    for (const mode of ["simulive", "on_demand"] as const) {
      const w = await makeWebinar(h.db, { ownerUserId: ownerId, mode, recordingVideoId: FAKE_VIDEO_ID, durationSec: null });
      const error = await publishWebinar(staff(), { webinarId: w.id, version: 1 }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "validation", fields: { video: "video_processing" } });
    }
  });

  it("refuses a past start and a spoken language outside the locales", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: hoursFromNow(-1), locales: ["nl-BE", "fr-BE", "en"], spokenLocale: "nl-BE" });
    await expect(publishWebinar(staff(), { webinarId: w.id, version: 1 })).rejects.toMatchObject({ fields: { startsAt: "starts_at_past" } });
    const w2 = await makeWebinar(h.db, { ownerUserId: ownerId, locales: ["fr-BE"], spokenLocale: "nl-BE" });
    await expect(publishWebinar(staff(), { webinarId: w2.id, version: 1 })).rejects.toMatchObject({ fields: { spokenLocale: "not_in_locales" } });
  });
});

describe("live publish through webinar.create_broadcast", () => {
  it("stays draft with publish_requested_at until the job succeeds; only that transaction creates the session", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId });
    expect(await publishWebinar(staff(), { webinarId: w.id, version: 1 })).toEqual({ status: "publishing" });
    const pending = await reload(w.id);
    expect(pending).toMatchObject({ status: "draft", sessionId: null });
    expect(pending.publishRequestedAt).toBeInstanceOf(Date);
    expect(upsertWebinarSession).not.toHaveBeenCalled();
    expect(await jobByKey(jobKeys.meet(w.id))).toMatchObject({ kind: "webinar.create_meet_space" });
    expect(await publishWebinar(staff(), { webinarId: w.id, version: 1 })).toEqual({ status: "publishing" });

    const job = (await jobByKey(jobKeys.broadcast(w.id)))!;
    expect(await runJob(job.id)).toMatchObject({ succeeded: 1 });
    const after = await reload(w.id);
    expect(after).toMatchObject({ status: "published", publishRequestedAt: null, broadcastError: null, youtubeLifecycle: "created" });
    expect(after.youtubeVideoId).toMatch(/^fake_.{6}$/);
    expect(after.sessionId).toBe(sessionsByWebinar.get(w.id));
    expect(upsertWebinarSession).toHaveBeenCalledTimes(1);
    expect(fake.broadcasts()[0]!.description).toContain(`beam-webinar:${w.id}`);
  });

  it("a 403 sets broadcast_error, the job is dead, the webinar stays draft without a session", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId });
    await publishWebinar(staff(), { webinarId: w.id, version: 1 });
    fake.failNext("createBroadcast", { status: 403 });
    const job = (await jobByKey(jobKeys.broadcast(w.id)))!;
    expect(await runJob(job.id)).toMatchObject({ dead: 1 });
    expect((await jobByKey(jobKeys.broadcast(w.id)))!.status).toBe("dead");
    const after = await reload(w.id);
    expect(after).toMatchObject({ status: "draft", sessionId: null, publishRequestedAt: null });
    expect(after.broadcastError).toContain("403");
    expect(upsertWebinarSession).not.toHaveBeenCalled();
    // Publish again after fixing the cause: a new key `:retry:1` (edge case 6).
    await publishWebinar(staff(), { webinarId: w.id, version: 1 });
    expect(await jobByKey(jobKeys.broadcast(w.id, 1))).toMatchObject({ status: "pending" });
    expect((await reload(w.id)).broadcastError).toBeNull();
  });

  it("a lost response is retried and reuses the broadcast found by its marker", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId });
    await publishWebinar(staff(), { webinarId: w.id, version: 1 });
    fake.loseNextResponse("createBroadcast");
    const job = (await jobByKey(jobKeys.broadcast(w.id)))!;
    expect(await runJob(job.id)).toMatchObject({ retried: 1 });
    expect(fake.broadcasts()).toHaveLength(1);
    await h.db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, job.id));
    expect(await runJob(job.id)).toMatchObject({ succeeded: 1 });
    expect(fake.broadcasts()).toHaveLength(1);
    expect((await reload(w.id)).youtubeVideoId).toBe(fake.broadcasts()[0]!.broadcastId);
    expect(fake.calls.filter((c) => c.operation === "createBroadcast")).toHaveLength(1);
  });

  it("a booking conflict (webinar_session_mismatch) makes the job permanent", async () => {
    vi.mocked(upsertWebinarSession).mockRejectedValueOnce(new ConflictError("webinar_session_mismatch"));
    const w = await makeWebinar(h.db, { ownerUserId: ownerId });
    await publishWebinar(staff(), { webinarId: w.id, version: 1 });
    const job = (await jobByKey(jobKeys.broadcast(w.id)))!;
    expect(await runJob(job.id)).toMatchObject({ dead: 1 });
    expect(await reload(w.id)).toMatchObject({ status: "draft", broadcastError: "webinar_session_mismatch", sessionId: null });
  });
});

describe("simulive by time only", () => {
  it("goes live at starts_at and ended at starts_at + duration_sec without calling YouTube", async () => {
    const startsAt = hoursFromNow(10);
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "simulive", startsAt }, { published: true });
    const at = (ms: number) => makeJobCtx(h.db, "webinar.sync_status", { now: new Date(startsAt.getTime() + ms) });
    await runSyncStatus(at(-60_000), { webinarId: w.id });
    expect((await reload(w.id)).status).toBe("published");
    await runSyncStatus(at(0), { webinarId: w.id });
    expect(await reload(w.id)).toMatchObject({ status: "live", liveStartedAt: startsAt });
    await runSyncStatus(at(3599_000), { webinarId: w.id });
    expect((await reload(w.id)).status).toBe("live");
    await runSyncStatus(at(3600_000), { webinarId: w.id });
    expect(await reload(w.id)).toMatchObject({ status: "ended", liveEndedAt: new Date(startsAt.getTime() + 3600_000) });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("reschedule (rule 11, edge case 9)", () => {
  const noticeCount = async (webinarRegs: string[]) =>
    (await h.db.select({ key: emailMessages.idempotencyKey }).from(emailMessages)).filter((m) => webinarRegs.some((r) => m.key.startsWith(`webinar_reg:${r}:notice:rescheduled`))).length;

  it("by 3 minutes sends nothing; by 30 minutes writes the facts and emails each registrant once", async () => {
    const w = await publishedLive();
    const regs = [await makeRegistration(h.db, { webinarId: w.id }), await makeRegistration(h.db, { webinarId: w.id })];
    await makeRegistration(h.db, { webinarId: w.id, status: "cancelled" });
    const ids = regs.map((r) => r.id);

    const small = await updateWebinar(staff(), { webinarId: w.id, version: w.version, startsAt: new Date(w.startsAt!.getTime() + 3 * 60_000) });
    expect(small.rescheduled).toBe(false);
    expect(await h.db.select().from(jobs).where(sql`${jobs.idempotencyKey} like ${`webinar:${w.id}:notify:%`}`)).toHaveLength(0);
    expect(await jobByKey(jobKeys.broadcastUpdate(w.id, small.version))).toMatchObject({ kind: "webinar.update_broadcast" });

    const previous = (await reload(w.id)).startsAt!;
    const big = await updateWebinar(staff(), { webinarId: w.id, version: small.version, startsAt: new Date(previous.getTime() + 30 * 60_000) });
    expect(big.rescheduled).toBe(true);
    const events = await h.db.select().from(activityEvents).where(sql`${activityEvents.dedupeKey} like ${`webinar_reg:%:v${big.version}`}`);
    expect(events.filter((e) => ids.some((id) => e.dedupeKey!.startsWith(`webinar_reg:${id}:`))).map((e) => e.kind).sort()).toEqual([
      "webinar.registered", "webinar.registered", "webinar.rescheduled", "webinar.rescheduled",
    ]);
    const registered = events.find((e) => e.kind === "webinar.registered")!;
    expect(registered.data).toMatchObject({ rescheduled: true, webinar_id: w.id, starts_at: new Date(previous.getTime() + 30 * 60_000).toISOString() });
    expect(upsertWebinarSession).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ webinarId: w.id, sessionId: w.sessionId }));

    const notify = (await jobByKey(jobKeys.notify(w.id, "rescheduled", big.version, 0)))!;
    await runJob(notify.id);
    expect(await noticeCount(ids)).toBe(2);
    await runJobTwice(h.db, "webinar.notify_registrants", notify.payload);
    expect(await noticeCount(ids)).toBe(2);
  });

  it("clears finalised_at and broadcast_error; the next finalise key carries the new version", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    await h.db.update(webinars).set({ finalisedAt: new Date(), broadcastError: "never_live" }).where(eq(webinars.id, w.id));
    sessionsByWebinar.set(w.id, w.sessionId!);
    const { version } = await updateWebinar(staff(), { webinarId: w.id, version: 1, startsAt: hoursFromNow(48) });
    expect(await reload(w.id)).toMatchObject({ finalisedAt: null, broadcastError: null, version: 2 });
    expect(jobKeys.finalise(w.id, version)).toBe(`webinar:${w.id}:finalise:v2`);
  });

  it("a stale version is a conflict (edge case 25)", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId });
    await updateWebinar(staff(), { webinarId: w.id, version: 1, plannedDurationMinutes: 90 });
    await expectConflict(updateWebinar(staff(), { webinarId: w.id, version: 1, plannedDurationMinutes: 45 }), "stale_version");
  });
});

describe("cancel (rule 11)", () => {
  it("cancels the session with the reason, writes webinar.cancelled per registrant and enqueues delete and notices", async () => {
    const w = await publishedLive();
    const regs = [await makeRegistration(h.db, { webinarId: w.id }), await makeRegistration(h.db, { webinarId: w.id })];
    const out = await cancelWebinar(staff(), { webinarId: w.id, reason: "Speaker ill", notify: true });
    expect(out).toEqual({ cancelledRegistrations: 2 });
    expect(cancelWebinarSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), { webinarId: w.id, reason: "Speaker ill" });
    const events = await h.db.select().from(activityEvents).where(eq(activityEvents.kind, "webinar.cancelled"));
    for (const r of regs) expect(events.find((e) => e.dedupeKey === `webinar_reg:${r.id}:cancelled`)?.data).toEqual({ webinar_id: w.id, registration_id: r.id, reason: "Speaker ill" });
    const del = (await jobByKey(jobKeys.broadcastDelete(w.id)))!;
    expect(del.kind).toBe("webinar.delete_broadcast");
    expect(await jobByKey(jobKeys.notify(w.id, "cancelled", 2, 0))).toMatchObject({ kind: "webinar.notify_registrants" });
    await runJob(del.id);
    expect(fake.broadcasts()).toHaveLength(0);
  });
});

describe("duplicate (rule 12)", () => {
  it("creates N drafts with the series key, copied polls, CTAs and presenters", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, slug: "beter-slapen" }, { published: true });
    await makePoll(h.db, { webinarId: w.id, key: "q1" });
    await makePoll(h.db, { webinarId: w.id, key: "q_old", isActive: false });
    await makeCta(h.db, { webinarId: w.id, key: "c1" });
    await h.db.insert(webinarPresenters).values({ webinarId: w.id, userId: ownerId, displayName: "Dr. Example", role: "host" });
    const dates = [new Date("2027-03-02T19:00:00Z"), new Date("2027-03-09T19:00:00Z"), new Date("2027-03-16T19:00:00Z")];
    const { webinarIds } = await duplicateWebinar(staff(), { webinarId: w.id, startsAt: dates });
    expect(webinarIds).toHaveLength(3);
    const copies = await Promise.all(webinarIds.map(reload));
    expect(copies.map((c) => c.slug)).toEqual(["beter-slapen-2027-03-02", "beter-slapen-2027-03-09", "beter-slapen-2027-03-16"]);
    for (const c of copies) {
      expect(c).toMatchObject({ status: "draft", seriesKey: "beter-slapen", mode: "live", youtubeVideoId: null, sessionId: null, title: w.title });
      expect((await h.db.select().from(webinarPolls).where(eq(webinarPolls.webinarId, c.id))).map((p) => p.key)).toEqual(["q1"]);
      expect(await h.db.select().from(webinarCtas).where(eq(webinarCtas.webinarId, c.id))).toHaveLength(1);
      expect(await h.db.select().from(webinarPresenters).where(eq(webinarPresenters.webinarId, c.id))).toHaveLength(1);
    }
    expect((await reload(w.id)).seriesKey).toBe("beter-slapen");
    const again = await duplicateWebinar(staff(), { webinarId: w.id, startsAt: [dates[0]!] });
    expect((await reload(again.webinarIds[0]!)).slug).toBe("beter-slapen-2027-03-02-2");
  });
});

describe("polls (edge case 15)", () => {
  it("a poll with answers cannot change its options; timing and order still change", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    const poll = await makePoll(h.db, { webinarId: w.id, key: "sleep" });
    const reg = await makeRegistration(h.db, { webinarId: w.id });
    await h.db.insert(webinarInteractions).values({ registrationId: reg.id, webinarId: w.id, mode: "live", kind: "poll_answer", pollId: poll.id, payload: { option_keys: ["yes"] } });
    const base = { webinarId: w.id, pollId: poll.id, key: poll.key, question: poll.question, options: poll.options, allowMultiple: false, showForSec: 120, tagRules: [], sortOrder: 0 };
    await expectConflict(upsertPoll(staff(), { ...base, options: [...poll.options, { key: "maybe", label: { "nl-BE": "Misschien", "fr-BE": "Peut-être", en: "Maybe" } }] }), "poll_answered");
    await upsertPoll(staff(), { ...base, showAtSec: 600, sortOrder: 2 });
    expect((await h.db.select().from(webinarPolls).where(eq(webinarPolls.id, poll.id)))[0]).toMatchObject({ showAtSec: 600, sortOrder: 2 });
  });

  it("refuses tag rules naming unknown tags or options", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId });
    const error = await upsertPoll(staff(), {
      webinarId: w.id,
      key: "tags",
      question: { "nl-BE": "V", "fr-BE": "Q", en: "Q" },
      options: [{ key: "a", label: { en: "A" } }, { key: "b", label: { en: "B" } }],
      allowMultiple: false,
      showForSec: 120,
      tagRules: [{ option_keys: ["a", "z"], tag_key: "no_such_tag_key", modes: ["live"] }],
      sortOrder: 0,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "validation", fields: { tagRules: "unknown_options:z;unknown_tags:no_such_tag_key" } });
    expect(await h.db.select().from(webinarPolls).where(and(eq(webinarPolls.webinarId, w.id), eq(webinarPolls.key, "tags")))).toHaveLength(0);
  });
});

it("tomorrowEvening is in the future (factory sanity for publish checks)", () => {
  expect(tomorrowEvening().getTime()).toBeGreaterThan(Date.now());
});
