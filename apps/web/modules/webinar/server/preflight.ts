/**
 * Pre-flight and SLA monitoring (webinar spec rules 42 and 43, decision 37; webinar-P6).
 *
 * - `webinar.preflight` (every 5 minutes, `runPreflightScan`): one indexed select of the
 *   `published` live and simulive webinars starting within 60 minutes (plus live drafts whose
 *   publishing is pending or failed: they have no broadcast yet), then one
 *   `webinar.preflight_check` per webinar and stage (`t60` within 60 minutes, `t15` within 15).
 *   The check runs at every scan of its window, so a problem that appears after the first scan
 *   (a broadcast error at 40 minutes) is still caught; the alert itself fires once.
 * - `webinar.preflight_check` (`runPreflightCheck`): stage `t60` alerts when a live webinar has no
 *   YouTube broadcast or a `broadcast_error`, or a simulive webinar has no processed recording
 *   (`notify.slack` High plus one task for `owner_user_id`); stage `t15` alerts when a live
 *   webinar's `youtube_lifecycle` is outside `ready`, `testing`, `live` ("stream not connected";
 *   the host console shows its red banner from the same rule, `preflightAlert`).
 * - The heartbeat-stopped alert (`checkHeartbeats`, called by `webinar.sync_status`): a webinar
 *   `live` for more than 5 minutes that had live segments but none in the last 3 minutes.
 *
 * Each alert fires once per webinar per stage: the Slack job's idempotency key and the task's
 * dedupe key carry the stage and the webinar `version`, so a reschedule (which bumps `version`)
 * checks the new time again. Nothing is sent to registrants and no personal data is in an alert.
 */
import { z } from "zod";
import { watchSegments, webinars } from "@beam/db/schema";
import { formatDateTime } from "@beam/core/i18n";
import { and, eq, gt, inArray, isNotNull, lte, or, sql } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { createTask } from "@/modules/crm/api";
import { CONNECTED_LIFECYCLES } from "./interactions";
import { minuteKey, textIn, type WebinarRow } from "./lifecycle";

export const PREFLIGHT_STAGES = ["t60", "t15"] as const;
export type PreflightStage = (typeof PREFLIGHT_STAGES)[number];

/** Minutes before `starts_at` at which a stage begins (rule 42). */
export const STAGE_MINUTES: Record<PreflightStage, number> = { t60: 60, t15: 15 };

/** Rule 43: live for more than this before the heartbeat check applies. */
export const HEARTBEAT_LIVE_FOR_MS = 5 * 60_000;
/** Rule 43: no live segment for this long means heartbeat ingestion stopped. */
export const HEARTBEAT_SILENCE_MS = 3 * 60_000;

export type PreflightProblem = "no_broadcast" | "broadcast_error" | "recording_missing" | "stream_not_connected";

export const PreflightScanInput = z.object({}).passthrough();
export const PreflightCheckInput = z.object({ webinarId: z.uuid(), stage: z.enum(PREFLIGHT_STAGES) });

/** Idempotency and dedupe keys of rule 42 (the check runs per scan; the alert once per stage and version). */
export const preflightKeys = {
  check: (id: string, stage: PreflightStage, now: Date) => `webinar:${id}:preflight_check:${stage}:${minuteKey(now)}`,
  slack: (id: string, stage: PreflightStage, version: number) => `webinar:${id}:preflight:${stage}:v${version}`,
  task: (id: string, stage: PreflightStage, version: number) => `webinar_preflight:${id}:${stage}:v${version}`,
  heartbeat: (id: string, version: number) => `webinar:${id}:alert:heartbeat:v${version}`,
} as const;

/**
 * A live webinar staff tried to publish that is still `draft`: the broadcast is being created
 * (`publish_requested_at`) or creating it failed (`broadcast_error`). A published live webinar
 * always has its broadcast id (`ck_webinars_live_video`), so this is the "without a broadcast"
 * case of rule 42.
 */
const isPublishing = (w: Pick<WebinarRow, "mode" | "status" | "publishRequestedAt" | "broadcastError">) =>
  w.mode === "live" && w.status === "draft" && (w.publishRequestedAt !== null || w.broadcastError !== null);

/**
 * What is wrong with a webinar at a stage, or null. `published` live and simulive webinars that
 * have not started are checked, and live drafts whose publishing is pending or failed.
 */
export function preflightProblem(
  w: Pick<
    WebinarRow,
    "mode" | "status" | "startsAt" | "youtubeVideoId" | "broadcastError" | "recordingVideoId" | "durationSec" | "youtubeLifecycle" | "publishRequestedAt"
  >,
  stage: PreflightStage,
  now: Date,
): PreflightProblem | null {
  if (!(w.status === "published" || isPublishing(w)) || !w.startsAt || w.mode === "on_demand") return null;
  const until = w.startsAt.getTime() - now.getTime();
  if (until <= 0 || until > STAGE_MINUTES[stage] * 60_000) return null;
  if (stage === "t60") {
    if (w.mode === "simulive") return w.recordingVideoId && w.durationSec ? null : "recording_missing";
    if (!w.youtubeVideoId) return "no_broadcast";
    return w.broadcastError ? "broadcast_error" : null;
  }
  if (w.mode !== "live") return null;
  return (CONNECTED_LIFECYCLES as readonly string[]).includes(w.youtubeLifecycle ?? "") ? null : "stream_not_connected";
}

const PROBLEM_TEXT: Record<PreflightProblem, string> = {
  no_broadcast: "no YouTube broadcast yet",
  broadcast_error: "YouTube broadcast error",
  recording_missing: "the simulive video is not processed yet",
  stream_not_connected: "stream not connected",
};

const adminUrl = (id: string) => `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/admin/webinars/${id}`;

/** The Slack line (no personal data: slug, title in the spoken language, Brussels time, link). */
export function preflightText(w: WebinarRow, stage: PreflightStage, problem: PreflightProblem): string {
  const when = w.startsAt ? formatDateTime(w.startsAt, "en", "medium") : "";
  const error = problem === "broadcast_error" && w.broadcastError ? ` (${w.broadcastError.slice(0, 200)})` : "";
  const title = textIn(w.title, w.spokenLocale) || w.slug;
  return `Webinar pre-flight ${stage}: "${title}" (${w.slug}) starts ${when} Brussels time: ${PROBLEM_TEXT[problem]}${error}. ${adminUrl(w.id)}`;
}

export type PreflightResult = { problem: PreflightProblem | null; alerted: boolean; taskCreated: boolean };

/** `webinar.preflight_check`: checks one webinar at one stage and alerts once (rule 42). */
export async function runPreflightCheck(ctx: JobCtx, input: z.infer<typeof PreflightCheckInput>): Promise<PreflightResult> {
  const [w] = await ctx.tx.select().from(webinars).where(eq(webinars.id, input.webinarId));
  if (!w) return { problem: null, alerted: false, taskCreated: false };
  const problem = preflightProblem(w, input.stage, ctx.now);
  if (!problem) return { problem: null, alerted: false, taskCreated: false };
  const slack = await ctx.enqueue({
    kind: "notify.slack",
    payload: { fingerprint: `webinar_preflight:${w.id}:${input.stage}`, severity: "high", text: preflightText(w, input.stage, problem) },
    key: preflightKeys.slack(w.id, input.stage, w.version),
  });
  let taskCreated = false;
  if (input.stage === "t60") {
    const task = await createTask(ctx.tx, ctx, {
      title: "Webinar not ready to go live",
      kind: "follow_up",
      source: "system",
      ownerUserId: w.ownerUserId,
      dueAt: w.startsAt ?? ctx.now,
      priority: "high",
      ref: { type: "webinar", id: w.id },
      notes: `Pre-flight ${input.stage}: ${PROBLEM_TEXT[problem]}. Fix it on the webinar page before the start.`,
      dedupeKey: preflightKeys.task(w.id, input.stage, w.version),
    });
    taskCreated = task.created;
  }
  return { problem, alerted: slack.inserted, taskCreated };
}

/** `webinar.preflight` (every 5 minutes): one check per webinar and stage in its window. */
export async function runPreflightScan(ctx: JobCtx): Promise<{ enqueued: number }> {
  const now = ctx.now;
  const rows = await ctx.tx
    .select({ id: webinars.id, startsAt: webinars.startsAt })
    .from(webinars)
    .where(
      and(
        or(
          eq(webinars.status, "published"),
          and(eq(webinars.status, "draft"), eq(webinars.mode, "live"), or(isNotNull(webinars.publishRequestedAt), isNotNull(webinars.broadcastError))),
        ),
        inArray(webinars.mode, ["live", "simulive"]),
        gt(webinars.startsAt, now),
        lte(webinars.startsAt, new Date(now.getTime() + STAGE_MINUTES.t60 * 60_000)),
      ),
    );
  let enqueued = 0;
  for (const r of rows) {
    for (const stage of PREFLIGHT_STAGES) {
      if (r.startsAt!.getTime() - now.getTime() > STAGE_MINUTES[stage] * 60_000) continue;
      await ctx.enqueue({ kind: "webinar.preflight_check", payload: { webinarId: r.id, stage }, key: preflightKeys.check(r.id, stage, now) });
      enqueued++;
    }
  }
  return { enqueued };
}

/**
 * Rule 43, inside `webinar.sync_status`: a webinar `live` for more than 5 minutes that had live
 * segments but none in the last 3 minutes sends one Slack line "heartbeats failing" per webinar
 * and version. Returns whether this call enqueued the alert.
 */
export async function checkHeartbeats(ctx: JobCtx, w: Pick<WebinarRow, "id" | "slug" | "status" | "liveStartedAt" | "version">): Promise<boolean> {
  if (w.status !== "live" || !w.liveStartedAt) return false;
  if (ctx.now.getTime() - w.liveStartedAt.getTime() <= HEARTBEAT_LIVE_FOR_MS) return false;
  const [last] = await ctx.tx
    .select({ at: sql<Date | null>`max(${watchSegments.recordedAt})`.mapWith(watchSegments.recordedAt) })
    .from(watchSegments)
    .where(and(eq(watchSegments.webinarId, w.id), eq(watchSegments.mode, "live")));
  if (!last?.at) return false;
  if (ctx.now.getTime() - last.at.getTime() < HEARTBEAT_SILENCE_MS) return false;
  const out = await ctx.enqueue({
    kind: "notify.slack",
    payload: {
      fingerprint: `webinar_heartbeat:${w.id}`,
      severity: "high",
      text: `Webinar ${w.slug} is live but heartbeats are failing: no watch segment for ${HEARTBEAT_SILENCE_MS / 60_000} minutes. ${adminUrl(w.id)}`,
    },
    key: preflightKeys.heartbeat(w.id, w.version),
  });
  return out.inserted;
}
