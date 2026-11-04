/**
 * WordPress import jobs (site spec section 4, rules 52-53, 64-66): `site.parse_wordpress`,
 * `site.fetch_wordpress_media` and `site.apply_wordpress`. Handler stubs by site-P1 with the names
 * and inputs that `jobs.ts` registers; site-P7 implements them and keeps names and signatures.
 */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import type { JobCtx } from "@/lib/job-runner";

type DeadError = { message: string; permanent: boolean };
const notYet = (kind: string): Promise<never> => Promise.reject(new NotImplementedError(kind));

export const ParseWordpressInput = z.object({ importId: z.string().uuid() });
export type ParseWordpressInput = z.infer<typeof ParseWordpressInput>;

export const FetchWordpressMediaInput = z.object({ importId: z.string().uuid(), n: z.number().int().min(0) });
export type FetchWordpressMediaInput = z.infer<typeof FetchWordpressMediaInput>;

/** `round` = number of `retryImportErrors` calls (0 first), part of the idempotency key. */
export const ApplyWordpressInput = z.object({ importId: z.string().uuid(), offset: z.number().int().min(0), round: z.number().int().min(0) });
export type ApplyWordpressInput = z.infer<typeof ApplyWordpressInput>;

export function parseWordpress(_ctx: JobCtx, _input: ParseWordpressInput): Promise<unknown> {
  return notYet("site.parse_wordpress");
}

/** A dead parse sets the import `failed`. */
export function onParseWordpressDead(_ctx: JobCtx, _input: ParseWordpressInput, _error: DeadError): Promise<void> {
  return Promise.resolve();
}

export function fetchWordpressMedia(_ctx: JobCtx, _input: FetchWordpressMediaInput): Promise<unknown> {
  return notYet("site.fetch_wordpress_media");
}

export function applyWordpress(_ctx: JobCtx, _input: ApplyWordpressInput): Promise<unknown> {
  return notYet("site.apply_wordpress");
}

/** A dead apply chunk sets the import `failed` (rule 66). */
export function onApplyWordpressDead(_ctx: JobCtx, _input: ApplyWordpressInput, _error: DeadError): Promise<void> {
  return Promise.resolve();
}
