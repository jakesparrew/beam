/**
 * Watching (webinar spec rules 22-32; webinar-P4): the server decides the mode, writes watch
 * segments from heartbeats, the started, attended and watched facts, and finalise writes the
 * no-shows.
 *
 * - `startView(tx, viewer, now)`: one player view. The mode comes from `resolveMode()` (rule 22);
 *   a replay or on-demand view is counted only when no `started` of the same registration and
 *   mode exists in the last 30 minutes (a reload does not count, rule 31), and refused at
 *   `replay_view_limit` (`limit_reached`) or after the access ended (`expired`, rule 30). Every
 *   view writes interaction `started` (with the player notice version, section 9.3) and the first
 *   view of a mode writes `webinar.started` (rule 28).
 * - `recordHeartbeat(tx, viewer, input, now)`: one `watch_segments` row per playing heartbeat
 *   (rule 24: live positions from the server clock, replay spans capped by the elapsed time + 5 s
 *   and 30 s); paused, buffering and ended write no segment (rule 25); a heartbeat sooner than
 *   10 s after the view's previous one is refused (`too_soon`, 429); a client mode that is not the
 *   server's is `mode_changed` (409); a replay that expired is `stop: 'expired'` (rule 32). The
 *   reached facts of rule 27 are written in the same transaction, once per registration per mode.
 * - `finaliseWebinar(tx, ctx, webinarId, now)`: rule 29.
 *
 * Every heartbeat and `startView` takes `select ... for no key update` on the registration row
 * first, so two tabs of one registration are serialised (rule 25, edge case 2).
 */
import { randomUUID } from "node:crypto";
import { activityEvents, watchSegments, webinarCtas, webinarInteractions, webinarPolls, webinarRegistrations, webinars } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import {
  WEBINAR_LIMITS,
  clampSegment,
  deriveCtaKey,
  effectiveDurationSec,
  factsReached,
  mergeIntervals,
  replayAccess,
  resolveMode,
  signCtaClick,
  simulivePositionSec,
  showsCountdown,
  type HeartbeatInput,
  type WatchFact,
  type WatchMode,
} from "@beam/core/webinar";
import { titleIn, webinarAuthSecret } from "@beam/email/templates/webinar";
import { NotFoundError, and, asc, desc, eq, inArray, sql, type Ctx, type RecordEventInput, type Tx } from "@/lib/ctx";
import { recordEvent } from "@/lib/events";
import { rowsOf } from "@/lib/sensitive";
import { createTask } from "@/modules/crm/api";
import type { WebinarRow } from "./lifecycle";
import type { RegistrationRow } from "./registration";
import { registrationRefusal, type Viewer } from "./viewer";

/** The wording version of the click-to-load notice (section 9.3), stored on every `started`. */
export const PLAYER_NOTICE_VERSION = "player_notice_v1";
/** The heartbeat interval the server tells the player. */
export const HEARTBEAT_NEXT_MS = WEBINAR_LIMITS.heartbeatSec * 1000;
/** Finalise waits this long after the live end (rule 29). */
export const FINALISE_AFTER_END_MS = 30 * 60_000;
/** Finalise stops waiting for the recording after this long (rule 29, edge case 22). */
export const FINALISE_RECORDING_WAIT_MS = 48 * 3600_000;
/** A live webinar that has not gone live this long after its start is `never_live` (rule 29, edge case 8). */
export const NEVER_LIVE_AFTER_MS = 2 * 3600_000;

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

const ref = (registrationId: string) => ({ type: "webinar_registration", id: registrationId });

type Record_ = (input: RecordEventInput) => Promise<{ id: bigint | null }>;
/** Viewer facts carry the `system` actor (the viewer may be an anonymous token holder). */
const systemRecorder = (tx: Tx): Record_ => (input) => recordEvent(tx, { kind: "system", id: null }, input);

/** `webinar_reg:<registration_id>:<mode>:<fact>` (rule 27). */
export const factKey = (registrationId: string, mode: WatchMode, fact: WatchFact | "started" | "no_show") => `webinar_reg:${registrationId}:${mode}:${fact}`;

/** The registration row under `select ... for no key update` (rule 25). */
async function lockRegistration(tx: Tx, registrationId: string): Promise<RegistrationRow> {
  const [r] = await tx.select().from(webinarRegistrations).where(eq(webinarRegistrations.id, registrationId)).for("no key update");
  if (!r) throw new NotFoundError("registration_not_found");
  return r;
}

async function loadWebinar(tx: Tx, webinarId: string): Promise<WebinarRow> {
  const [w] = await tx.select().from(webinars).where(eq(webinars.id, webinarId));
  if (!w) throw new NotFoundError("webinar_not_found");
  return w;
}

/** The instant positions of a live mode count from: `live_started_at`, or the simulive start. */
const liveStartOf = (w: WebinarRow): Date | null => w.liveStartedAt ?? (w.mode === "simulive" ? w.startsAt : null);

/** Counted views of a registration in a mode: `started` rows more than 30 minutes after the previous one (rule 31). */
export async function countedViews(tx: Tx, registrationId: string, mode: WatchMode): Promise<number> {
  const rows = rowsOf<{ views: number | string }>(
    await tx.execute(sql`select count(*)::int as views from (
        select occurred_at, lag(occurred_at) over (order by occurred_at) as prev
        from webinar_interactions
        where kind = 'started' and registration_id = ${registrationId}::uuid and mode = ${mode}::webinar_interactions_mode
      ) s where prev is null or occurred_at - prev > interval '30 minutes'`),
  );
  return Number(rows[0]?.views ?? 0);
}

/** The dedupe keys among `keys` that `activity_events` already holds. */
async function existingKeys(tx: Tx, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await tx.select({ k: activityEvents.dedupeKey }).from(activityEvents).where(inArray(activityEvents.dedupeKey, keys));
  return new Set(rows.map((r) => r.k).filter((k): k is string => !!k));
}

/** Merged watch of a registration in a mode (rule 26). */
async function watchOf(tx: Tx, registrationId: string, mode: WatchMode): Promise<{ watchedSec: number; maxPositionSec: number }> {
  const segs = await tx
    .select({ fromSec: watchSegments.fromSec, toSec: watchSegments.toSec })
    .from(watchSegments)
    .where(and(eq(watchSegments.registrationId, registrationId), eq(watchSegments.mode, mode)));
  return mergeIntervals(segs);
}

/**
 * Writes the facts of rule 27 the registration reached in `mode` and has not written yet (one
 * `activity_events` row each, deduped by `factKey`). Returns the facts newly written.
 */
async function writeFacts(
  tx: Tx,
  record: Record_,
  w: WebinarRow,
  r: Pick<RegistrationRow, "id" | "personId">,
  mode: WatchMode,
  watch: { watchedSec: number; maxPositionSec: number },
  occurredAt: Date,
): Promise<WatchFact[]> {
  const reached = factsReached({ ...watch, durationSec: effectiveDurationSec(w), attendedMinSec: w.attendedMinSec });
  if (!reached.length) return [];
  const have = await existingKeys(
    tx,
    reached.map((f) => factKey(r.id, mode, f)),
  );
  const written: WatchFact[] = [];
  for (const fact of reached) {
    const dedupeKey = factKey(r.id, mode, fact);
    if (have.has(dedupeKey)) continue;
    const base = { webinar_id: w.id, registration_id: r.id, watched_sec: watch.watchedSec };
    const out = await record({
      kind: fact === "attended" ? "webinar.attended" : "webinar.watched",
      personId: r.personId,
      mode,
      ref: ref(r.id),
      occurredAt,
      data: fact === "attended" ? base : { ...base, threshold: fact },
      dedupeKey,
    });
    if (out.id !== null) written.push(fact);
  }
  return written;
}

// ---------------------------------------------------------------------------------------------
// startView (rules 22, 23, 28, 30, 31)
// ---------------------------------------------------------------------------------------------

export type TimedPoll = {
  id: string;
  key: string;
  question: string;
  options: Array<{ key: string; label: string }>;
  allowMultiple: boolean;
  showAtSec: number;
  showForSec: number;
};
export type TimedCta = { id: string; key: string; label: string; showAtSec: number; showForSec: number; href: string };

export type ViewStart = {
  viewId: string;
  mode: WatchMode;
  videoId: string;
  /** Where the player starts (simulive: `now - starts_at`, rule 23). */
  startSec: number;
  durationSec: number | null;
  /** Seek controls: off for live and simulive (rule 23). */
  controls: boolean;
  /** Polls and CTAs at a video position (simulive, replay, on-demand; rule 34). Live ones come from the state route. */
  polls: TimedPoll[];
  ctas: TimedCta[];
  chatEnabled: boolean;
  questionsEnabled: boolean;
  muted: boolean;
  /** Whether this view counted against `replay_view_limit` (rule 31). */
  counted: boolean;
  viewsLeft: number | null;
  nextMs: number;
};

export type ViewRefusalCode = "not_started" | "ended" | "expired" | "limit_reached" | "blocked" | "cancelled";
export type ViewRefusal = {
  error: ViewRefusalCode;
  /** `not_started`: when the webinar starts and whether the player shows the countdown (rule 22). */
  startsAt?: Date | null;
  countdown?: boolean;
};

export const isViewRefusal = (v: ViewStart | ViewRefusal): v is ViewRefusal => "error" in v;

/** The CTA click path of rule 36 (`/api/webinar/cta/<id>?r&m&s`); the signature records a click and grants nothing. */
export function ctaClickPath(registrationId: string, ctaId: string, mode: WatchMode): string {
  const sig = signCtaClick(deriveCtaKey(webinarAuthSecret()), registrationId, ctaId, mode);
  return `/api/webinar/cta/${ctaId}?r=${registrationId}&m=${mode}&s=${encodeURIComponent(sig)}`;
}

async function timedItems(tx: Tx, w: WebinarRow, r: RegistrationRow, mode: WatchMode, locale: Locale): Promise<{ polls: TimedPoll[]; ctas: TimedCta[] }> {
  if (w.mode === "live" && mode === "live") return { polls: [], ctas: [] };
  const polls = await tx
    .select()
    .from(webinarPolls)
    .where(and(eq(webinarPolls.webinarId, w.id), eq(webinarPolls.isActive, true)))
    .orderBy(asc(webinarPolls.showAtSec), asc(webinarPolls.sortOrder));
  const ctas = await tx
    .select()
    .from(webinarCtas)
    .where(and(eq(webinarCtas.webinarId, w.id), eq(webinarCtas.isActive, true)))
    .orderBy(asc(webinarCtas.showAtSec), asc(webinarCtas.sortOrder));
  return {
    polls: polls
      .filter((p) => p.showAtSec !== null)
      .map((p) => ({
        id: p.id,
        key: p.key,
        question: titleIn(p.question, locale),
        options: p.options.map((o) => ({ key: o.key, label: titleIn(o.label, locale) })),
        allowMultiple: p.allowMultiple,
        showAtSec: p.showAtSec!,
        showForSec: p.showForSec,
      })),
    ctas: ctas
      .filter((c) => c.showAtSec !== null)
      .map((c) => ({ id: c.id, key: c.key, label: titleIn(c.label, locale), showAtSec: c.showAtSec!, showForSec: c.showForSec, href: ctaClickPath(r.id, c.id, mode) })),
  };
}

/** The video a mode plays: the broadcast while live, else the recording (the broadcast id for a live webinar without one). */
function videoOf(w: WebinarRow, mode: WatchMode): string | null {
  if (w.mode === "live" && mode === "live") return w.youtubeVideoId;
  return w.recordingVideoId ?? (w.mode === "live" ? w.youtubeVideoId : null);
}

/**
 * Starts one player view (section 4.4 `/api/webinar/view`). Refusals write nothing; a start
 * writes interaction `started` (one per view) and, first in its mode, `webinar.started`.
 */
export async function startView(tx: Tx, viewer: Viewer, now: Date): Promise<ViewStart | ViewRefusal> {
  const r = await lockRegistration(tx, viewer.registration.id);
  const refused = registrationRefusal(r);
  if (refused) return { error: refused.error === "blocked" ? "blocked" : "cancelled" };
  const w = await loadWebinar(tx, r.webinarId);

  const resolved = resolveMode(w, now);
  if (!("mode" in resolved)) {
    if (resolved.blocked === "not_started") return { error: "not_started", startsAt: w.startsAt, countdown: showsCountdown(w, now, WEBINAR_LIMITS.countdownLeadMin) };
    return { error: resolved.blocked === "expired" ? "expired" : "ended" };
  }
  const mode = resolved.mode;
  const videoId = videoOf(w, mode);
  if (!videoId) return { error: mode === "live" ? "not_started" : "ended" };

  let counted = false;
  let viewsLeft: number | null = null;
  if (mode !== "live") {
    const [recent] = await tx
      .select({ id: webinarInteractions.id })
      .from(webinarInteractions)
      .where(
        and(
          eq(webinarInteractions.registrationId, r.id),
          eq(webinarInteractions.kind, "started"),
          eq(webinarInteractions.mode, mode),
          sql`${webinarInteractions.occurredAt} > ${new Date(now.getTime() - WEBINAR_LIMITS.viewDedupeMin * 60_000)}`,
        ),
      )
      .limit(1);
    const used = await countedViews(tx, r.id, mode);
    counted = !recent;
    const access = replayAccess({ w, registration: r, viewsInMode: counted ? used : 0, now });
    if (!access.ok) return { error: access.code };
    if (w.replayViewLimit !== null) viewsLeft = Math.max(0, w.replayViewLimit - used - (counted ? 1 : 0));
  }

  const viewId = randomUUID();
  const startSec = w.mode === "simulive" && mode === "live" ? simulivePositionSec(w, now) : 0;
  await tx.insert(webinarInteractions).values({
    registrationId: r.id,
    webinarId: w.id,
    mode,
    kind: "started",
    viewId,
    payload: { player_notice_version: PLAYER_NOTICE_VERSION },
    atSec: startSec,
    occurredAt: now,
  });
  await systemRecorder(tx)({
    kind: "webinar.started",
    personId: r.personId,
    mode,
    ref: ref(r.id),
    occurredAt: now,
    data: { webinar_id: w.id, registration_id: r.id },
    dedupeKey: factKey(r.id, mode, "started"),
  });

  const { polls, ctas } = await timedItems(tx, w, r, mode, r.locale);
  return {
    viewId,
    mode,
    videoId,
    startSec,
    durationSec: w.durationSec,
    controls: mode !== "live",
    polls,
    ctas,
    chatEnabled: w.isChatEnabled && mode === "live",
    questionsEnabled: w.isQuestionsEnabled,
    muted: r.mutedAt !== null,
    counted,
    viewsLeft,
    nextMs: HEARTBEAT_NEXT_MS,
  };
}

// ---------------------------------------------------------------------------------------------
// recordHeartbeat (rules 21, 24-27, 32; edge cases 1-5, 13)
// ---------------------------------------------------------------------------------------------

export type HeartbeatStop = "blocked" | "cancelled" | "expired" | "mode_changed";
export type HeartbeatResult =
  | { ok: true; nextMs: number; segment: { fromSec: number; toSec: number } | null; facts: WatchFact[] }
  | { ok: false; stop: HeartbeatStop; nextMs: number }
  | { ok: false; error: "too_soon"; retryAfterSec: number };

/** The HTTP status of a heartbeat result (`403` blocked/cancelled, `409` mode changed, `429` too soon). */
export function heartbeatStatus(result: HeartbeatResult): 200 | 403 | 409 | 429 {
  if (result.ok) return 200;
  if ("error" in result) return 429;
  if (result.stop === "blocked" || result.stop === "cancelled") return 403;
  if (result.stop === "mode_changed") return 409;
  return 200;
}

/**
 * One heartbeat of one view. The view must have been started by `startView` (an unknown view is
 * `mode_changed`, so the player reloads), in the mode the server resolves now.
 */
export async function recordHeartbeat(tx: Tx, viewer: Viewer, input: HeartbeatInput, now: Date): Promise<HeartbeatResult> {
  const r = await lockRegistration(tx, viewer.registration.id);
  const refused = registrationRefusal(r);
  if (refused) return { ok: false, stop: refused.error === "blocked" ? "blocked" : "cancelled", nextMs: HEARTBEAT_NEXT_MS };
  const w = await loadWebinar(tx, r.webinarId);
  const stop = (s: HeartbeatStop): HeartbeatResult => ({ ok: false, stop: s, nextMs: HEARTBEAT_NEXT_MS });

  const [view] = await tx
    .select({ mode: webinarInteractions.mode, occurredAt: webinarInteractions.occurredAt })
    .from(webinarInteractions)
    .where(and(eq(webinarInteractions.registrationId, r.id), eq(webinarInteractions.viewId, input.viewId), eq(webinarInteractions.kind, "started")))
    .limit(1);
  if (!view || view.mode !== input.mode) return stop("mode_changed");

  const resolved = resolveMode(w, now);
  if (!("mode" in resolved)) return stop(resolved.blocked === "expired" ? "expired" : "mode_changed");
  if (resolved.mode !== input.mode) return stop("mode_changed");
  const mode = resolved.mode;
  if (mode !== "live" && !replayAccess({ w, registration: r, viewsInMode: 0, now }).ok) return stop("expired");

  const [last] = await tx
    .select({ at: watchSegments.recordedAt })
    .from(watchSegments)
    .where(and(eq(watchSegments.registrationId, r.id), eq(watchSegments.viewId, input.viewId)))
    .orderBy(desc(watchSegments.recordedAt))
    .limit(1);
  const lastSegmentAt = last?.at ?? null;
  const spacingMs = WEBINAR_LIMITS.minHeartbeatSpacingSec * 1000;
  if (lastSegmentAt && now.getTime() - lastSegmentAt.getTime() < spacingMs) {
    return { ok: false, error: "too_soon", retryAfterSec: Math.max(1, Math.ceil((spacingMs - (now.getTime() - lastSegmentAt.getTime())) / 1000)) };
  }

  if (input.state === "ended") {
    const [ended] = await tx
      .select({ id: webinarInteractions.id })
      .from(webinarInteractions)
      .where(and(eq(webinarInteractions.registrationId, r.id), eq(webinarInteractions.viewId, input.viewId), eq(webinarInteractions.kind, "ended")))
      .limit(1);
    if (!ended) {
      await tx.insert(webinarInteractions).values({
        registrationId: r.id,
        webinarId: w.id,
        mode,
        kind: "ended",
        viewId: input.viewId,
        payload: {},
        atSec: Math.max(0, Math.floor(input.toSec)),
        occurredAt: now,
      });
    }
  }
  if (input.state !== "playing") return { ok: true, nextMs: HEARTBEAT_NEXT_MS, segment: null, facts: [] };

  const segment = clampSegment({
    mode,
    clientFrom: input.fromSec,
    clientTo: input.toSec,
    now,
    liveStartedAt: liveStartOf(w),
    lastHeartbeatAt: lastSegmentAt && lastSegmentAt > view.occurredAt ? lastSegmentAt : view.occurredAt,
    durationSec: effectiveDurationSec(w),
  });
  if (!segment) return { ok: true, nextMs: HEARTBEAT_NEXT_MS, segment: null, facts: [] };
  await tx.insert(watchSegments).values({ registrationId: r.id, webinarId: w.id, mode, viewId: input.viewId, ...segment, recordedAt: now });
  const facts = await writeFacts(tx, systemRecorder(tx), w, r, mode, await watchOf(tx, r.id, mode), now);
  return { ok: true, nextMs: HEARTBEAT_NEXT_MS, segment, facts };
}

// ---------------------------------------------------------------------------------------------
// finaliseWebinar (rule 29, edge cases 8 and 22)
// ---------------------------------------------------------------------------------------------

export type FinaliseResult = { noShows: number; backfilled: number } | { deferred: "replay_unknown" | "not_ended" };

/** Whether the replay situation is known at `now` (rule 29). */
export function replaySituationKnown(w: Pick<WebinarRow, "recordingVideoId" | "durationSec" | "isReplayEnabled" | "liveEndedAt">, now: Date): boolean {
  if (!w.isReplayEnabled) return true;
  if (w.recordingVideoId && w.durationSec) return true;
  return !!w.liveEndedAt && w.liveEndedAt.getTime() <= now.getTime() - FINALISE_RECORDING_WAIT_MS;
}

/** Whether a replay can be watched after the live part (the no-show journey sends the link only then). */
function replayAvailable(w: WebinarRow, now: Date): boolean {
  return w.isReplayEnabled && !!w.recordingVideoId && !!w.durationSec && !(w.replayUntilAt && w.replayUntilAt.getTime() <= now.getTime());
}

/**
 * Rule 29, once per live or simulive webinar (the job key carries `version`):
 *
 * - never went live by `starts_at + 2 h` (a `published` live webinar): no `webinar.no_show`;
 *   `broadcast_error = 'never_live'` and one task for `owner_user_id`;
 * - ended: waits until `live_ended_at <= now - 30 min` (`not_ended`) and the replay situation is
 *   known (`replay_unknown`: recording and duration set, replay disabled, or 48 h passed); then
 *   back-fills the live thresholds the real duration makes reachable and writes `webinar.no_show`
 *   for every `registered` live registrant without a live `webinar.attended`.
 *
 * Sets `finalised_at`; a second run of a finalised webinar changes nothing.
 */
export async function finaliseWebinar(tx: Tx, ctx: Ctx, webinarId: string, now: Date): Promise<FinaliseResult> {
  const [w] = await tx.select().from(webinars).where(eq(webinars.id, webinarId)).for("update");
  if (!w) throw new NotFoundError("webinar_not_found");
  const none = { noShows: 0, backfilled: 0 };
  if (w.finalisedAt || w.mode === "on_demand" || w.status === "cancelled" || w.status === "archived" || w.status === "draft") return none;

  if (w.status === "published" || (w.status === "live" && !w.liveStartedAt)) {
    if (w.mode !== "live" || !w.startsAt || now.getTime() < w.startsAt.getTime() + NEVER_LIVE_AFTER_MS) return { deferred: "not_ended" };
    await tx.update(webinars).set({ broadcastError: "never_live", finalisedAt: now, updatedAt: now }).where(eq(webinars.id, w.id));
    await createTask(tx, ctx, {
      title: "Webinar did not go live",
      kind: "follow_up",
      source: "system",
      ownerUserId: w.ownerUserId,
      dueAt: new Date(now.getTime() + 24 * 3600_000),
      priority: "high",
      ref: { type: "webinar", id: w.id },
      notes: `The webinar ${w.slug} never went live. Reschedule or cancel it (cancelling emails the registrants).`,
      dedupeKey: `webinar_never_live:${w.id}:v${w.version}`,
    });
    return none;
  }
  if (w.status !== "ended" || !w.liveEndedAt || w.liveEndedAt.getTime() > now.getTime() - FINALISE_AFTER_END_MS) return { deferred: "not_ended" };
  if (!replaySituationKnown(w, now)) return { deferred: "replay_unknown" };

  const regs = await tx
    .select()
    .from(webinarRegistrations)
    .where(eq(webinarRegistrations.webinarId, w.id))
    .orderBy(asc(webinarRegistrations.createdAt), asc(webinarRegistrations.id));
  const record: Record_ = (input) => ctx.recordEvent(input);
  let backfilled = 0;
  for (const r of regs) {
    const watch = await watchOf(tx, r.id, "live");
    if (watch.watchedSec > 0) backfilled += (await writeFacts(tx, record, w, r, "live", watch, now)).length;
  }
  const attended = await existingKeys(
    tx,
    regs.map((r) => factKey(r.id, "live", "attended")),
  );

  const available = replayAvailable(w, now);
  let noShows = 0;
  for (const r of regs) {
    if (r.status !== "registered" || r.registeredMode !== "live" || attended.has(factKey(r.id, "live", "attended"))) continue;
    const out = await record({
      kind: "webinar.no_show",
      personId: r.personId,
      mode: "live",
      ref: ref(r.id),
      occurredAt: now,
      data: { webinar_id: w.id, registration_id: r.id, replay_available: available, replay_until_at: available ? w.replayUntilAt : null },
      dedupeKey: factKey(r.id, "live", "no_show"),
    });
    if (out.id !== null) noShows++;
  }
  await tx.update(webinars).set({ finalisedAt: now, updatedAt: now }).where(eq(webinars.id, w.id));
  return { noShows, backfilled };
}
