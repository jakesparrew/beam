/**
 * `webinar.finalise` (webinar-P4; spec rule 29, edge cases 8 and 22) and its scan: no-shows only
 * for live registrants without live attendance (a 4-minute live viewer is a no-show at the
 * default 300 s; replay viewers still no-show for live), back-filled live thresholds, the wait for
 * the recording (deferred, then at 48 h with `replay_available = false`), `replay_available =
 * true` once the YouTube fake marks the recording processed, never-live (no no-show, a task for
 * the owner), and a double run that leaves the same state. Pinned instants throughout, except the
 * job double run, whose runner uses the wall clock (all times there are relative to it).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, jobs as jobsTable, tasks, webinars } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";
import { createYouTubeFake, type FakeYouTube } from "@beam/integrations/youtube";
import { and, eq, inArray, sql } from "@/lib/ctx";
import { makeCtx, makeJobCtx, resetRuntime, runJobTwice } from "@/lib/testing";
import { runFetchRecording, setYouTubeClient } from "./jobs";
import { runScanFinalise, schedules } from "./schedules";
import { jobKeys } from "./server/lifecycle";
import { finaliseWebinar } from "./server/watch";
import { heartbeatSpans, makeRegistration, makeSegments, makeWebinar, type WebinarRow } from "./test/factories";

let h: DbHandle;
let ownerId: string;
let fake: FakeYouTube;

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
});

const T0 = new Date("2026-05-12T20:00:00.000Z");
const min = (m: number) => new Date(T0.getTime() + m * 60_000);

/** A live webinar that went live at -120 min and ended at -60 min. */
const endedLive = (o: Partial<WebinarRow> = {}) =>
  makeWebinar(
    h.db,
    { ownerUserId: ownerId, startsAt: min(-120), status: "ended", liveStartedAt: min(-120), liveEndedAt: min(-60), recordingVideoId: "rec_final01", durationSec: 3600, ...o },
    { published: true },
  );
const reload = async (id: string) => (await h.db.select().from(webinars).where(eq(webinars.id, id)))[0]!;
const ctx = (now: Date) => makeCtx(h.db, { now });
const finalise = (w: { id: string }, now: Date) => finaliseWebinar(h.db as never, ctx(now), w.id, now);
const eventsOf = (ids: string[], kind: string) =>
  h.db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.kind, kind), eq(activityEvents.refType, "webinar_registration"), inArray(activityEvents.refId, ids)));

describe("no-shows (rule 29)", () => {
  it("only live registrants without live attendance; a 4-minute viewer is a no-show; replay viewers still no-show for live", async () => {
    const w = await endedLive();
    const absent = await makeRegistration(h.db, { webinarId: w.id });
    const fourMinutes = await makeRegistration(h.db, { webinarId: w.id });
    await makeSegments(h.db, fourMinutes, "live", heartbeatSpans(0, 240), { recordedAt: min(-110) });
    const sixMinutes = await makeRegistration(h.db, { webinarId: w.id });
    await makeSegments(h.db, sixMinutes, "live", heartbeatSpans(600, 960), { recordedAt: min(-100) });
    const replayOnly = await makeRegistration(h.db, { webinarId: w.id });
    await makeSegments(h.db, replayOnly, "replay", heartbeatSpans(0, 1200), { recordedAt: min(-30) });
    const lateReplayReg = await makeRegistration(h.db, { webinarId: w.id, registeredMode: "replay" });
    const cancelled = await makeRegistration(h.db, { webinarId: w.id, status: "cancelled" });
    const ids = [absent, fourMinutes, sixMinutes, replayOnly, lateReplayReg, cancelled].map((r) => r.id);

    const out = await finalise(w, min(0));
    expect(out).toEqual({ noShows: 3, backfilled: 1 });
    const noShows = await eventsOf(ids, "webinar.no_show");
    expect(noShows.map((e) => e.refId).sort()).toEqual([absent.id, fourMinutes.id, replayOnly.id].sort());
    expect(noShows.every((e) => e.mode === "live")).toBe(true);
    expect(noShows[0]!.data).toMatchObject({ webinar_id: w.id, replay_available: true, replay_until_at: null });
    const attended = await eventsOf(ids, "webinar.attended");
    expect(attended.map((e) => [e.refId, e.mode])).toEqual([[sixMinutes.id, "live"]]);
    expect((await reload(w.id)).finalisedAt).toEqual(min(0));
  });

  it("back-fills only what the real duration makes reachable and never retracts", async () => {
    const w = await endedLive({ durationSec: 1500 });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    await makeSegments(h.db, r, "live", heartbeatSpans(0, 1450), { recordedAt: min(-90) });
    expect(await finalise(w, min(0))).toEqual({ noShows: 0, backfilled: 4 });
    const watched = await eventsOf([r.id], "webinar.watched");
    expect(watched.map((e) => (e.data as { threshold: string }).threshold).sort()).toEqual(["15m", "50pct", "end"]);
  });

  it("waits 30 minutes after the end", async () => {
    const w = await endedLive({ liveEndedAt: min(-10) });
    await makeRegistration(h.db, { webinarId: w.id });
    expect(await finalise(w, min(0))).toEqual({ deferred: "not_ended" });
    expect((await reload(w.id)).finalisedAt).toBeNull();
  });
});

describe("the recording (rule 29, edge case 22)", () => {
  it("defers while the recording is unknown, then runs at 48 h with replay_available = false", async () => {
    const w = await endedLive({ recordingVideoId: null, durationSec: null, liveEndedAt: min(-60) });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    expect(await finalise(w, min(0))).toEqual({ deferred: "replay_unknown" });
    expect(await eventsOf([r.id], "webinar.no_show")).toHaveLength(0);
    expect((await reload(w.id)).finalisedAt).toBeNull();

    const at48h = min(-60 + 48 * 60);
    expect(await finalise(w, at48h)).toEqual({ noShows: 1, backfilled: 0 });
    expect((await eventsOf([r.id], "webinar.no_show"))[0]!.data).toMatchObject({ replay_available: false, replay_until_at: null });
  });

  it("replay_available = true once the fake marks the recording processed", async () => {
    const w = await endedLive({ recordingVideoId: null, durationSec: null, replayUntilAt: min(60 * 24 * 7) });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    fake.markProcessed(w.youtubeVideoId!, 3550);
    await runFetchRecording(makeJobCtx(h.db, "webinar.fetch_recording", { now: min(0) }), { webinarId: w.id });
    expect(await reload(w.id)).toMatchObject({ recordingVideoId: w.youtubeVideoId, durationSec: 3550 });
    expect(await finalise(w, min(1))).toEqual({ noShows: 1, backfilled: 0 });
    expect((await eventsOf([r.id], "webinar.no_show"))[0]!.data).toMatchObject({ replay_available: true, replay_until_at: min(60 * 24 * 7).toISOString() });
  });

  it("a disabled replay is known at once", async () => {
    const w = await endedLive({ recordingVideoId: null, durationSec: null, isReplayEnabled: false });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    expect(await finalise(w, min(0))).toEqual({ noShows: 1, backfilled: 0 });
    expect((await eventsOf([r.id], "webinar.no_show"))[0]!.data).toMatchObject({ replay_available: false });
  });
});

describe("never live (edge case 8)", () => {
  it("writes no no-show, sets broadcast_error = 'never_live' and creates one task for the owner", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: min(-121) }, { published: true });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    expect(await finalise(w, min(-122 + 60))).toEqual({ deferred: "not_ended" });
    expect(await finalise(w, min(0))).toEqual({ noShows: 0, backfilled: 0 });
    expect(await finalise(w, min(5))).toEqual({ noShows: 0, backfilled: 0 });
    expect(await eventsOf([r.id], "webinar.no_show")).toHaveLength(0);
    expect(await reload(w.id)).toMatchObject({ broadcastError: "never_live", finalisedAt: min(0) });
    const t = await h.db.select().from(tasks).where(eq(tasks.dedupeKey, `webinar_never_live:${w.id}:v${w.version}`));
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ ownerUserId: ownerId, kind: "follow_up", source: "system", status: "open" });
  });
});

describe("the job and its scan", () => {
  it("declares webinar.finalise and the 5-minute scan", async () => {
    const { jobs } = await import("./jobs");
    expect(jobs.find((j) => j.kind === "webinar.finalise")).toMatchObject({ lane: "fast", priority: 5, maxAttempts: 6 });
    expect(schedules.find((s) => s.kind === "webinar.scan_finalise")).toMatchObject({ cron: "*/5 * * * *" });
  });

  it("the scan enqueues ended webinars whose replay is known and never-live ones, with the versioned key", async () => {
    const now = new Date();
    const ago = (m: number) => new Date(now.getTime() - m * 60_000);
    const ready = await endedLive({ startsAt: ago(180), liveStartedAt: ago(180), liveEndedAt: ago(60) });
    const tooSoon = await endedLive({ startsAt: ago(100), liveStartedAt: ago(100), liveEndedAt: ago(10) });
    const waiting = await endedLive({ startsAt: ago(180), liveStartedAt: ago(180), liveEndedAt: ago(60), recordingVideoId: null, durationSec: null });
    const neverLive = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: ago(150) }, { published: true });
    const done = await endedLive({ startsAt: ago(180), liveStartedAt: ago(180), liveEndedAt: ago(60), finalisedAt: ago(5) });
    await runScanFinalise(makeJobCtx(h.db, "webinar.scan_finalise", { now }));
    const keys = (await h.db.select({ k: jobsTable.idempotencyKey }).from(jobsTable).where(sql`${jobsTable.kind} = 'webinar.finalise'`)).map((j) => j.k);
    expect(keys).toEqual(expect.arrayContaining([jobKeys.finalise(ready.id, ready.version), jobKeys.finalise(neverLive.id, neverLive.version)]));
    for (const w of [tooSoon, waiting, done]) expect(keys.some((k) => k.startsWith(`webinar:${w.id}:`))).toBe(false);
  });

  it("a double run leaves the same state", async () => {
    const now = new Date();
    const ago = (m: number) => new Date(now.getTime() - m * 60_000);
    const w = await endedLive({ startsAt: ago(180), liveStartedAt: ago(180), liveEndedAt: ago(60) });
    const regs = [await makeRegistration(h.db, { webinarId: w.id }), await makeRegistration(h.db, { webinarId: w.id })];
    await makeSegments(h.db, regs[1]!, "live", heartbeatSpans(0, 960), { recordedAt: ago(170) });
    const snapshot = async () => ({
      webinar: (({ updatedAt: _u, ...rest }) => rest)(await reload(w.id)),
      events: (await h.db.select({ k: activityEvents.dedupeKey }).from(activityEvents).where(inArray(activityEvents.refId, regs.map((r) => r.id)))).map((e) => e.k).sort(),
    });
    let first: unknown;
    const out = await runJobTwice(h.db, "webinar.finalise", { webinarId: w.id }, { between: async () => void (first = await snapshot()) });
    expect(out.first).toEqual({ noShows: 1, backfilled: 2 });
    expect(await snapshot()).toEqual(first);
  });
});
