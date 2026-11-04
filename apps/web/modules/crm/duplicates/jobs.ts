/**
 * Duplicate jobs (crm spec 4.5), crm-P4. The kinds, inputs and lanes are declared in
 * `apps/web/modules/crm/jobs.ts`. Both jobs only upsert `person_duplicate_candidates`: a second
 * run with the same data writes nothing, and a dismissed pair is never re-opened (rule 3.28).
 */
import { z } from "zod";
import { TIME_ZONE } from "@beam/core/i18n";
import { sql } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { findDuplicatePairs, upsertCandidates } from "./api";

/** `crm.check_duplicates`, key `dupcheck:<person_id>:<version>`. */
export const CheckDuplicatesInput = z.object({ personId: z.uuid() });

/** `crm.detect_duplicates`, 2,000 persons per run by id order, then itself with the next `afterId`. */
export const DetectDuplicatesInput = z.object({ afterId: z.uuid().optional() });

/** Persons scanned per `crm.detect_duplicates` run. */
export const DETECT_BATCH = 2000;

const brusselsDay = (at: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

/** Scores one person against every active person and upserts the pairs scoring 50 or more. */
export async function runCheckDuplicates(ctx: JobCtx, input: z.infer<typeof CheckDuplicatesInput>): Promise<{ candidates: number }> {
  const pairs = await findDuplicatePairs(ctx.tx, sql`x.id = ${input.personId}`);
  await upsertCandidates(ctx.tx, pairs);
  return { candidates: pairs.length };
}

/**
 * The nightly scan: the next 2,000 active persons after `afterId` by id, each scored against
 * every active person. When the batch is full the job enqueues itself with the last id of the
 * batch (`dupscan:<YYYY-MM-DD>:<after_id>`, Brussels day).
 */
export async function runDetectDuplicates(ctx: JobCtx, input: z.infer<typeof DetectDuplicatesInput>): Promise<{ scanned: number; next: string | null }> {
  const after = input.afterId ?? null;
  const batch = rowsOf<{ id: string }>(
    await ctx.tx.execute(sql`
      select id from persons
      where erased_at is null and merged_into_person_id is null ${after ? sql`and id > ${after}` : sql``}
      order by id
      limit ${DETECT_BATCH}
    `),
  );
  if (!batch.length) return { scanned: 0, next: null };
  const first = batch[0]!.id;
  const last = batch[batch.length - 1]!.id;
  const pairs = await findDuplicatePairs(ctx.tx, sql`x.id >= ${first} and x.id <= ${last}`);
  await upsertCandidates(ctx.tx, pairs);
  const next = batch.length === DETECT_BATCH ? last : null;
  if (next) {
    await ctx.enqueue({ kind: "crm.detect_duplicates", payload: { afterId: next }, key: `dupscan:${brusselsDay(ctx.now)}:${next}` });
  }
  return { scanned: batch.length, next };
}
