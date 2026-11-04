/**
 * Segment refresh jobs (crm spec 4.5, rules 3.40 and 3.41), crm-P5. The kinds, inputs and lanes
 * are declared in `apps/web/modules/crm/jobs.ts`.
 *
 * `segments.refresh_one` runs the refresh under a 45 s statement timeout (decision 27, edge case
 * 19). On failure the job's transaction rolls back, so `refresh_error` is stored with a durable
 * write (it survives the rollback), the previous members stay, and the job retries
 * (`RetryableError`); the next scheduled refresh also retries.
 */
import { z } from "zod";
import { segments } from "@beam/db/schema";
import { and, eq, NotFoundError, sql, writeDurably } from "@/lib/ctx";
import { RetryableError, type JobCtx } from "@/lib/job-runner";
import { hourBucket, refreshSegmentInTx, SegmentRefreshError } from "./api";

/** `segments.refresh`: enqueues `segments.refresh_one` per non-archived dynamic segment. */
export const RefreshSegmentsInput = z.object({});

/** `segments.refresh_one`, key `segment:<id>:refresh:<YYYY-MM-DDTHH>` (schedule) or `segment:<id>:refresh:<reason>:<ref>`. */
export const RefreshSegmentInput = z.object({
  segmentId: z.uuid(),
  reason: z.enum(["schedule", "save", "campaign", "manual"]),
});

/** The statement timeout of one refresh, inside the job's 60 s budget. */
export const REFRESH_STATEMENT_TIMEOUT_MS = 45_000;

export async function runRefreshSegments(ctx: JobCtx, _input: z.infer<typeof RefreshSegmentsInput>): Promise<{ enqueued: number }> {
  const rows = await ctx.tx
    .select({ id: segments.id })
    .from(segments)
    .where(and(eq(segments.kind, "dynamic"), eq(segments.isArchived, false)))
    .orderBy(segments.id);
  const hour = hourBucket(ctx.now);
  for (const row of rows) {
    await ctx.enqueue({ kind: "segments.refresh_one", payload: { segmentId: row.id, reason: "schedule" }, key: `segment:${row.id}:refresh:${hour}` });
  }
  return { enqueued: rows.length };
}

export async function runRefreshSegment(ctx: JobCtx, input: z.infer<typeof RefreshSegmentInput>): Promise<{ count: number; entered: number; left: number }> {
  await ctx.tx.execute(sql.raw(`set local statement_timeout = ${REFRESH_STATEMENT_TIMEOUT_MS}`));
  try {
    return await refreshSegmentInTx(ctx.tx, ctx, input.segmentId, input.reason);
  } catch (error) {
    // A segment that no longer exists has nothing to refresh.
    if (error instanceof NotFoundError) return { count: 0, entered: 0, left: 0 };
    if (error instanceof SegmentRefreshError) {
      const message = error.message.replace(/^segment_refresh_failed: /, "");
      await writeDurably(ctx, async (db) => {
        await db.update(segments).set({ refreshError: message }).where(eq(segments.id, input.segmentId));
      });
      throw new RetryableError(error.message, { cause: error });
    }
    throw error;
  }
}
