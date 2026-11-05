/**
 * Heartbeats and watch time (webinar-P4; spec rules 21-28, edge cases 1-5): server-clock live
 * positions, capped replay spans, the 10 s spacing per view and the per-registration buckets
 * (heartbeat 8/min, state 30/min, never the per-IP rule), two tabs serialised by the registration
 * row lock, mute and block, mode changes, `webinar.started` once per mode, the attended and
 * watched facts once each and per mode, and the viewer resolver (token of another webinar,
 * revoked link). "Now" is pinned (CONVENTIONS item 11): every call gets an explicit instant, and
 * the route tests fake only `Date`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, rateLimits, watchSegments, webinarInteractions, webinarRegistrations, webinars } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";
import { WEBINAR_LIMITS, mergeIntervals, type HeartbeatInput, type WatchMode } from "@beam/core/webinar";
import { and, eq, setAppDb, sql } from "@/lib/ctx";
import { apiRequestFor, checkRateLimits } from "@/lib/rate-limit";
import { POST as heartbeatRoute } from "@/app/api/webinar/heartbeat/route";
import { POST as viewRoute } from "@/app/api/webinar/view/route";
import { heartbeatSpans, makeRegistration, makeSegments, makeWebinar, type RegistrationRow, type WebinarRow } from "./test/factories";
import { TOKEN_HEADER, resolveViewer, type Viewer } from "./server/viewer";
import { heartbeatStatus, isViewRefusal, recordHeartbeat, startView, type ViewStart } from "./server/watch";

let h: DbHandle;
let ownerId: string;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  ownerId = (await makeUser(h.db)).id;
}, 120_000);
afterAll(async () => {
  setAppDb(undefined);
  await h.close();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A pinned instant: a Tuesday evening in March (no DST change nearby). */
const T0 = new Date("2026-03-10T19:00:00.000Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

/** A live webinar that went live at T0. */
const liveWebinar = (o: Partial<WebinarRow> = {}) =>
  makeWebinar(h.db, { ownerUserId: ownerId, startsAt: T0, status: "live", liveStartedAt: T0, ...o }, { published: true });
/** A live webinar that ended an hour before T0, with its recording (one hour). */
const endedWebinar = (o: Partial<WebinarRow> = {}) =>
  liveWebinar({
    startsAt: at(-7200),
    liveStartedAt: at(-7200),
    status: "ended",
    liveEndedAt: at(-3600),
    recordingVideoId: "rec_video01",
    durationSec: 3600,
    ...o,
  });

const viewerOf = async (r: { id: string }): Promise<Viewer> => {
  const [row] = await h.db
    .select({ r: webinarRegistrations, w: webinars })
    .from(webinarRegistrations)
    .innerJoin(webinars, eq(webinars.id, webinarRegistrations.webinarId))
    .where(eq(webinarRegistrations.id, r.id));
  return { registration: row!.r, webinar: row!.w, via: "token" };
};
const inTx = <T>(fn: (tx: Tx) => Promise<T>) => h.db.transaction(fn);
const view = async (r: { id: string }, now: Date): Promise<ViewStart> => {
  const v = await viewerOf(r);
  const out = await inTx((tx) => startView(tx, v, now));
  if (isViewRefusal(out)) throw new Error(`view refused: ${out.error}`);
  return out;
};
const beat = async (r: { id: string; webinarId: string }, viewId: string, mode: WatchMode, now: Date, o: Partial<HeartbeatInput> = {}) => {
  const v = await viewerOf(r);
  return inTx((tx) => recordHeartbeat(tx, v, { webinarId: r.webinarId, viewId, mode, fromSec: 0, toSec: 0, state: "playing", ...o }, now));
};
const segmentsOf = (r: { id: string }) => h.db.select().from(watchSegments).where(eq(watchSegments.registrationId, r.id));
const eventsOf = (r: { id: string }) =>
  h.db.select().from(activityEvents).where(and(eq(activityEvents.refType, "webinar_registration"), eq(activityEvents.refId, r.id)));
const factsOf = async (r: { id: string }) =>
  (await eventsOf(r))
    .filter((e) => e.kind === "webinar.attended" || e.kind === "webinar.watched")
    .map((e) => `${e.mode}:${e.kind === "webinar.attended" ? "attended" : (e.data as { threshold: string }).threshold}`)
    .sort();

describe("positions and spans (rule 24, edge cases 1, 3)", () => {
  it("live positions come from the server clock; client values are ignored (a viewer 20 minutes late)", async () => {
    const w = await liveWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const v = await view(r, at(1200));
    expect(v).toMatchObject({ mode: "live", controls: false, videoId: w.youtubeVideoId });
    const out = await beat(r, v.viewId, "live", at(1215), { fromSec: 0, toSec: 86_000 });
    expect(out).toMatchObject({ ok: true, segment: { fromSec: 1200, toSec: 1215 } });
    expect((await segmentsOf(r)).map((s) => [s.fromSec, s.toSec])).toEqual([[1200, 1215]]);
  });

  it("replay spans are capped by the elapsed time + 5 s and by 30 s", async () => {
    const w = await endedWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const v = await view(r, at(0));
    expect(v).toMatchObject({ mode: "replay", controls: true, videoId: "rec_video01" });
    expect(await beat(r, v.viewId, "replay", at(15), { fromSec: 0, toSec: 3000 })).toMatchObject({ segment: { fromSec: 2980, toSec: 3000 } });
    expect(await beat(r, v.viewId, "replay", at(75), { fromSec: 3000, toSec: 3500 })).toMatchObject({ segment: { fromSec: 3470, toSec: 3500 } });
    expect(await beat(r, v.viewId, "replay", at(90), { fromSec: 3500, toSec: 99_999 })).toMatchObject({ segment: { fromSec: 3580, toSec: 3600 } });
  });

  it("paused, buffering and ended write no segment; ended writes the `ended` interaction once", async () => {
    const w = await endedWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const v = await view(r, at(0));
    expect(await beat(r, v.viewId, "replay", at(15), { fromSec: 0, toSec: 15, state: "paused" })).toMatchObject({ ok: true, segment: null });
    expect(await beat(r, v.viewId, "replay", at(30), { fromSec: 0, toSec: 15, state: "buffering" })).toMatchObject({ ok: true, segment: null });
    await beat(r, v.viewId, "replay", at(45), { fromSec: 0, toSec: 15, state: "ended" });
    await beat(r, v.viewId, "replay", at(60), { fromSec: 0, toSec: 15, state: "ended" });
    expect(await segmentsOf(r)).toHaveLength(0);
    const ended = await h.db.select().from(webinarInteractions).where(and(eq(webinarInteractions.registrationId, r.id), eq(webinarInteractions.kind, "ended")));
    expect(ended).toHaveLength(1);
  });
});

describe("spacing and buckets (rule 25, edge case 2)", () => {
  it("two heartbeats of one view within 10 s: the second is 429 and writes nothing", async () => {
    const w = await liveWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const v = await view(r, at(100));
    expect(await beat(r, v.viewId, "live", at(115))).toMatchObject({ ok: true });
    const second = await beat(r, v.viewId, "live", at(115 + WEBINAR_LIMITS.minHeartbeatSpacingSec - 1));
    expect(second).toMatchObject({ ok: false, error: "too_soon" });
    expect(heartbeatStatus(second)).toBe(429);
    expect(await segmentsOf(r)).toHaveLength(1);
    expect(await beat(r, v.viewId, "live", at(130))).toMatchObject({ ok: true, segment: { fromSec: 115, toSec: 130 } });
  });

  it("the route: a ninth heartbeat of one registration in a minute is 429", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(600));
    const w = await liveWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      const v = await viewOverRoute(r);
      statuses.push((await heartbeatOverRoute(r, v.viewId, "10.0.0.1")).status);
    }
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(200));
    expect(statuses[8]).toBe(429);
  });

  it("24 state polls of one registration in a minute pass and the 31st is 429 (bucket webinar_state)", async () => {
    const regId = randomUUID();
    const now = at(3000);
    const verdicts: boolean[] = [];
    for (let i = 0; i < 31; i++) verdicts.push((await checkRateLimits(h.db, apiRequestFor("/api/webinar/state", "10.0.0.2", regId), now)).ok);
    expect(verdicts.slice(0, 24).every(Boolean)).toBe(true);
    expect(verdicts.slice(0, 30).every(Boolean)).toBe(true);
    expect(verdicts[30]).toBe(false);
  });

  it("neither route counts against the per-IP bucket: 31 registrations behind one IP all pass", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(900));
    const w = await liveWebinar();
    const ip = "198.51.100.7";
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const r = await makeRegistration(h.db, { webinarId: w.id });
      const v = await viewOverRoute(r);
      statuses.push((await heartbeatOverRoute(r, v.viewId, ip)).status);
    }
    expect(statuses).toEqual(Array(31).fill(200));
    for (let i = 0; i < 31; i++) expect((await checkRateLimits(h.db, apiRequestFor("/api/webinar/state", ip, `reg-${i}`), at(900))).ok).toBe(true);
    const perIp = await h.db.select().from(rateLimits).where(sql`${rateLimits.key} like ${`%${ip}%`}`);
    expect(perIp).toEqual([]);
  });

  it("two tabs heartbeating concurrently write both segments and exactly one `15m` (row lock)", async () => {
    const w = await liveWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    await makeSegments(h.db, r, "live", heartbeatSpans(0, 885), { recordedAt: at(0) });
    const a = await view(r, at(885));
    const b = await view(r, at(885));
    const [x, y] = await Promise.all([beat(r, a.viewId, "live", at(900)), beat(r, b.viewId, "live", at(900))]);
    expect(x.ok && y.ok).toBe(true);
    expect((await segmentsOf(r)).filter((s) => s.viewId === a.viewId || s.viewId === b.viewId)).toHaveLength(2);
    expect((await factsOf(r)).filter((f) => f === "live:15m")).toHaveLength(1);
    expect((await factsOf(r)).filter((f) => f === "live:attended")).toHaveLength(1);
  });
});

describe("access during a view (rules 21, 22, edge case 5)", () => {
  it("a muted registration keeps writing segments", async () => {
    const w = await liveWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id, mutedAt: at(0), mutedByUserId: ownerId });
    const v = await view(r, at(60));
    expect(v.muted).toBe(true);
    expect(await beat(r, v.viewId, "live", at(75))).toMatchObject({ ok: true, segment: { fromSec: 60, toSec: 75 } });
  });

  it("a client mode `live` after the end is 409 mode_changed; live segments stay live", async () => {
    const w = await liveWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const v = await view(r, at(60));
    await beat(r, v.viewId, "live", at(75));
    await h.db.update(webinars).set({ status: "ended", liveEndedAt: at(80), recordingVideoId: "rec_video02", durationSec: 90 }).where(eq(webinars.id, w.id));
    const out = await beat(r, v.viewId, "live", at(90));
    expect(out).toMatchObject({ ok: false, stop: "mode_changed" });
    expect(heartbeatStatus(out)).toBe(409);
    expect((await segmentsOf(r)).map((s) => s.mode)).toEqual(["live"]);
    expect((await view(r, at(120))).mode).toBe("replay");
  });

  it("a blocked registration gets 403 at its next heartbeat and at the viewer resolver", async () => {
    const w = await liveWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const v = await view(r, at(60));
    await h.db.update(webinarRegistrations).set({ status: "blocked", blockedAt: at(70), blockedByUserId: ownerId }).where(eq(webinarRegistrations.id, r.id));
    const out = await beat(r, v.viewId, "live", at(75));
    expect(out).toMatchObject({ ok: false, stop: "blocked" });
    expect(heartbeatStatus(out)).toBe(403);
    expect(await resolveViewer(tokenRequest(r.token), w.id)).toMatchObject({ error: "blocked", status: 403, message: "webinar.access.blocked" });
    const res = await heartbeatRoute(heartbeatRequest(r, v.viewId, "10.0.0.3"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, stop: "blocked" });
  });

  it("the resolver never accepts a token for another webinar, nor a revoked link", async () => {
    const w1 = await liveWebinar();
    const w2 = await liveWebinar();
    const r = await makeRegistration(h.db, { webinarId: w1.id });
    expect(await resolveViewer(tokenRequest(r.token), w1.id)).toMatchObject({ via: "token", registration: { id: r.id } });
    expect(await resolveViewer(tokenRequest(r.token), w2.id)).toMatchObject({ error: "invalid_token", status: 403 });
    await h.db.update(webinarRegistrations).set({ tokenVersion: 2 }).where(eq(webinarRegistrations.id, r.id));
    expect(await resolveViewer(tokenRequest(r.token), w1.id)).toMatchObject({ error: "invalid_token" });
    expect(await resolveViewer(new Request("http://localhost/api/webinar/view", { method: "POST" }), w1.id)).toMatchObject({ error: "unauthorized", status: 401 });
  });
});

describe("facts (rules 26-28, scenario 5)", () => {
  it("`webinar.started` once per registration per mode, one `started` interaction per view", async () => {
    const w = await liveWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    await view(r, at(60));
    await view(r, at(90));
    await h.db.update(webinars).set({ status: "ended", liveEndedAt: at(100), recordingVideoId: "rec_video03", durationSec: 3600 }).where(eq(webinars.id, w.id));
    await view(r, at(200));
    const started = (await eventsOf(r)).filter((e) => e.kind === "webinar.started");
    expect(started.map((e) => e.mode).sort()).toEqual(["live", "replay"]);
    const interactions = await h.db.select().from(webinarInteractions).where(and(eq(webinarInteractions.registrationId, r.id), eq(webinarInteractions.kind, "started")));
    expect(interactions).toHaveLength(3);
    expect(interactions[0]!.payload).toEqual({ player_notice_version: "player_notice_v1" });
  });

  it("`attended` at 300 s (not at 299 s)", async () => {
    const w = await liveWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    await makeSegments(h.db, r, "live", heartbeatSpans(0, 284), { recordedAt: at(0) });
    const v = await view(r, at(284));
    expect(await beat(r, v.viewId, "live", at(299))).toMatchObject({ facts: [] });
    expect(await beat(r, v.viewId, "live", at(310))).toMatchObject({ facts: ["attended"] });
    expect(await factsOf(r)).toEqual(["live:attended"]);
  });

  it("`15m` and `30m` once each", async () => {
    const w = await liveWebinar({ plannedDurationMinutes: 120 });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    await makeSegments(h.db, r, "live", heartbeatSpans(0, 1785), { recordedAt: at(0) });
    const v = await view(r, at(1785));
    expect((await beat(r, v.viewId, "live", at(1800))).ok).toBe(true);
    await beat(r, v.viewId, "live", at(1815));
    await beat(r, v.viewId, "live", at(1830));
    expect(await factsOf(r)).toEqual(["live:15m", "live:30m", "live:attended"]);
  });

  it("live and replay watch are kept apart: 20 min live plus 20 min replay gives `30m` in neither", async () => {
    const w = await endedWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    await makeSegments(h.db, r, "live", heartbeatSpans(0, 1200), { recordedAt: at(-7000) });
    await makeSegments(h.db, r, "replay", heartbeatSpans(1200, 2385), { recordedAt: at(-60) });
    const v = await view(r, at(0));
    await beat(r, v.viewId, "replay", at(15), { fromSec: 2385, toSec: 2400 });
    const facts = await factsOf(r);
    expect(facts).toContain("replay:15m");
    expect(facts.some((f) => f.endsWith(":30m"))).toBe(false);
    const segs = await segmentsOf(r);
    expect(mergeIntervals(segs.filter((s) => s.mode === "replay").map((s) => s)).watchedSec).toBe(1200);
  });
});

// ---------------------------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------------------------

function tokenRequest(token: string, body: unknown = {}, ip = "10.9.9.9"): Request {
  return new Request("http://localhost/api/webinar/view", {
    method: "POST",
    headers: { "content-type": "application/json", [TOKEN_HEADER]: token, "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function heartbeatRequest(r: RegistrationRow & { token: string }, viewId: string, ip: string): Request {
  return new Request("http://localhost/api/webinar/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json", [TOKEN_HEADER]: r.token, "x-forwarded-for": ip },
    body: JSON.stringify({ webinarId: r.webinarId, viewId, mode: "live", fromSec: 0, toSec: 0, state: "playing" }),
  });
}

let viewIp = 0;
/** A view started through the route (each from its own IP, so the view route's per-IP rule stays out of the way). */
async function viewOverRoute(r: RegistrationRow & { token: string }): Promise<ViewStart> {
  viewIp++;
  const res = await viewRoute(tokenRequest(r.token, { webinarId: r.webinarId }, `10.1.${Math.floor(viewIp / 250)}.${viewIp % 250}`));
  expect(res.status).toBe(200);
  return (await res.json()) as ViewStart;
}

async function heartbeatOverRoute(r: RegistrationRow & { token: string }, viewId: string, ip: string): Promise<Response> {
  return heartbeatRoute(heartbeatRequest(r, viewId, ip));
}
