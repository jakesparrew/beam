/**
 * webinar schedules (`defineSchedule`, cron in Europe/Brussels; webinar spec section 4.6). Facade
 * read by `pnpm gen:indexes`: every `kind` is a literal and is also a job in `jobs.ts`. A scan is
 * one indexed select, then one `enqueue` per webinar with the per-minute key of section 4.5.
 *
 * webinar-P2: `webinar.scan_live` (every minute) and `webinar.scan_recordings` (every 10
 * minutes). webinar-P4 adds `webinar.scan_finalise`, webinar-P6 `webinar.preflight`.
 */
import { z } from "zod";
import { webinars } from "@beam/db/schema";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "@/lib/ctx";
import { defineSchedule, type JobCtx } from "@/lib/job-runner";
import { jobKeys } from "./server/lifecycle";

export const ScanLiveInput = z.object({}).passthrough();
export const ScanRecordingsInput = z.object({}).passthrough();

/** A published webinar is synced from 30 minutes before its start. */
export const SYNC_LEAD_MS = 30 * 60_000;
/**
 * A published webinar that never went live is synced at most this long after its start
 * (`webinar.finalise` marks it `never_live` at 2 h; staff then reschedule or cancel).
 */
export const SYNC_TAIL_MS = 6 * 3600_000;
/** Recordings are polled for 48 hours (edge case 22). */
export const RECORDING_WINDOW_MS = 48 * 3600_000;

/** `webinar.sync_status` for live and simulive webinars that are live or about to start. */
export async function runScanLive(ctx: JobCtx): Promise<{ enqueued: number }> {
  const now = ctx.now;
  const rows = await ctx.tx
    .select({ id: webinars.id })
    .from(webinars)
    .where(
      and(
        inArray(webinars.mode, ["live", "simulive"]),
        or(
          eq(webinars.status, "live"),
          and(
            eq(webinars.status, "published"),
            lte(webinars.startsAt, new Date(now.getTime() + SYNC_LEAD_MS)),
            gt(webinars.startsAt, new Date(now.getTime() - SYNC_TAIL_MS)),
          ),
        ),
      ),
    );
  for (const r of rows) await ctx.enqueue({ kind: "webinar.sync_status", payload: { webinarId: r.id }, key: jobKeys.status(r.id, now) });
  return { enqueued: rows.length };
}

/**
 * `webinar.fetch_recording` for live webinars ended less than 48 h ago without a duration, and
 * for any webinar whose recording is set without a duration and changed in the last 48 h
 * (simulive and on-demand uploads still processing).
 */
export async function runScanRecordings(ctx: JobCtx): Promise<{ enqueued: number }> {
  const now = ctx.now;
  const since = new Date(now.getTime() - RECORDING_WINDOW_MS);
  const rows = await ctx.tx
    .select({ id: webinars.id })
    .from(webinars)
    .where(
      and(
        isNull(webinars.durationSec),
        sql`${webinars.status} not in ('cancelled', 'archived')`,
        or(
          and(eq(webinars.mode, "live"), eq(webinars.status, "ended"), gt(webinars.liveEndedAt, since)),
          and(isNotNull(webinars.recordingVideoId), gt(webinars.updatedAt, since)),
        ),
      ),
    );
  for (const r of rows) await ctx.enqueue({ kind: "webinar.fetch_recording", payload: { webinarId: r.id }, key: jobKeys.recording(r.id, now) });
  return { enqueued: rows.length };
}

export const schedules = [
  defineSchedule({ kind: "webinar.scan_live", cron: "* * * * *", catchUp: false }),
  defineSchedule({ kind: "webinar.scan_recordings", cron: "*/10 * * * *", catchUp: false }),
];
