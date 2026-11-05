/**
 * Pre-flight and heartbeat monitoring (webinar spec rules 42 and 43; webinar-P6): the t60 alert
 * for a live webinar without a broadcast (Slack plus an owner task), the t15 alert for lifecycle
 * `created` and none for `ready`, each alert once (every job runs twice), the simulive t60 alert
 * without a processed recording, the scan's stages, and the heartbeat-stopped alert of
 * `webinar.sync_status` firing once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { jobs as jobsTable, tasks, webinars } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";
import { eq, sql } from "@/lib/ctx";
import { makeJobCtx, resetRuntime, runJobTwice } from "@/lib/testing";
import { jobs } from "../jobs";
import { schedules } from "../schedules";
import { makeRegistration, makeSegments, makeWebinar, FAKE_VIDEO_ID } from "../test/factories";
import { preflightKeys, preflightProblem, runPreflightScan } from "./preflight";

let h: DbHandle;
let ownerId: string;
beforeAll(async () => {
  h = await createTestDb();
  ownerId = (await makeUser(h.db)).id;
}, 120_000);
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const MIN = 60_000;
const inMinutes = (m: number) => new Date(Date.now() + m * MIN);

const jobsWithKey = async (key: string) => h.db.select().from(jobsTable).where(eq(jobsTable.idempotencyKey, key));
const slackJobsFor = async (webinarId: string) =>
  h.db
    .select()
    .from(jobsTable)
    .where(sql`${jobsTable.kind} = 'notify.slack' and ${jobsTable.idempotencyKey} like ${`webinar:${webinarId}:%`}`);
const tasksFor = async (webinarId: string) => h.db.select().from(tasks).where(sql`${tasks.refType} = 'webinar' and ${tasks.refId} = ${webinarId}`);

describe("declarations", () => {
  it("declares the check, the scan job and its 5-minute schedule", () => {
    const byKind = Object.fromEntries(jobs.map((j) => [j.kind, j]));
    expect(byKind["webinar.preflight_check"]).toMatchObject({ lane: "fast", priority: 2, maxAttempts: 3 });
    expect(byKind["webinar.preflight"]).toMatchObject({ lane: "fast", priority: 2, maxAttempts: 2 });
    expect(schedules.find((s) => s.kind === "webinar.preflight")).toMatchObject({ cron: "*/5 * * * *" });
  });
});

describe("stage t60 (rule 42)", () => {
  it("a published live webinar without a broadcast alerts once in Slack and creates one owner task", async () => {
    // Publish was clicked but the broadcast does not exist yet (a published live webinar always has one).
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: inMinutes(45), publishRequestedAt: new Date() });

    const out = await runJobTwice(h.db, "webinar.preflight_check", { webinarId: w.id, stage: "t60" });
    expect(out.first).toMatchObject({ problem: "no_broadcast", alerted: true, taskCreated: true });
    expect(out.second).toMatchObject({ problem: "no_broadcast", alerted: false, taskCreated: false });

    const slack = await jobsWithKey(preflightKeys.slack(w.id, "t60", w.version));
    expect(slack).toHaveLength(1);
    expect(slack[0]!.kind).toBe("notify.slack");
    expect(slack[0]!.payload).toMatchObject({ severity: "high" });
    expect(String((slack[0]!.payload as { text: string }).text)).toContain("no YouTube broadcast");
    const owned = await tasksFor(w.id);
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ ownerUserId: ownerId, kind: "follow_up", dedupeKey: preflightKeys.task(w.id, "t60", w.version) });
  });

  it("a broadcast error alerts; a ready broadcast does not", async () => {
    const bad = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: inMinutes(50), broadcastError: "quota exceeded" }, { published: true });
    const good = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: inMinutes(50), youtubeLifecycle: "ready" }, { published: true });
    await runJobTwice(h.db, "webinar.preflight_check", { webinarId: bad.id, stage: "t60" });
    const ok = await runJobTwice(h.db, "webinar.preflight_check", { webinarId: good.id, stage: "t60" });
    expect(ok.first).toMatchObject({ problem: null, alerted: false });
    expect(await slackJobsFor(bad.id)).toHaveLength(1);
    expect(await slackJobsFor(good.id)).toEqual([]);
    expect(await tasksFor(good.id)).toEqual([]);
  });

  it("a simulive webinar without a processed recording alerts", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "simulive", startsAt: inMinutes(40) }, { published: true });
    await h.db.update(webinars).set({ durationSec: null }).where(eq(webinars.id, w.id));
    const out = await runJobTwice(h.db, "webinar.preflight_check", { webinarId: w.id, stage: "t60" });
    expect(out.first).toMatchObject({ problem: "recording_missing", alerted: true });
    expect(await slackJobsFor(w.id)).toHaveLength(1);
    expect(await tasksFor(w.id)).toHaveLength(1);

    const processed = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "simulive", startsAt: inMinutes(40), recordingVideoId: FAKE_VIDEO_ID }, { published: true });
    expect((await runJobTwice(h.db, "webinar.preflight_check", { webinarId: processed.id, stage: "t60" })).first).toMatchObject({ problem: null });
  });

  it("a webinar outside the window, a draft or one already started is not checked", () => {
    const now = new Date();
    const base = { mode: "live", status: "published", youtubeVideoId: null, broadcastError: null, recordingVideoId: null, durationSec: null, youtubeLifecycle: null, publishRequestedAt: null } as const;
    expect(preflightProblem({ ...base, startsAt: new Date(now.getTime() + 61 * MIN) }, "t60", now)).toBeNull();
    expect(preflightProblem({ ...base, startsAt: new Date(now.getTime() + 59 * MIN) }, "t60", now)).toBe("no_broadcast");
    expect(preflightProblem({ ...base, status: "draft", startsAt: new Date(now.getTime() + 30 * MIN) }, "t60", now)).toBeNull();
    expect(preflightProblem({ ...base, status: "draft", broadcastError: "forbidden", startsAt: new Date(now.getTime() + 30 * MIN) }, "t60", now)).toBe("no_broadcast");
    expect(preflightProblem({ ...base, startsAt: new Date(now.getTime() - MIN) }, "t60", now)).toBeNull();
    expect(preflightProblem({ ...base, mode: "simulive", startsAt: new Date(now.getTime() + 10 * MIN) }, "t15", now)).toBeNull();
  });
});

describe("stage t15 (rule 42, edge case 24)", () => {
  it("lifecycle `created` 15 minutes before the start alerts once ('stream not connected'), without a task", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: inMinutes(12), youtubeLifecycle: "created" }, { published: true });
    const out = await runJobTwice(h.db, "webinar.preflight_check", { webinarId: w.id, stage: "t15" });
    expect(out.first).toMatchObject({ problem: "stream_not_connected", alerted: true, taskCreated: false });
    expect(out.second).toMatchObject({ alerted: false });
    const slack = await jobsWithKey(preflightKeys.slack(w.id, "t15", w.version));
    expect(slack).toHaveLength(1);
    expect(String((slack[0]!.payload as { text: string }).text)).toContain("stream not connected");
    expect(await tasksFor(w.id)).toEqual([]);
  });

  it("lifecycle `ready` (or testing, live) does not alert", async () => {
    for (const lifecycle of ["ready", "testing", "live"]) {
      const w = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: inMinutes(10), youtubeLifecycle: lifecycle }, { published: true });
      const out = await runJobTwice(h.db, "webinar.preflight_check", { webinarId: w.id, stage: "t15" });
      expect(out.first, lifecycle).toMatchObject({ problem: null, alerted: false });
      expect(await slackJobsFor(w.id)).toEqual([]);
    }
  });

  it("a rescheduled webinar (new version) is checked again", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: inMinutes(12), youtubeLifecycle: "created" }, { published: true });
    await runJobTwice(h.db, "webinar.preflight_check", { webinarId: w.id, stage: "t15" });
    await h.db.update(webinars).set({ version: w.version + 1 }).where(eq(webinars.id, w.id));
    await runJobTwice(h.db, "webinar.preflight_check", { webinarId: w.id, stage: "t15" });
    expect(await slackJobsFor(w.id)).toHaveLength(2);
  });
});

describe("the scan `webinar.preflight`", () => {
  it("enqueues t60 within 60 minutes and t15 too within 15 minutes; a second scan in the same minute adds nothing", async () => {
    const now = new Date();
    const at = (m: number) => new Date(now.getTime() + m * MIN);
    const soon = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: at(10) }, { published: true });
    const later = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: at(55) }, { published: true });
    const far = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: at(90) }, { published: true });
    const draft = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: at(10) });
    const failed = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: at(30), broadcastError: "forbidden" });
    const od = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "on_demand", startsAt: null }, { published: true });

    const scan = async () => h.db.transaction((tx) => runPreflightScan(makeJobCtx(h.db, "webinar.preflight", { tx, now })));
    await scan();
    await scan();
    const checks = await h.db.select().from(jobsTable).where(eq(jobsTable.kind, "webinar.preflight_check"));
    const stagesOf = (id: string) =>
      checks
        .filter((j) => (j.payload as { webinarId: string }).webinarId === id)
        .map((j) => (j.payload as { stage: string }).stage)
        .sort();
    expect(stagesOf(soon.id)).toEqual(["t15", "t60"]);
    expect(stagesOf(later.id)).toEqual(["t60"]);
    expect(stagesOf(far.id)).toEqual([]);
    expect(stagesOf(draft.id)).toEqual([]);
    expect(stagesOf(failed.id)).toEqual(["t60"]);
    expect(stagesOf(od.id)).toEqual([]);
  });
});

describe("heartbeat-stopped alert (rule 43)", () => {
  it("a webinar live for 20 minutes whose last live segment is 10 minutes old alerts once", async () => {
    const started = inMinutes(-20);
    const w = await makeWebinar(
      h.db,
      { ownerUserId: ownerId, mode: "simulive", startsAt: started, status: "live", liveStartedAt: started, recordingVideoId: FAKE_VIDEO_ID, durationSec: 3600 },
      { published: true },
    );
    await h.db.update(webinars).set({ status: "live" }).where(eq(webinars.id, w.id));
    const r = await makeRegistration(h.db, { webinarId: w.id });
    await makeSegments(h.db, r, "live", [
      [0, 15],
      [15, 30],
    ], { recordedAt: inMinutes(-10) });

    const out = await runJobTwice(h.db, "webinar.sync_status", { webinarId: w.id });
    expect(out.first).toMatchObject({ status: "live", heartbeatAlert: true });
    expect(out.second).not.toHaveProperty("heartbeatAlert");
    const alerts = await jobsWithKey(preflightKeys.heartbeat(w.id, w.version));
    expect(alerts).toHaveLength(1);
    expect(String((alerts[0]!.payload as { text: string }).text)).toContain("heartbeats are failing");
  });

  it("recent segments, no segments at all, or a webinar live for less than 5 minutes do not alert", async () => {
    const make = async (startedMinAgo: number) => {
      const started = inMinutes(-startedMinAgo);
      const w = await makeWebinar(
        h.db,
        { ownerUserId: ownerId, mode: "simulive", startsAt: started, liveStartedAt: started, recordingVideoId: FAKE_VIDEO_ID, durationSec: 3600 },
        { published: true },
      );
      await h.db.update(webinars).set({ status: "live" }).where(eq(webinars.id, w.id));
      return w;
    };
    const fresh = await make(20);
    const rf = await makeRegistration(h.db, { webinarId: fresh.id });
    await makeSegments(h.db, rf, "live", [[1185, 1200]], { recordedAt: inMinutes(-1) });
    const silent = await make(20);
    const young = await make(4);
    const ry = await makeRegistration(h.db, { webinarId: young.id });
    await makeSegments(h.db, ry, "live", [[0, 15]], { recordedAt: inMinutes(-3.5) });

    for (const w of [fresh, silent, young]) {
      await runJobTwice(h.db, "webinar.sync_status", { webinarId: w.id });
      expect(await slackJobsFor(w.id)).toEqual([]);
    }
  });
});
