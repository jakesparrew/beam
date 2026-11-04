/**
 * Abuse limits of the public form pipeline (forms spec rules R2 and R3). R1 (WAF) and R4 (64 KB
 * body) live in front of the routes. Every limit goes through platform's `rateLimit()` in the
 * caller's transaction and throws `RateLimitedError` (`429 rate_limited` with `retry-after`).
 * Bot submissions (honeypot filled, or submitted less than 3 seconds after start) write nothing:
 * the caller answers a normal-looking thank-you and `logBotDropped` logs ids only.
 */
import { createHash } from "node:crypto";
import type { DbOrTx } from "@beam/db";
import { RateLimitedError } from "@/lib/ctx";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";

export const START_LIMIT = { limit: 30, windowSeconds: 3600 } as const;
export const SUBMIT_LIMIT = { limit: 5, windowSeconds: 3600 } as const;
export const RESULT_LINK_LIMIT = { limit: 3, windowSeconds: 86_400 } as const;
/** R3: minimum seconds between `start` and `submit`. */
export const MIN_FILL_SECONDS = 3;

/** sha256 hex of the lower-cased, trimmed email (rate-limit keys, import erasure lookups). */
export function emailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

async function hit(tx: DbOrTx, key: string, spec: { limit: number; windowSeconds: number }, now: Date): Promise<void> {
  const v = await rateLimit(tx, { key, ...spec }, now);
  if (!v.ok) throw new RateLimitedError(v.retryAfterSeconds);
}

/** R2: at most 30 starts per form per IP per hour. */
export function limitStart(tx: DbOrTx, formId: string, ipHash: string, now: Date): Promise<void> {
  return hit(tx, `form_start:${formId}:${ipHash}`, START_LIMIT, now);
}

/** R2: at most 5 completions per form per email per hour. */
export function limitSubmit(tx: DbOrTx, formId: string, email: string, now: Date): Promise<void> {
  return hit(tx, `form_submit:${formId}:${emailHash(email)}`, SUBMIT_LIMIT, now);
}

/** R2 and ID8: at most 3 result-link requests per form per email per day. */
export function limitResultLink(tx: DbOrTx, formId: string, email: string, now: Date): Promise<void> {
  return hit(tx, `form_link:${formId}:${emailHash(email)}`, RESULT_LINK_LIMIT, now);
}

/** R3: a filled honeypot (`website`) or a submit within 3 seconds of `start`. */
export function isBotSubmission(i: { honeypot?: string | null; startedAt: Date; now: Date }): boolean {
  if (typeof i.honeypot === "string" && i.honeypot.trim() !== "") return true;
  return i.now.getTime() - i.startedAt.getTime() < MIN_FILL_SECONDS * 1000;
}

/** R3: logs the drop with ids only. */
export function logBotDropped(i: { formId: string; submissionId: string; reason: "honeypot" | "too_fast" }): void {
  logger.info({ event: "forms.bot_dropped", formId: i.formId, submissionId: i.submissionId, reason: i.reason }, "forms.bot_dropped");
}
