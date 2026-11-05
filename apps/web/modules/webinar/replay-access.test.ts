/**
 * Replay and on-demand access (webinar-P4; spec rules 22, 23, 30-32, edge cases 12 and 13): a
 * view counts once per 30 minutes (a reload does not), the view limit refuses a new view but not a
 * reload, expiry stops the next heartbeat and keeps the segments, on-demand days end access, the
 * countdown and the "ended" state, and a simulive showing starts at `now - starts_at` without seek
 * controls. "Now" is pinned (CONVENTIONS item 11).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { watchSegments, webinarRegistrations, webinars } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";
import { deriveCtaKey, verifyCtaClick } from "@beam/core/webinar";
import { webinarAuthSecret } from "@beam/email/templates/webinar";
import { eq, setAppDb } from "@/lib/ctx";
import { makeCta, makePoll, makeRegistration, makeWebinar, type WebinarRow } from "./test/factories";
import type { Viewer } from "./server/viewer";
import { isViewRefusal, recordHeartbeat, startView, type ViewRefusal, type ViewStart } from "./server/watch";

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

const T0 = new Date("2026-04-14T18:00:00.000Z");
const min = (m: number) => new Date(T0.getTime() + m * 60_000);
const sec = (s: number) => new Date(T0.getTime() + s * 1000);

const ended = (o: Partial<WebinarRow> = {}) =>
  makeWebinar(
    h.db,
    {
      ownerUserId: ownerId,
      startsAt: min(-180),
      status: "ended",
      liveStartedAt: min(-180),
      liveEndedAt: min(-120),
      recordingVideoId: "rec_replay1",
      durationSec: 3600,
      ...o,
    },
    { published: true },
  );

const viewerOf = async (id: string): Promise<Viewer> => {
  const [row] = await h.db
    .select({ r: webinarRegistrations, w: webinars })
    .from(webinarRegistrations)
    .innerJoin(webinars, eq(webinars.id, webinarRegistrations.webinarId))
    .where(eq(webinarRegistrations.id, id));
  return { registration: row!.r, webinar: row!.w, via: "session" };
};
const start = async (r: { id: string }, now: Date): Promise<ViewStart | ViewRefusal> => {
  const v = await viewerOf(r.id);
  return h.db.transaction((tx: Tx) => startView(tx, v, now));
};
const started = async (r: { id: string }, now: Date): Promise<ViewStart> => {
  const out = await start(r, now);
  if (isViewRefusal(out)) throw new Error(`refused: ${out.error}`);
  return out;
};

describe("view counting and the view limit (rule 31, edge case 12)", () => {
  it("a view counts once per 30 minutes; the limit refuses a new view, not a reload", async () => {
    const w = await ended({ replayViewLimit: 2 });
    const r = await makeRegistration(h.db, { webinarId: w.id, registeredMode: "replay" });
    expect(await started(r, min(0))).toMatchObject({ mode: "replay", counted: true, viewsLeft: 1 });
    expect(await started(r, min(10))).toMatchObject({ counted: false, viewsLeft: 1 });
    expect(await started(r, min(45))).toMatchObject({ counted: true, viewsLeft: 0 });
    expect(await started(r, min(50))).toMatchObject({ counted: false, viewsLeft: 0 });
    expect(await start(r, min(90))).toEqual({ error: "limit_reached" });
  });

  it("an open tab keeps playing after the limit is reached in another tab", async () => {
    const w = await ended({ replayViewLimit: 1 });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const a = await started(r, min(0));
    expect(await start(r, min(40))).toEqual({ error: "limit_reached" });
    const v = await viewerOf(r.id);
    const out = await h.db.transaction((tx: Tx) =>
      recordHeartbeat(tx, v, { webinarId: w.id, viewId: a.viewId, mode: "replay", fromSec: 100, toSec: 115, state: "playing" }, min(40)),
    );
    expect(out).toMatchObject({ ok: true, segment: { fromSec: 100, toSec: 115 } });
  });

  it("without a limit every view is allowed and viewsLeft is null", async () => {
    const w = await ended();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    for (const m of [0, 40, 80, 120]) expect(await started(r, min(m))).toMatchObject({ counted: true, viewsLeft: null });
  });
});

describe("expiry (rules 30, 32, edge case 13)", () => {
  it("expiry during a view: the next heartbeat returns stop 'expired'; segments up to then are kept", async () => {
    const w = await ended({ replayUntilAt: sec(20) });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const v = await started(r, sec(0));
    const viewer = await viewerOf(r.id);
    const beat = (s: number, from: number, to: number) =>
      h.db.transaction((tx: Tx) => recordHeartbeat(tx, viewer, { webinarId: w.id, viewId: v.viewId, mode: "replay", fromSec: from, toSec: to, state: "playing" }, sec(s)));
    expect(await beat(15, 0, 15)).toMatchObject({ ok: true });
    expect(await beat(30, 15, 30)).toEqual({ ok: false, stop: "expired", nextMs: 15_000 });
    expect((await h.db.select().from(watchSegments).where(eq(watchSegments.registrationId, r.id))).map((s) => [s.fromSec, s.toSec])).toEqual([[0, 15]]);
    expect(await start(r, sec(40))).toEqual({ error: "expired" });
  });

  it("on-demand access ends `on_demand_access_days` after registering", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "on_demand", onDemandAccessDays: 7 }, { published: true });
    const fresh = await makeRegistration(h.db, { webinarId: w.id, registeredMode: "on_demand", createdAt: min(-60 * 24 * 6) });
    const old = await makeRegistration(h.db, { webinarId: w.id, registeredMode: "on_demand", createdAt: min(-60 * 24 * 8) });
    expect(await started(fresh, min(0))).toMatchObject({ mode: "on_demand", controls: true });
    expect(await start(old, min(0))).toEqual({ error: "expired" });
  });

  it("a replay that is disabled or not recorded is 'ended'", async () => {
    const off = await ended({ isReplayEnabled: false });
    expect(await start(await makeRegistration(h.db, { webinarId: off.id }), min(0))).toEqual({ error: "ended" });
  });
});

describe("before and during the showing (rules 22, 23)", () => {
  it("before starts_at - 15 min the player shows the countdown; after it, waiting for the host", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: min(60) }, { published: true });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    expect(await start(r, min(0))).toEqual({ error: "not_started", startsAt: min(60), countdown: true });
    expect(await start(r, min(50))).toEqual({ error: "not_started", startsAt: min(60), countdown: false });
  });

  it("a blocked or cancelled registration is refused", async () => {
    const w = await ended();
    const blocked = await makeRegistration(h.db, { webinarId: w.id, status: "blocked", blockedByUserId: ownerId });
    const cancelled = await makeRegistration(h.db, { webinarId: w.id, status: "cancelled" });
    expect(await start(blocked, min(0))).toEqual({ error: "blocked" });
    expect(await start(cancelled, min(0))).toEqual({ error: "cancelled" });
  });

  it("simulive is presented as live: starts at now - starts_at, no seek controls, timed polls and signed CTAs", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "simulive", startsAt: min(-10) }, { published: true });
    await makePoll(h.db, { webinarId: w.id, showAtSec: 300 });
    await makePoll(h.db, { webinarId: w.id, showAtSec: null });
    const cta = await makeCta(h.db, { webinarId: w.id, showAtSec: 900 });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const v = await started(r, min(0));
    expect(v).toMatchObject({ mode: "live", startSec: 600, controls: false, chatEnabled: true });
    expect(v.polls).toHaveLength(1);
    expect(v.polls[0]).toMatchObject({ showAtSec: 300, question: "Slaap je goed?", options: [{ key: "yes", label: "Ja" }, { key: "no", label: "Nee" }] });
    expect(v.ctas).toHaveLength(1);
    const url = new URL(v.ctas[0]!.href, "http://localhost");
    expect(url.pathname).toBe(`/api/webinar/cta/${cta.id}`);
    expect(url.searchParams.get("r")).toBe(r.id);
    expect(url.searchParams.get("m")).toBe("live");
    expect(verifyCtaClick(deriveCtaKey(webinarAuthSecret()), r.id, cta.id, "live", url.searchParams.get("s")!)).toBe(true);
    expect(v.ctas[0]!.href).not.toContain(r.token);
  });
});
