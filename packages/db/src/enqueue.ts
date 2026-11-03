import { eq } from "drizzle-orm";
import type { DbOrTx } from "./client";
import { jobs } from "./schema/platform";

export type EnqueueDbInput = {
  kind: string;
  payload: unknown;
  /** The idempotency key; a second enqueue with the same key inserts nothing (PL-24). */
  key: string;
  runAt?: Date;
  lane?: "fast" | "bulk";
  priority?: number;
  maxAttempts?: number;
  /** Callers may pick the job id (webhooks store it before the job exists, PL-39). */
  id?: string;
  requestId?: string;
};

/**
 * Inserts a `jobs` row inside the caller's transaction. It knows nothing about the job
 * registry: `ctx.enqueue` (apps/web/lib) adds the definition's defaults and validates the
 * payload. A key that already exists inserts nothing and returns the existing row's id with
 * `inserted: false` (PL-24).
 */
export async function enqueue(
  tx: DbOrTx,
  input: EnqueueDbInput,
): Promise<{ id: string; inserted: boolean }> {
  const inserted = await tx
    .insert(jobs)
    .values({
      ...(input.id ? { id: input.id } : {}),
      kind: input.kind,
      payload: input.payload ?? {},
      idempotencyKey: input.key,
      ...(input.runAt ? { runAt: input.runAt } : {}),
      ...(input.lane ? { lane: input.lane } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.maxAttempts !== undefined
        ? { maxAttempts: input.maxAttempts }
        : {}),
      requestId: input.requestId ?? null,
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning({ id: jobs.id });
  const row = inserted[0];
  if (row) return { id: row.id, inserted: true };

  const existing = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.idempotencyKey, input.key))
    .limit(1);
  const found = existing[0];
  if (!found)
    throw new Error(
      `enqueue: job with key "${input.key}" neither inserted nor found`,
    );
  return { id: found.id, inserted: false };
}
