/**
 * crm's segment archive guard (email spec section 4 "Cross-module API", section 10): a segment is
 * in use while a campaign that has not reached a terminal status (`sent`, `stopped`,
 * `cancelled`) targets it as its audience or lists it among its exclusions.
 *
 * Reads through the caller's `db`/transaction (OD-15): crm's `archiveSegment` passes its own
 * `ctx.tx`, so the check and the archive see the same snapshot.
 */
import type { DbOrTx } from "@beam/db";
import { campaigns } from "@beam/db/schema";
import { ACTIVE_CAMPAIGN_STATUSES } from "@beam/core/email";
import { and, eq, inArray, or, sql } from "@/lib/ctx";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a non-terminal campaign uses the segment as audience or exclusion. */
export async function isSegmentInUse(db: DbOrTx, segmentId: string): Promise<boolean> {
  // A value that is not a uuid can never be stored in `segment_id` or `exclude_segment_ids`.
  if (!UUID.test(segmentId)) return false;
  const [row] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        inArray(campaigns.status, [...ACTIVE_CAMPAIGN_STATUSES]),
        or(eq(campaigns.segmentId, segmentId), sql`${segmentId}::uuid = any(${campaigns.excludeSegmentIds})`),
      ),
    )
    .limit(1);
  return !!row;
}
