/**
 * `site.publish_version` (site spec section 4, rule 13): scheduled publishing at `run_at`. Handler
 * stub by site-P1 with the name and input that `jobs.ts` registers; site-P3 implements it and
 * keeps the name and signature. Idempotency key
 * `page_version:<version_id>:publish:<scheduled_publish_at YYYY-MM-DDTHH:mm>`.
 */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import type { JobCtx } from "@/lib/job-runner";

export const PublishVersionInput = z.object({
  versionId: z.string().uuid(),
  /** ISO instant of `scheduled_publish_at` when the job was enqueued; a changed schedule makes it a no-op. */
  scheduledPublishAt: z.string().datetime({ offset: true }),
});
export type PublishVersionInput = z.infer<typeof PublishVersionInput>;

export function publishScheduledVersion(_ctx: JobCtx, _input: PublishVersionInput): Promise<unknown> {
  return Promise.reject(new NotImplementedError("site.publish_version"));
}
