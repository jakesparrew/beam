import { describe, expect, it } from "vitest";
import { canRegister, registeredModeFor, replayAccess, resolveMode, showsCountdown, simulivePositionSec } from "./access";
import type { WebinarState } from "./types";

const T0 = new Date("2026-11-20T19:00:00Z");
const min = (m: number) => new Date(T0.getTime() + m * 60_000);
const days = (d: number) => new Date(T0.getTime() + d * 86_400_000);

const base: WebinarState = {
  mode: "live",
  status: "published",
  startsAt: T0,
  plannedDurationMinutes: 60,
  durationSec: null,
  liveStartedAt: null,
  liveEndedAt: null,
  recordingVideoId: null,
  isReplayEnabled: true,
  isReplayGated: true,
  replayUntilAt: null,
  replayViewLimit: null,
  onDemandAccessDays: null,
};
const live = (over: Partial<WebinarState> = {}): WebinarState => ({ ...base, ...over });
const simulive = (over: Partial<WebinarState> = {}): WebinarState => ({ ...base, mode: "simulive", durationSec: 2700, recordingVideoId: "abcdefghijk", ...over });
const onDemand = (over: Partial<WebinarState> = {}): WebinarState => ({ ...base, mode: "on_demand", startsAt: null, durationSec: 1800, recordingVideoId: "abcdefghijk", ...over });

describe("resolveMode: live window (rule 22)", () => {
  it("is not_started before YouTube reports live, even after starts_at", () => {
    expect(resolveMode(live(), min(-30))).toEqual({ blocked: "not_started" });
    expect(resolveMode(live(), min(10))).toEqual({ blocked: "not_started" });
  });

  it("is live while the webinar is live, also past the planned end", () => {
    const w = live({ status: "live", liveStartedAt: min(2) });
    expect(resolveMode(w, min(5))).toEqual({ mode: "live" });
    expect(resolveMode(w, min(95))).toEqual({ mode: "live" });
  });

  it("after the end: replay once recorded, else ended_no_replay", () => {
    const ended = live({ status: "ended", liveStartedAt: min(0), liveEndedAt: min(62) });
    expect(resolveMode(ended, min(70))).toEqual({ blocked: "ended_no_replay" });
    expect(resolveMode({ ...ended, recordingVideoId: "abcdefghijk" }, min(70))).toEqual({ mode: "replay" });
    expect(resolveMode({ ...ended, recordingVideoId: "abcdefghijk", isReplayEnabled: false }, min(70))).toEqual({ blocked: "ended_no_replay" });
  });

  it("live_ended_at set before the status sync already means replay", () => {
    expect(resolveMode(live({ status: "live", liveEndedAt: min(60), recordingVideoId: "abcdefghijk" }), min(61))).toEqual({ mode: "replay" });
  });

  it("draft, cancelled and archived serve nothing", () => {
    expect(resolveMode(live({ status: "draft" }), min(5))).toEqual({ blocked: "not_started" });
    expect(resolveMode(live({ status: "cancelled" }), min(5))).toEqual({ blocked: "ended_no_replay" });
    expect(resolveMode(live({ status: "archived", recordingVideoId: "abcdefghijk" }), min(500))).toEqual({ blocked: "ended_no_replay" });
  });
});

describe("resolveMode: simulive window and position (rule 23)", () => {
  it("is live inside [starts_at, starts_at + duration_sec) whatever the status sync says", () => {
    expect(resolveMode(simulive(), min(-1))).toEqual({ blocked: "not_started" });
    expect(resolveMode(simulive(), min(0))).toEqual({ mode: "live" });
    expect(resolveMode(simulive({ status: "live" }), min(44))).toEqual({ mode: "live" });
  });

  it("becomes a replay at starts_at + duration_sec", () => {
    expect(resolveMode(simulive(), min(45))).toEqual({ mode: "replay" });
    expect(resolveMode(simulive({ status: "ended" }), min(46))).toEqual({ mode: "replay" });
  });

  it("joins at now - starts_at", () => {
    expect(simulivePositionSec(simulive(), min(20))).toBe(1200);
    expect(simulivePositionSec(simulive(), min(-3))).toBe(0);
  });

  it("shows the countdown only before starts_at - 15 min", () => {
    expect(showsCountdown(simulive(), min(-16))).toBe(true);
    expect(showsCountdown(simulive(), min(-15))).toBe(false);
  });
});

describe("resolveMode: replay expiry (rule 30)", () => {
  it("expires at replay_until_at", () => {
    const w = live({ status: "ended", liveEndedAt: min(60), recordingVideoId: "abcdefghijk", replayUntilAt: days(7) });
    expect(resolveMode(w, days(6))).toEqual({ mode: "replay" });
    expect(resolveMode(w, days(7))).toEqual({ blocked: "expired" });
  });

  it("on-demand is on_demand until replay_until_at", () => {
    expect(resolveMode(onDemand(), days(100))).toEqual({ mode: "on_demand" });
    expect(resolveMode(onDemand({ replayUntilAt: days(10) }), days(10))).toEqual({ blocked: "expired" });
    expect(resolveMode(onDemand({ recordingVideoId: null }), days(1))).toEqual({ blocked: "not_started" });
  });
});

describe("registeredModeFor and canRegister (rule 15)", () => {
  it("before the end registers live, after it replay", () => {
    expect(registeredModeFor(live(), min(-600))).toBe("live");
    expect(registeredModeFor(live(), min(59))).toBe("live");
    expect(registeredModeFor(live(), min(60))).toBe("replay");
    expect(registeredModeFor(live({ status: "live" }), min(90))).toBe("live");
    expect(registeredModeFor(live({ status: "ended", liveEndedAt: min(50) }), min(51))).toBe("replay");
    expect(registeredModeFor(simulive(), min(44))).toBe("live");
    expect(registeredModeFor(simulive(), min(45))).toBe("replay");
    expect(registeredModeFor(onDemand(), min(0))).toBe("on_demand");
  });

  it("a gated replay closes registration after the end, an open one does not", () => {
    const ended = live({ status: "ended", liveEndedAt: min(60), recordingVideoId: "abcdefghijk" });
    expect(canRegister({ ...ended, status: "live", liveEndedAt: null }, min(30))).toEqual({ ok: true });
    expect(canRegister(ended, min(61))).toEqual({ ok: false, code: "closed" });
    expect(canRegister({ ...ended, isReplayGated: false }, min(61))).toEqual({ ok: true });
  });

  it("closed for draft, cancelled, archived, a disabled or expired replay", () => {
    const open = live({ status: "ended", liveEndedAt: min(60), isReplayGated: false, recordingVideoId: "abcdefghijk" });
    expect(canRegister(live({ status: "draft" }), min(-60))).toEqual({ ok: false, code: "closed" });
    expect(canRegister(live({ status: "cancelled" }), min(-60))).toEqual({ ok: false, code: "closed" });
    expect(canRegister(live({ status: "archived" }), min(-60))).toEqual({ ok: false, code: "closed" });
    expect(canRegister({ ...open, isReplayEnabled: false }, min(61))).toEqual({ ok: false, code: "closed" });
    expect(canRegister({ ...open, replayUntilAt: days(1) }, days(2))).toEqual({ ok: false, code: "closed" });
    expect(canRegister(onDemand({ replayUntilAt: days(1) }), days(2))).toEqual({ ok: false, code: "closed" });
    expect(canRegister(onDemand(), days(2))).toEqual({ ok: true });
  });
});

describe("replayAccess (rules 30, 31)", () => {
  const ended = live({ status: "ended", liveEndedAt: min(60), recordingVideoId: "abcdefghijk" });
  const registration = { createdAt: min(-1440) };

  it("view limit: the limit applies when reached", () => {
    const w = { ...ended, replayViewLimit: 2 };
    expect(replayAccess({ w, registration, viewsInMode: 1, now: min(90) })).toEqual({ ok: true });
    expect(replayAccess({ w, registration, viewsInMode: 2, now: min(90) })).toEqual({ ok: false, code: "limit_reached" });
    expect(replayAccess({ w: ended, registration, viewsInMode: 49, now: min(90) })).toEqual({ ok: true });
  });

  it("expiry wins over the view limit", () => {
    const w = { ...ended, replayViewLimit: 1, replayUntilAt: days(3) };
    expect(replayAccess({ w, registration, viewsInMode: 5, now: days(3) })).toEqual({ ok: false, code: "expired" });
  });

  it("on-demand access ends on_demand_access_days after registering, or at replay_until_at when earlier", () => {
    const reg = { createdAt: days(0) };
    const w = onDemand({ onDemandAccessDays: 14 });
    expect(replayAccess({ w, registration: reg, viewsInMode: 0, now: days(13.9) })).toEqual({ ok: true });
    expect(replayAccess({ w, registration: reg, viewsInMode: 0, now: days(14) })).toEqual({ ok: false, code: "expired" });
    expect(replayAccess({ w: { ...w, replayUntilAt: days(5) }, registration: reg, viewsInMode: 0, now: days(5) })).toEqual({ ok: false, code: "expired" });
    expect(replayAccess({ w: onDemand(), registration: reg, viewsInMode: 0, now: days(400) })).toEqual({ ok: true });
  });
});
