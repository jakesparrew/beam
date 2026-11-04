/**
 * Watch time (webinar spec rules 24-27, edge cases 1-4). Pure: the heartbeat route clamps the
 * client's span with `clampSegment`, stores it in `watch_segments`, then merges the mode's
 * segments with `mergeIntervals` and emits the facts `factsReached` returns that are not yet
 * written. `v_webinar_watch` computes the same seconds in SQL (a test asserts both agree).
 */
import { WATCH_FACTS, WEBINAR_LIMITS, type WatchFact, type WatchMode, type WebinarState } from "./types";

/**
 * Merged length of a set of `[fromSec, toSec)` intervals: overlapping, nested and touching
 * intervals count each second once (two tabs never double count). Input order does not matter;
 * empty or inverted intervals are ignored. `maxPositionSec` is the furthest merged end (0 when
 * nothing was watched).
 */
export function mergeIntervals(segs: ReadonlyArray<{ fromSec: number; toSec: number }>): { watchedSec: number; maxPositionSec: number } {
  const sorted = segs.filter((s) => s.toSec > s.fromSec).sort((a, b) => a.fromSec - b.fromSec || a.toSec - b.toSec);
  let watchedSec = 0;
  let maxPositionSec = 0;
  let start: number | null = null;
  let end = 0;
  for (const s of sorted) {
    if (start === null || s.fromSec > end) {
      if (start !== null) watchedSec += end - start;
      start = s.fromSec;
      end = s.toSec;
    } else if (s.toSec > end) {
      end = s.toSec;
    }
    if (s.toSec > maxPositionSec) maxPositionSec = s.toSec;
  }
  if (start !== null) watchedSec += end - start;
  return { watchedSec, maxPositionSec };
}

/**
 * The facts a registration has reached in one mode (rule 27), in `WATCH_FACTS` order:
 * `attended` at `attendedMinSec`, `15m` at 900 s, `30m` at 1,800 s, `50pct` at half of
 * `durationSec` (the real length, or the planned one while it is unknown), `end` when the
 * furthest position reaches `durationSec - 60`. A duration of 0 or less reaches neither
 * `50pct` nor `end`.
 */
export function factsReached(input: { watchedSec: number; maxPositionSec: number; durationSec: number; attendedMinSec: number }): WatchFact[] {
  const { watchedSec, maxPositionSec, durationSec, attendedMinSec } = input;
  const reached: Record<WatchFact, boolean> = {
    attended: watchedSec >= attendedMinSec,
    "15m": watchedSec >= WEBINAR_LIMITS.watched15mSec,
    "30m": watchedSec >= WEBINAR_LIMITS.watched30mSec,
    "50pct": durationSec > 0 && watchedSec * 2 >= durationSec,
    end: durationSec > 0 && maxPositionSec >= durationSec - WEBINAR_LIMITS.endMarginSec,
  };
  return WATCH_FACTS.filter((f) => reached[f]);
}

/** The length the thresholds use: `duration_sec`, else `planned_duration_minutes * 60`. */
export function effectiveDurationSec(w: Pick<WebinarState, "durationSec" | "plannedDurationMinutes">): number {
  return w.durationSec ?? w.plannedDurationMinutes * 60;
}

const seconds = (ms: number) => Math.floor(ms / 1000);

/**
 * The segment one heartbeat writes (rule 24), or `null` when it writes nothing.
 *
 * - `live` (and simulive during its showing): positions come from the server clock;
 *   `toSec = floor(now - liveStartedAt)` and `fromSec = max(0, toSec - min(15, seconds since
 *   the previous heartbeat of this view))`. Client positions are ignored. Without
 *   `liveStartedAt`, or before it, nothing is written.
 * - `replay`, `on_demand`: the client positions are clamped to `[0, durationSec]`, and the span
 *   is cut to at most `seconds since the previous heartbeat + 5`, never above 30 (edge case 3).
 *   The cut keeps the end the player reports now (its current position) and moves the start.
 *
 * `lastHeartbeatAt` is the previous heartbeat (or `startView`) of the same view; when absent the
 * heartbeat interval (15 s) stands in for the elapsed time.
 */
export function clampSegment(input: {
  mode: WatchMode;
  clientFrom: number;
  clientTo: number;
  now: Date;
  liveStartedAt?: Date | null;
  lastHeartbeatAt?: Date | null;
  durationSec: number;
}): { fromSec: number; toSec: number } | null {
  const { mode, now } = input;
  const elapsed = input.lastHeartbeatAt ? Math.max(0, seconds(now.getTime() - input.lastHeartbeatAt.getTime())) : WEBINAR_LIMITS.heartbeatSec;

  if (mode === "live") {
    if (!input.liveStartedAt) return null;
    const toSec = seconds(now.getTime() - input.liveStartedAt.getTime());
    const fromSec = Math.max(0, toSec - Math.min(WEBINAR_LIMITS.heartbeatSec, elapsed));
    return toSec > fromSec ? { fromSec, toSec } : null;
  }

  if (!Number.isFinite(input.clientFrom) || !Number.isFinite(input.clientTo)) return null;
  const duration = Math.max(0, Math.floor(input.durationSec));
  const clamp = (v: number) => Math.min(duration, Math.max(0, Math.floor(v)));
  const toSec = clamp(input.clientTo);
  const maxSpan = Math.min(WEBINAR_LIMITS.maxSegmentSec, elapsed + WEBINAR_LIMITS.replaySlackSec);
  const fromSec = Math.max(clamp(input.clientFrom), toSec - maxSpan);
  return toSec > fromSec ? { fromSec, toSec } : null;
}
