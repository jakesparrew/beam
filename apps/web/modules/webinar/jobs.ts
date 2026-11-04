/**
 * webinar jobs (`defineJob`, webinar spec section 4.5). Facade read by `pnpm gen:indexes`: every
 * `kind` is a literal. webinar-P2: the YouTube and Meet jobs (`create_broadcast`,
 * `update_broadcast`, `delete_broadcast`, `create_meet_space`), live status and recording sync
 * (`sync_status`, `fetch_recording`), the reschedule and cancel notices (`notify_registrants`) and
 * the two scans of `schedules.ts`. Every handler is idempotent: a second run with the same
 * payload leaves the same state (`jobs.test.ts`).
 *
 * The YouTube client is not one of the shared `getIntegrations()` clients: `youtubeFor(ctx)`
 * applies the same real/fake rule (`integrationMode('youtube', 'GOOGLE_OAUTH_REFRESH_TOKEN')`),
 * builds the real client with `onCall: ctx.integrationLog`, and keeps one fake per process so
 * local broadcasts survive between jobs. Tests install their fake with `setYouTubeClient()`.
 */
import { z } from "zod";
import { jobs as jobsTable, webinarRegistrations, webinars } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import { URL_SEGMENT, formatDateTime, type Locale } from "@beam/core/i18n";
import { localHourKey } from "@beam/core/platform";
import { isPermanentFailure, scrubError } from "@beam/integrations/_shared";
import { broadcastMarker, createYouTubeClient, createYouTubeFake, type YouTubeClient } from "@beam/integrations/youtube";
import { and, asc, desc, enqueueJob, eq, sql, writeDurably, type Ctx } from "@/lib/ctx";
import { integrationMode, routedOnCall } from "@/lib/integrations";
import { defineJob, type JobCtx } from "@/lib/job-runner";
import { sendTransactional } from "@/modules/email/api";
import { ScanLiveInput, ScanRecordingsInput, runScanLive, runScanRecordings } from "./schedules";
import { completeBroadcastPublish, jobKeys, lockWebinar, moveLiveState, noticeEmailKey, textIn, type NoticeReason, type WebinarRow } from "./server/lifecycle";

// ---------------------------------------------------------------------------------------------
// The YouTube client of a job
// ---------------------------------------------------------------------------------------------

let installed: YouTubeClient | undefined;
const processCache = globalThis as unknown as { __beamYouTubeFake?: YouTubeClient };

/** Tests (and the demo seed) install a client, usually `createYouTubeFake()`; `undefined` restores the default. */
export function setYouTubeClient(client: YouTubeClient | undefined): void {
  installed = client;
}

function notConfigured(): YouTubeClient {
  const fail = () => Promise.reject(new PermanentError("not_configured: youtube"));
  return {
    findBroadcastByMarker: fail,
    createBroadcast: fail,
    updateBroadcast: fail,
    deleteBroadcast: fail,
    getBroadcast: fail,
    getVideo: fail,
    createMeetSpace: fail,
  };
}

/** The YouTube client for one job (runbook 1.5 rule, `GOOGLE_OAUTH_REFRESH_TOKEN` as the key). */
export function youtubeFor(ctx: Pick<Ctx, "integrationLog">, env: Readonly<Record<string, string | undefined>> = process.env): YouTubeClient {
  if (installed) return installed;
  if (integrationMode("youtube", "GOOGLE_OAUTH_REFRESH_TOKEN", env) === "fake") {
    processCache.__beamYouTubeFake ??= createYouTubeFake({ onCall: routedOnCall });
    return processCache.__beamYouTubeFake;
  }
  const { GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret, GOOGLE_OAUTH_REFRESH_TOKEN: refreshToken } = env;
  if (!clientId || !clientSecret || !refreshToken) return notConfigured();
  return createYouTubeClient({ clientId, clientSecret, refreshToken, onCall: (entry) => ctx.integrationLog(entry) });
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const WebinarIdInput = z.object({ webinarId: z.uuid() });

/** The short text staff see in red on the webinar page (`broadcast_error`). */
const errorText = (error: unknown): string => scrubError(error instanceof Error ? error.message : String(error)).slice(0, 300);

const isConflict = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "conflict";

/** Writes `broadcast_error` so it survives the rollback of the failing job (and clears the publishing spinner). */
async function recordBroadcastError(ctx: Ctx, webinarId: string, message: string, opts: { stopPublishing?: boolean } = {}): Promise<void> {
  await writeDurably(ctx, async (db) => {
    await db
      .update(webinars)
      .set({ broadcastError: message, ...(opts.stopPublishing ? { publishRequestedAt: null } : {}), updatedAt: new Date() })
      .where(eq(webinars.id, webinarId));
  });
}

const broadcastTitle = (w: WebinarRow) => textIn(w.title, w.spokenLocale).slice(0, 100) || w.slug;
const broadcastDescription = (w: WebinarRow) => `${textIn(w.description, w.spokenLocale)}\n\n${broadcastMarker(w.id)}`.trim();

/** Absolute URL of a site path (`APP_URL`). */
const siteUrl = (path: string) => `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}${path}`;
export const landingUrl = (slug: string, locale: Locale) => siteUrl(`/${URL_SEGMENT[locale]}/webinars/${slug}`);

// ---------------------------------------------------------------------------------------------
// webinar.create_broadcast (rules 8, 9; edge case 6)
// ---------------------------------------------------------------------------------------------

/**
 * Finds the broadcast by its marker (a retry after a lost response reuses it) or creates it, then
 * stores it, creates the calendar session and sets `published` in this job's transaction. A
 * 400/403 from YouTube or a booking `conflict` is permanent: `broadcast_error` is stored and the
 * webinar stays `draft`.
 */
export async function runCreateBroadcast(ctx: JobCtx, input: z.infer<typeof WebinarIdInput>) {
  const w = await lockWebinar(ctx.tx, input.webinarId);
  if (w.status !== "draft" || !w.publishRequestedAt) return { skipped: w.status };
  if (!w.startsAt) throw new PermanentError("starts_at_required");
  const youtube = youtubeFor(ctx);
  try {
    const found = await youtube.findBroadcastByMarker(broadcastMarker(w.id));
    const broadcast = found ?? (await youtube.createBroadcast({ title: broadcastTitle(w), description: broadcastDescription(w), scheduledStartAt: w.startsAt }));
    await completeBroadcastPublish(ctx, w.id, broadcast);
    return { broadcastId: broadcast.broadcastId, reused: !!found };
  } catch (error) {
    if (isConflict(error)) {
      const message = (error as Error).message || "webinar_session_mismatch";
      await recordBroadcastError(ctx, w.id, message, { stopPublishing: true });
      throw new PermanentError(message);
    }
    if (isPermanentFailure(error)) {
      await recordBroadcastError(ctx, w.id, errorText(error), { stopPublishing: true });
      throw error instanceof PermanentError ? error : new PermanentError(errorText(error));
    }
    throw error;
  }
}

/** A dead `create_broadcast` (attempts used up) leaves the webinar in `draft` with its error shown. */
async function onCreateBroadcastDead(ctx: JobCtx, input: z.infer<typeof WebinarIdInput>, error: { message: string }) {
  await ctx.tx
    .update(webinars)
    .set({ broadcastError: sql`coalesce(${webinars.broadcastError}, ${error.message.slice(0, 300)})`, publishRequestedAt: null, updatedAt: new Date() })
    .where(and(eq(webinars.id, input.webinarId), eq(webinars.status, "draft")));
}

// ---------------------------------------------------------------------------------------------
// webinar.update_broadcast / delete_broadcast / create_meet_space
// ---------------------------------------------------------------------------------------------

const UpdateBroadcastInput = z.object({ webinarId: z.uuid(), version: z.number().int().min(1) });

/** A full PUT of the current title, description and start (rule 11); 404 is permanent and shown. */
export async function runUpdateBroadcast(ctx: JobCtx, input: z.infer<typeof UpdateBroadcastInput>) {
  const w = await lockWebinar(ctx.tx, input.webinarId);
  if (!w.youtubeVideoId || !(w.status === "published" || w.status === "live") || !w.startsAt) return { skipped: true };
  try {
    await youtubeFor(ctx).updateBroadcast(w.youtubeVideoId, { title: broadcastTitle(w), description: broadcastDescription(w), scheduledStartAt: w.startsAt });
  } catch (error) {
    if (isPermanentFailure(error)) {
      await recordBroadcastError(ctx, w.id, errorText(error));
      throw error instanceof PermanentError ? error : new PermanentError(errorText(error));
    }
    throw error;
  }
  return { updated: w.youtubeVideoId, version: w.version };
}

/** Deletes an unstarted broadcast of a cancelled webinar; a live or completed one is kept (its recording). 404 = done. */
export async function runDeleteBroadcast(ctx: JobCtx, input: z.infer<typeof WebinarIdInput>) {
  const w = await lockWebinar(ctx.tx, input.webinarId);
  if (!w.youtubeVideoId || w.status !== "cancelled") return { skipped: true };
  const youtube = youtubeFor(ctx);
  try {
    const b = await youtube.getBroadcast(w.youtubeVideoId);
    if (b.lifecycle === "live" || b.lifecycle === "complete") return { kept: b.lifecycle };
    await youtube.deleteBroadcast(w.youtubeVideoId);
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return { deleted: false, missing: true };
    throw error;
  }
  return { deleted: true };
}

/** Meet REST `spaces.create`; a stored space short-circuits. A failure leaves the link empty for staff to paste. */
export async function runCreateMeetSpace(ctx: JobCtx, input: z.infer<typeof WebinarIdInput>) {
  const w = await lockWebinar(ctx.tx, input.webinarId);
  if (w.meetSpaceName || w.hostMeetUrl) return { skipped: true };
  if (w.status === "cancelled" || w.status === "archived") return { skipped: true };
  const space = await youtubeFor(ctx).createMeetSpace();
  await ctx.tx.update(webinars).set({ hostMeetUrl: space.meetingUri, meetSpaceName: space.spaceName, updatedAt: new Date() }).where(eq(webinars.id, w.id));
  return { spaceName: space.spaceName };
}

// ---------------------------------------------------------------------------------------------
// webinar.sync_status (rule 10)
// ---------------------------------------------------------------------------------------------

/** Failures of `sync_status` in a row during a live window before one Slack line (section 6). */
export const SYNC_FAILURE_ALERT_AFTER = 10;

/** The scheduled end of a simulive showing. */
const showingEnd = (w: WebinarRow) => new Date(w.startsAt!.getTime() + (w.durationSec ?? w.plannedDurationMinutes * 60) * 1000);

async function alertOnRepeatedSyncFailure(ctx: JobCtx, w: WebinarRow, error: unknown): Promise<void> {
  if (ctx.job.attempt < 2) return;
  const previous = await ctx.tx
    .select({ status: jobsTable.status })
    .from(jobsTable)
    .where(and(sql`${jobsTable.idempotencyKey} like ${`webinar:${w.id}:status:%`}`, sql`${jobsTable.id} <> ${ctx.job.id}::uuid`))
    .orderBy(desc(jobsTable.createdAt))
    .limit(SYNC_FAILURE_ALERT_AFTER - 1);
  if (previous.length < SYNC_FAILURE_ALERT_AFTER - 1 || previous.some((p) => p.status !== "dead")) return;
  await writeDurably(ctx, async (db) => {
    await enqueueJob(db, {
      kind: "notify.slack",
      payload: { fingerprint: `webinar_sync:${w.id}`, severity: "high", text: `Webinar ${w.slug}: YouTube status sync failed ${SYNC_FAILURE_ALERT_AFTER} times in a row (${errorText(error)})` },
      key: `webinar:${w.id}:alert:sync:${localHourKey(ctx.now)}`,
    });
  });
}

/**
 * Live: reads the broadcast and moves `published -> live -> ended` from `lifeCycleStatus`
 * (`live_started_at`/`live_ended_at` from YouTube's actual times). Simulive: the time rule only,
 * no API call. Running it twice in the same minute changes nothing more.
 */
export async function runSyncStatus(ctx: JobCtx, input: z.infer<typeof WebinarIdInput>) {
  let w = await lockWebinar(ctx.tx, input.webinarId);
  if (!(w.status === "published" || w.status === "live") || !w.startsAt) return { skipped: w.status };
  const now = ctx.now;

  if (w.mode === "simulive") {
    if (w.status === "published" && now >= w.startsAt) w = await moveLiveState(ctx, w, "live", w.startsAt);
    if (w.status === "live" && now >= showingEnd(w)) w = await moveLiveState(ctx, w, "ended", showingEnd(w));
    return { status: w.status };
  }
  if (w.mode !== "live" || !w.youtubeVideoId) return { skipped: w.mode };

  let broadcast;
  try {
    broadcast = await youtubeFor(ctx).getBroadcast(w.youtubeVideoId);
  } catch (error) {
    await alertOnRepeatedSyncFailure(ctx, w, error);
    throw error;
  }
  if (w.youtubeLifecycle !== broadcast.lifecycle) {
    await ctx.tx.update(webinars).set({ youtubeLifecycle: broadcast.lifecycle, updatedAt: now }).where(eq(webinars.id, w.id));
    w = { ...w, youtubeLifecycle: broadcast.lifecycle };
  }
  if ((broadcast.lifecycle === "live" || broadcast.lifecycle === "complete") && w.status === "published") {
    w = await moveLiveState(ctx, w, "live", broadcast.actualStartAt ?? broadcast.actualEndAt ?? now);
  }
  if (broadcast.lifecycle === "complete" && w.status === "live") w = await moveLiveState(ctx, w, "ended", broadcast.actualEndAt ?? now);
  return { status: w.status, lifecycle: broadcast.lifecycle };
}

// ---------------------------------------------------------------------------------------------
// webinar.fetch_recording (rule 9, edge cases 7 and 22)
// ---------------------------------------------------------------------------------------------

const FetchRecordingInput = z.object({
  webinarId: z.uuid(),
  /** Set by `setWebinarVideo`: the id staff chose, validated here. */
  videoId: z.string().optional(),
  field: z.enum(["youtube_video_id", "recording_video_id"]).optional(),
});

/**
 * `videos.list` for the recording (or the id staff set): when processed, sets
 * `recording_video_id` (if empty) and `duration_sec`; an id YouTube does not know sets
 * `broadcast_error = 'video_not_found'`. Not processed yet: nothing changes (the scan retries for 48 h).
 */
export async function runFetchRecording(ctx: JobCtx, input: z.infer<typeof FetchRecordingInput>) {
  const w = await lockWebinar(ctx.tx, input.webinarId);
  if (w.status === "cancelled" || w.status === "archived") return { skipped: w.status };
  if (input.videoId && input.field) {
    const current = input.field === "youtube_video_id" ? w.youtubeVideoId : w.recordingVideoId;
    if (current !== input.videoId) return { skipped: "superseded" };
  }
  const videoId = input.videoId ?? w.recordingVideoId ?? (w.mode === "live" && w.status === "ended" ? w.youtubeVideoId : null);
  if (!videoId) return { skipped: "no_video" };
  const video = await youtubeFor(ctx).getVideo(videoId);
  if (!video) {
    await ctx.tx.update(webinars).set({ broadcastError: "video_not_found", updatedAt: ctx.now }).where(eq(webinars.id, w.id));
    return { found: false };
  }
  if (!video.processed || !video.durationSec) return { processed: false };
  const isRecording = input.field !== "youtube_video_id" || w.status === "ended";
  if (!isRecording) return { processed: true, broadcast: videoId };
  await ctx.tx
    .update(webinars)
    .set({
      recordingVideoId: w.recordingVideoId ?? videoId,
      durationSec: video.durationSec,
      ...(w.broadcastError === "video_not_found" ? { broadcastError: null } : {}),
      updatedAt: ctx.now,
    })
    .where(eq(webinars.id, w.id));
  return { processed: true, durationSec: video.durationSec };
}

// ---------------------------------------------------------------------------------------------
// webinar.notify_registrants (rule 11, edge case 9)
// ---------------------------------------------------------------------------------------------

export const NOTIFY_CHUNK = 200;

const NotifyInput = z.object({
  webinarId: z.uuid(),
  reason: z.enum(["rescheduled", "cancelled"]),
  version: z.number().int().min(1),
  chunk: z.number().int().min(0),
  previousStartsAt: z.iso.datetime({ offset: true }).optional(),
});

/**
 * One chunk of 200 `registered` registrants: one `webinar.<reason>` email each (key
 * `webinar_reg:<id>:notice:<reason>:v<version>`), then the next chunk. A notice of a version a
 * later reschedule replaced is skipped (that one sends its own).
 */
export async function runNotifyRegistrants(ctx: JobCtx, input: z.infer<typeof NotifyInput>) {
  const [w] = await ctx.tx.select().from(webinars).where(eq(webinars.id, input.webinarId));
  if (!w) return { skipped: "not_found" };
  if (input.reason === "cancelled" && w.status !== "cancelled") return { skipped: w.status };
  if (input.reason === "rescheduled" && (w.version !== input.version || w.status !== "published")) return { skipped: "superseded" };
  const rows = await ctx.tx
    .select({ id: webinarRegistrations.id, personId: webinarRegistrations.personId, locale: webinarRegistrations.locale })
    .from(webinarRegistrations)
    .where(and(eq(webinarRegistrations.webinarId, w.id), eq(webinarRegistrations.status, "registered")))
    .orderBy(asc(webinarRegistrations.id))
    .limit(NOTIFY_CHUNK)
    .offset(input.chunk * NOTIFY_CHUNK);
  const reason: NoticeReason = input.reason;
  for (const r of rows) {
    const locale = r.locale;
    const data: Record<string, unknown> = {
      title: textIn(w.title, locale, w.spokenLocale),
      date: w.startsAt ? formatDateTime(w.startsAt, locale, "full") : "",
      url: landingUrl(w.slug, locale),
    };
    if (reason === "rescheduled") data.oldDate = input.previousStartsAt ? formatDateTime(new Date(input.previousStartsAt), locale, "full") : "";
    await sendTransactional(ctx, {
      template: `webinar.${reason}`,
      personId: r.personId,
      locale,
      data,
      context: { webinar_id: w.id, registration_id: r.id },
      key: noticeEmailKey(r.id, reason, input.version),
    });
  }
  if (rows.length === NOTIFY_CHUNK) {
    const next = input.chunk + 1;
    await ctx.enqueue({ kind: "webinar.notify_registrants", payload: { ...input, chunk: next }, key: jobKeys.notify(w.id, reason, input.version, next) });
  }
  return { sent: rows.length, chunk: input.chunk };
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

export const jobs = [
  defineJob({ kind: "webinar.create_broadcast", lane: "fast", priority: 3, maxAttempts: 6, input: WebinarIdInput, run: runCreateBroadcast, onDead: onCreateBroadcastDead }),
  defineJob({ kind: "webinar.update_broadcast", lane: "fast", priority: 3, maxAttempts: 6, input: UpdateBroadcastInput, run: runUpdateBroadcast }),
  defineJob({ kind: "webinar.delete_broadcast", lane: "fast", priority: 5, maxAttempts: 6, input: WebinarIdInput, run: runDeleteBroadcast }),
  defineJob({ kind: "webinar.create_meet_space", lane: "fast", priority: 5, maxAttempts: 6, input: WebinarIdInput, run: runCreateMeetSpace }),
  defineJob({ kind: "webinar.sync_status", lane: "fast", priority: 2, maxAttempts: 2, input: WebinarIdInput, run: runSyncStatus }),
  defineJob({ kind: "webinar.fetch_recording", lane: "fast", priority: 5, maxAttempts: 3, input: FetchRecordingInput, run: runFetchRecording }),
  defineJob({ kind: "webinar.notify_registrants", lane: "bulk", priority: 5, maxAttempts: 6, input: NotifyInput, run: runNotifyRegistrants }),
  defineJob({ kind: "webinar.scan_live", lane: "fast", priority: 2, maxAttempts: 2, input: ScanLiveInput, run: runScanLive }),
  defineJob({ kind: "webinar.scan_recordings", lane: "fast", priority: 2, maxAttempts: 2, input: ScanRecordingsInput, run: runScanRecordings }),
];
