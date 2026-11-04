/**
 * webinar jobs (webinar-P2, spec 4.5 and 4.6): every job runs twice with the same payload and
 * leaves the same state (conventions, `runJobTwice`), and the scans enqueue the per-webinar jobs
 * with the keys of section 4.5. booking's session functions are mocked to their contract; YouTube
 * and Meet are the fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { emailMessages, jobs as jobsTable, webinars } from "@beam/db/schema";
import { createTestDb, makeSession, makeUser } from "@beam/db/testing";
import { createYouTubeFake, type FakeYouTube } from "@beam/integrations/youtube";
import { enqueueJob, eq, sql } from "@/lib/ctx";
import { runJobs } from "@/lib/job-runner";
import { createFakeIntegrations, makeJobCtx, resetRuntime, runJobTwice } from "@/lib/testing";
import { upsertWebinarSession } from "@/modules/booking/api";
import { NOTIFY_CHUNK, jobs, setYouTubeClient, youtubeFor } from "./jobs";
import { runScanLive, runScanRecordings, schedules } from "./schedules";
import { jobKeys } from "./server/lifecycle";
import { FAKE_VIDEO_ID, makeRegistration, makeWebinar, type WebinarRow } from "./test/factories";

vi.mock("@/modules/booking/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), upsertWebinarSession: vi.fn(), cancelWebinarSession: vi.fn() }));

let h: DbHandle;
let fake: FakeYouTube;
let ownerId: string;

beforeAll(async () => {
  h = await createTestDb();
  ownerId = (await makeUser(h.db)).id;
}, 120_000);
afterAll(async () => {
  setYouTubeClient(undefined);
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  fake = createYouTubeFake();
  setYouTubeClient(fake);
  vi.mocked(upsertWebinarSession)
    .mockReset()
    .mockImplementation(async (tx, _ctx, input) => ({
      sessionId: input.sessionId ?? (await makeSession(tx, { kind: "event", creditKind: null, startsAt: input.startsAt, endsAt: input.endsAt })).id,
      created: !input.sessionId,
    }));
});

const reload = async (id: string): Promise<WebinarRow> => (await h.db.select().from(webinars).where(eq(webinars.id, id)))[0]!;
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3600_000);
const stateOf = async (id: string) => {
  const { updatedAt: _u, ...rest } = await reload(id);
  return rest;
};

/** Runs the job twice and asserts the webinar row is the same after each run. */
async function twiceSame(kind: Parameters<typeof runJobTwice>[1], payload: Record<string, unknown> & { webinarId: string }) {
  let afterFirst: unknown;
  const out = await runJobTwice(h.db, kind, payload, { between: async () => void (afterFirst = await stateOf(payload.webinarId)) });
  expect(await stateOf(payload.webinarId)).toEqual(afterFirst);
  return out;
}

describe("declarations", () => {
  it("declares the P2 kinds with the spec's lanes, priorities and attempts, and the two scans", () => {
    const byKind = Object.fromEntries(jobs.map((j) => [j.kind, j]));
    expect(byKind["webinar.create_broadcast"]).toMatchObject({ lane: "fast", priority: 3, maxAttempts: 6 });
    expect(byKind["webinar.update_broadcast"]).toMatchObject({ lane: "fast", priority: 3, maxAttempts: 6 });
    expect(byKind["webinar.delete_broadcast"]).toMatchObject({ lane: "fast", priority: 5, maxAttempts: 6 });
    expect(byKind["webinar.create_meet_space"]).toMatchObject({ lane: "fast", priority: 5, maxAttempts: 6 });
    expect(byKind["webinar.sync_status"]).toMatchObject({ lane: "fast", priority: 2, maxAttempts: 2 });
    expect(byKind["webinar.fetch_recording"]).toMatchObject({ lane: "fast", priority: 5, maxAttempts: 3 });
    expect(byKind["webinar.notify_registrants"]).toMatchObject({ lane: "bulk", priority: 5, maxAttempts: 6 });
    expect(Object.fromEntries(schedules.map((s) => [s.kind, s.cron]))).toMatchObject({ "webinar.scan_live": "* * * * *", "webinar.scan_recordings": "*/10 * * * *" });
    for (const s of schedules) expect(byKind[s.kind], s.kind).toBeDefined();
  });

  it("the client selector gives the process fake under INTEGRATIONS=fake and a not-configured client without keys", async () => {
    setYouTubeClient(undefined);
    const ctx = { integrationLog: () => undefined };
    const a = youtubeFor(ctx, { INTEGRATIONS: "fake" });
    expect(a).toBe(youtubeFor(ctx, { INTEGRATIONS: "fake" }));
    await expect(youtubeFor(ctx, { APP_ENV: "production" }).getVideo(FAKE_VIDEO_ID)).rejects.toThrow("not_configured: youtube");
    setYouTubeClient(fake);
  });
});

describe("runJobTwice", () => {
  it("webinar.create_broadcast", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, publishRequestedAt: new Date() });
    const { first, second } = await twiceSame("webinar.create_broadcast", { webinarId: w.id });
    expect(first).toMatchObject({ reused: false });
    expect(second).toEqual({ skipped: "published" });
    expect(fake.broadcasts()).toHaveLength(1);
    expect(upsertWebinarSession).toHaveBeenCalledTimes(1);
  });

  it("webinar.update_broadcast", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    const b = await fake.createBroadcast({ title: "old", description: "old", scheduledStartAt: new Date() });
    await h.db.update(webinars).set({ youtubeVideoId: b.broadcastId }).where(eq(webinars.id, w.id));
    await twiceSame("webinar.update_broadcast", { webinarId: w.id, version: 1 });
    const updated = fake.broadcasts()[0]!;
    expect(updated).toMatchObject({ title: "Beter slapen", scheduledStartAt: w.startsAt });
    expect(updated.description).toContain(`beam-webinar:${w.id}`);
  });

  it("webinar.update_broadcast: a 404 is permanent and shown", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    await expect(runJobTwice(h.db, "webinar.update_broadcast", { webinarId: w.id, version: 1 })).rejects.toMatchObject({ retryable: false });
    // Through the runner, the durable `broadcast_error` survives the job's rollback.
    const { id } = await enqueueJob(h.db, { kind: "webinar.update_broadcast", payload: { webinarId: w.id, version: 1 }, key: jobKeys.broadcastUpdate(w.id, 1) });
    expect(await runJobs({ db: h.db, ids: [id], budgetMs: 10_000, integrations: createFakeIntegrations() })).toMatchObject({ dead: 1 });
    expect((await reload(w.id)).broadcastError).toContain("not found");
  });

  it("webinar.delete_broadcast (404 on the second run counts as done; a completed broadcast is kept)", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    const b = await fake.createBroadcast({ title: "x", description: "x", scheduledStartAt: new Date() });
    await h.db.update(webinars).set({ youtubeVideoId: b.broadcastId, status: "cancelled" }).where(eq(webinars.id, w.id));
    const { first, second } = await twiceSame("webinar.delete_broadcast", { webinarId: w.id });
    expect(first).toEqual({ deleted: true });
    expect(second).toEqual({ deleted: false, missing: true });
    const kept = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    const done = await fake.createBroadcast({ title: "y", description: "y", scheduledStartAt: new Date() });
    fake.setLifecycle(done.broadcastId, "complete");
    await h.db.update(webinars).set({ youtubeVideoId: done.broadcastId, status: "cancelled" }).where(eq(webinars.id, kept.id));
    expect((await runJobTwice(h.db, "webinar.delete_broadcast", { webinarId: kept.id })).second).toEqual({ kept: "complete" });
  });

  it("webinar.create_meet_space", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId });
    const { second } = await twiceSame("webinar.create_meet_space", { webinarId: w.id });
    expect(second).toEqual({ skipped: true });
    const after = await reload(w.id);
    expect(after.hostMeetUrl).toMatch(/^https:\/\/meet\.google\.com\//);
    expect(after.meetSpaceName).toMatch(/^spaces\//);
    expect(fake.calls.filter((c) => c.operation === "createMeetSpace")).toHaveLength(1);
  });

  it("webinar.sync_status (live and simulive)", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: hoursFromNow(0.2) }, { published: true });
    const b = await fake.createBroadcast({ title: "x", description: "x", scheduledStartAt: new Date() });
    await h.db.update(webinars).set({ youtubeVideoId: b.broadcastId }).where(eq(webinars.id, w.id));
    fake.setLifecycle(b.broadcastId, "live", new Date(Date.now() - 1000));
    await twiceSame("webinar.sync_status", { webinarId: w.id });
    expect((await reload(w.id)).status).toBe("live");
    const s = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "simulive", startsAt: hoursFromNow(-2) }, { published: true });
    await twiceSame("webinar.sync_status", { webinarId: s.id });
    expect((await reload(s.id)).status).toBe("ended");
  });

  it("webinar.fetch_recording (processed: recording and duration; unknown id: video_not_found)", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, status: "ended", liveEndedAt: hoursFromNow(-1) }, { published: true });
    fake.markProcessed(FAKE_VIDEO_ID, 3480);
    const { first } = await twiceSame("webinar.fetch_recording", { webinarId: w.id });
    expect(first).toEqual({ processed: true, durationSec: 3480 });
    expect(await reload(w.id)).toMatchObject({ recordingVideoId: FAKE_VIDEO_ID, durationSec: 3480 });

    const od = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "on_demand", recordingVideoId: "unknownvid1" });
    await twiceSame("webinar.fetch_recording", { webinarId: od.id, videoId: "unknownvid1", field: "recording_video_id" });
    expect((await reload(od.id)).broadcastError).toBe("video_not_found");
    fake.addVideo("unknownvid1", { processed: false });
    expect((await runJobTwice(h.db, "webinar.fetch_recording", { webinarId: od.id, videoId: "unknownvid1", field: "recording_video_id" })).second).toEqual({ processed: false });
  });

  it("webinar.notify_registrants (one email per registrant, chunks of 200)", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, status: "cancelled" });
    const regs = await Promise.all([1, 2, 3].map(() => makeRegistration(h.db, { webinarId: w.id, locale: "fr-BE" })));
    const payload = { webinarId: w.id, reason: "cancelled", version: 1, chunk: 0 };
    const { first, second } = await twiceSame("webinar.notify_registrants", payload);
    expect(first).toEqual({ sent: 3, chunk: 0 });
    expect(second).toEqual({ sent: 3, chunk: 0 });
    const rows = await h.db.select().from(emailMessages).where(sql`${emailMessages.idempotencyKey} like ${`webinar_reg:%:notice:cancelled:v1`}`);
    const mine = rows.filter((m) => regs.some((r) => m.idempotencyKey === `webinar_reg:${r.id}:notice:cancelled:v1`));
    expect(mine).toHaveLength(3);
    expect(mine[0]).toMatchObject({ locale: "fr-BE", context: { webinar_id: w.id } });
    expect(NOTIFY_CHUNK).toBe(200);
  });

  it("webinar.scan_live and webinar.scan_recordings enqueue the per-webinar jobs once per minute key", async () => {
    const soon = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: hoursFromNow(0.25) }, { published: true });
    const later = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: hoursFromNow(5) }, { published: true });
    const recording = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "on_demand", recordingVideoId: FAKE_VIDEO_ID });
    const now = new Date();
    await runJobTwice(h.db, "webinar.scan_live", {});
    await runJobTwice(h.db, "webinar.scan_recordings", {});
    const keys = (await h.db.select({ key: jobsTable.idempotencyKey }).from(jobsTable)).map((j) => j.key);
    const minute = jobKeys.status(soon.id, now).split(":status:")[1]!.slice(0, 13);
    expect(keys.filter((k) => k.startsWith(`webinar:${soon.id}:status:${minute}`))).toHaveLength(1);
    expect(keys.some((k) => k.startsWith(`webinar:${later.id}:status:`))).toBe(false);
    expect(keys.filter((k) => k.startsWith(`webinar:${recording.id}:recording:`))).toHaveLength(1);
    const direct = await runScanLive(makeJobCtx(h.db, "webinar.scan_live", { now: hoursFromNow(4.8) }));
    expect(direct.enqueued).toBeGreaterThanOrEqual(2);
    expect((await runScanRecordings(makeJobCtx(h.db, "webinar.scan_recordings", { now: hoursFromNow(72) }))).enqueued).toBe(0);
  });
});
