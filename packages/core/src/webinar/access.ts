/**
 * Modes and access (webinar spec rules 15, 22, 23, 30, 31). The server decides the mode; the
 * client never does. Pure functions over the webinar columns of `WebinarState`.
 *
 * - `live`: the webinar is `live` (mode live) or `now` is inside the scheduled showing
 *   `[starts_at, starts_at + duration)` (simulive, presented as live, rule 23).
 * - `replay`: after the end, while the replay is enabled, recorded and not expired.
 * - `on_demand`: on-demand webinars while published and not expired.
 */
import type { RegistrationState, WatchMode, WebinarState } from "./types";
import { effectiveDurationSec } from "./watch";

export type ModeBlock = "not_started" | "ended_no_replay" | "expired";
export type ResolvedMode = { mode: WatchMode } | { blocked: ModeBlock };

const DAY_MS = 86_400_000;
const at = (d: Date | null | undefined) => (d ? d.getTime() : null);

/**
 * When the live part ends: `live_ended_at` once known; for simulive the scheduled end
 * `starts_at + duration_sec`; for a live webinar not yet ended `starts_at + planned duration`,
 * except while it is `live` (an overrun keeps it live until YouTube says `complete`).
 */
function liveEndMs(w: WebinarState): number | null {
  const ended = at(w.liveEndedAt);
  if (ended !== null) return ended;
  const start = at(w.startsAt);
  if (start === null) return null;
  if (w.mode === "simulive") return start + effectiveDurationSec(w) * 1000;
  if (w.status === "live") return null;
  return start + w.plannedDurationMinutes * 60_000;
}

/** Whether the live part is over at `now` (status `ended`, or the end instant passed). */
function isAfterLive(w: WebinarState, now: Date): boolean {
  if (w.status === "ended") return true;
  const end = liveEndMs(w);
  return end !== null && now.getTime() >= end;
}

function replayExpired(w: WebinarState, now: Date): boolean {
  const until = at(w.replayUntilAt);
  return until !== null && now.getTime() >= until;
}

/** The replay situation after the end (rule 30). */
function replayMode(w: WebinarState, now: Date): ResolvedMode {
  if (!w.isReplayEnabled || !w.recordingVideoId) return { blocked: "ended_no_replay" };
  if (replayExpired(w, now)) return { blocked: "expired" };
  return { mode: "replay" };
}

/**
 * The mode a viewer watches in at `now` (rule 22), or why nothing can be watched. A draft is
 * `not_started`; a cancelled or archived webinar serves nothing (`ended_no_replay`). The
 * per-registration limits (view limit, on-demand access days) are `replayAccess`.
 */
export function resolveMode(w: WebinarState, now: Date): ResolvedMode {
  if (w.status === "draft") return { blocked: "not_started" };
  if (w.status === "cancelled" || w.status === "archived") return { blocked: "ended_no_replay" };

  if (w.mode === "on_demand") {
    if (!w.recordingVideoId) return { blocked: "not_started" };
    return replayExpired(w, now) ? { blocked: "expired" } : { mode: "on_demand" };
  }

  if (w.mode === "live") {
    if (w.status === "live" && w.liveEndedAt === null) return { mode: "live" };
    if (w.status === "ended" || w.liveEndedAt !== null) return replayMode(w, now);
    return { blocked: "not_started" };
  }

  // simulive: a pure time rule over the scheduled showing
  const start = at(w.startsAt);
  if (start === null || now.getTime() < start) return { blocked: "not_started" };
  if (!isAfterLive(w, now)) return { mode: "live" };
  return replayMode(w, now);
}

/**
 * The `registered_mode` of a registration made at `now` (rule 15): `on_demand` for on-demand
 * webinars, `live` before the end of the live part (before `starts_at + planned duration` while
 * not yet live), `replay` after it.
 */
export function registeredModeFor(w: WebinarState, now: Date): WatchMode {
  if (w.mode === "on_demand") return "on_demand";
  return isAfterLive(w, now) ? "replay" : "live";
}

/**
 * Whether a person may register at `now` (rule 15). Refused (`closed`) for drafts, cancelled
 * and archived webinars, and after the end when the replay is disabled, expired or gated
 * (gated replays are for people who registered before the end). An expired on-demand webinar
 * is closed too.
 */
export function canRegister(w: WebinarState, now: Date): { ok: true } | { ok: false; code: "closed" } {
  const closed = { ok: false, code: "closed" } as const;
  if (w.status === "draft" || w.status === "cancelled" || w.status === "archived") return closed;
  if (w.mode === "on_demand") return replayExpired(w, now) ? closed : { ok: true };
  if (registeredModeFor(w, now) === "live") return { ok: true };
  if (!w.isReplayEnabled || replayExpired(w, now) || w.isReplayGated) return closed;
  return { ok: true };
}

/**
 * Whether a registration may start a new replay or on-demand view (rules 30, 31). `viewsInMode`
 * counts the views already counted in that mode (a `started` interaction more than 30 minutes
 * after the previous one); the view limit applies when it is reached. On-demand access ends
 * `on_demand_access_days` after the registration and at `replay_until_at`, whichever is first.
 */
export function replayAccess(input: {
  w: WebinarState;
  registration: Pick<RegistrationState, "createdAt">;
  viewsInMode: number;
  now: Date;
}): { ok: true } | { ok: false; code: "expired" | "limit_reached" } {
  const { w, registration, viewsInMode, now } = input;
  if (replayExpired(w, now)) return { ok: false, code: "expired" };
  if (w.mode === "on_demand" && w.onDemandAccessDays !== null) {
    const ends = registration.createdAt.getTime() + w.onDemandAccessDays * DAY_MS;
    if (now.getTime() >= ends) return { ok: false, code: "expired" };
  }
  if (w.replayViewLimit !== null && viewsInMode >= w.replayViewLimit) return { ok: false, code: "limit_reached" };
  return { ok: true };
}

/** Seconds from the start of the video a simulive viewer joins at (`seekTo(now - starts_at)`, rule 23). */
export function simulivePositionSec(w: Pick<WebinarState, "startsAt">, now: Date): number {
  const start = at(w.startsAt);
  if (start === null) return 0;
  return Math.max(0, Math.floor((now.getTime() - start) / 1000));
}

/** Whether the player shows the countdown: before `starts_at - 15 min` (rule 22). */
export function showsCountdown(w: Pick<WebinarState, "startsAt">, now: Date, leadMin = 15): boolean {
  const start = at(w.startsAt);
  return start !== null && now.getTime() < start - leadMin * 60_000;
}
