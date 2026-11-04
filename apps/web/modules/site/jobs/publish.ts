/**
 * `site.publish_version` (site spec section 4, rule 13): scheduled publishing at `run_at`; site-P3.
 * Idempotency key `page_version:<version_id>:publish:<scheduled_publish_at YYYY-MM-DDTHH:mm>`.
 * Publishes only while the version is still `draft`/`proposed` and its `scheduled_publish_at`
 * equals the payload (a cancelled or moved schedule makes the job a no-op). Failed checks clear
 * the schedule and write audit `site.page.schedule_failed` (system actor); no retry. A second run
 * finds the version published and does nothing.
 */
import { z } from "zod";
import { pageVersions } from "@beam/db/schema";
import { eq } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { pageTags, revalidateSite } from "../server/cache";
import { publishVersionTx, PublishBlockedError } from "../server/publish";
import { getVersionRow } from "../server/versions";

export const PublishVersionInput = z.object({
  versionId: z.string().uuid(),
  /** ISO instant of `scheduled_publish_at` when the job was enqueued; a changed schedule makes it a no-op. */
  scheduledPublishAt: z.string().datetime({ offset: true }),
  /** The staff member who scheduled it (named in the publish audit row). */
  scheduledByUserId: z.string().uuid().optional(),
});
export type PublishVersionInput = z.infer<typeof PublishVersionInput>;

export type PublishScheduledResult = { outcome: "published"; publishedAt: string } | { outcome: "skipped"; reason: string } | { outcome: "failed"; issues: number };

export async function publishScheduledVersion(ctx: JobCtx, input: PublishVersionInput): Promise<PublishScheduledResult> {
  const version = await getVersionRow(ctx.tx, input.versionId);
  if (!version) return { outcome: "skipped", reason: "version_missing" };
  if (version.state !== "draft" && version.state !== "proposed") return { outcome: "skipped", reason: `version_${version.state}` };
  const expected = new Date(input.scheduledPublishAt).getTime();
  if (!version.scheduledPublishAt || version.scheduledPublishAt.getTime() !== expected) return { outcome: "skipped", reason: "schedule_changed" };
  try {
    const { publishedAt } = await publishVersionTx(ctx.tx, ctx, version.id, { scheduledBy: input.scheduledByUserId ?? "schedule" });
    revalidateSite(pageTags(version.pageId));
    return { outcome: "published", publishedAt: publishedAt.toISOString() };
  } catch (error) {
    if (!(error instanceof PublishBlockedError)) throw error;
    await ctx.tx.update(pageVersions).set({ scheduledPublishAt: null }).where(eq(pageVersions.id, version.id));
    await ctx.audit({
      action: "site.page.schedule_failed",
      entityType: "page_version",
      entityId: version.id,
      oldValue: { scheduledPublishAt: input.scheduledPublishAt },
      newValue: { pageId: version.pageId, issues: error.issues.map((i) => ({ code: i.code, locale: i.locale ?? null, blockId: i.blockId ?? null })) },
    });
    return { outcome: "failed", issues: error.issues.length };
  }
}
