/**
 * `site.audit_content` (R4, site spec section 4): the weekly Claude content and SEO audit. Handler
 * stub by site-P1 with the name and input that `jobs.ts` registers; site-P10 implements it and
 * adds the Monday 07:10 schedule. Idempotency key `schedule:site.audit_content:<YYYY-MM-DDTHH:mm>`.
 */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import type { JobCtx } from "@/lib/job-runner";

export const AuditContentInput = z.object({}).passthrough();
export type AuditContentInput = z.infer<typeof AuditContentInput>;

export function auditContent(_ctx: JobCtx, _input: AuditContentInput): Promise<unknown> {
  return Promise.reject(new NotImplementedError("site.audit_content"));
}
