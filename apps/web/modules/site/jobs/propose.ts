/**
 * `site.propose_page` (site spec section 4, rules 41-44). Handler stubs by site-P1 with the names
 * and inputs that `jobs.ts` registers; site-P4 implements them (Claude through `callClaude`,
 * `ProposalOutput`, one repair round) and keeps the names and signatures.
 */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import type { JobCtx } from "@/lib/job-runner";

export const ProposePageInput = z.object({ editRequestId: z.string().uuid() });
export type ProposePageInput = z.infer<typeof ProposePageInput>;

export function proposePage(_ctx: JobCtx, _input: ProposePageInput): Promise<unknown> {
  return Promise.reject(new NotImplementedError("site.propose_page"));
}

/** A dead job always leaves the request `failed` (`ai_unavailable`), so the page lock never sticks. */
export function onProposePageDead(_ctx: JobCtx, _input: ProposePageInput, _error: { message: string; permanent: boolean }): Promise<void> {
  return Promise.resolve();
}
