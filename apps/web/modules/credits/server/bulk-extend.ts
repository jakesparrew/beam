/**
 * Bulk extension of grants for closure periods (credits rule 32a, blueprint 9 "closed days";
 * credits-P3). Staff create a `credit_bulk_extensions` row (`startBulkExtension`, `credits.adjust`);
 * job `credits.bulk_extend` extends 500 matching `active` or `exhausted` grants per run, each under
 * its grant lock (validated before any write), then enqueues the next chunk. Membership inclusion grants are
 * never matched; expired grants are skipped. Re-running is harmless (entry keys
 * `extend:bulk:<bulk_extension_id>:<grant_id>`).
 */
import type { DbOrTx } from "@beam/db";
import { creditBulkExtensions, creditEntries, creditGrants, type BulkExtensionFilterJson } from "@beam/db/schema";
import { addBrusselsDays, BulkExtendInput } from "@beam/core/credits";
import { and, asc, ConflictError, eq, inArray, sql, ValidationError, type Ctx, type SQL } from "@/lib/ctx";
import { extend, lockGrants } from "./ledger";

/** Grants handled per job run. */
export const BULK_EXTEND_CHUNK = 500;

export type BulkExtensionFilter = {
  kinds: BulkExtensionFilterJson["kinds"];
  sources: BulkExtensionFilterJson["sources"];
  expiresFromOn: string;
  expiresToOn: string;
};

const toJson = (f: BulkExtensionFilter): BulkExtensionFilterJson => ({
  kinds: [...f.kinds],
  sources: f.sources.filter((s) => s !== "membership"),
  expires_from_on: f.expiresFromOn,
  expires_to_on: f.expiresToOn,
});

/** The grants a filter matches: `active` or `exhausted`, never `membership`, expiring (Brussels date) in the range. */
function matching(f: BulkExtensionFilterJson, afterId?: string): SQL {
  const sources = f.sources.filter((s) => s !== "membership");
  return and(
    inArray(creditGrants.status, ["active", "exhausted"]),
    inArray(creditGrants.creditKind, f.kinds.length ? f.kinds : ["day"]),
    sources.length ? inArray(creditGrants.source, sources) : sql`false`,
    sql`${creditGrants.source} <> 'membership'`,
    sql`${creditGrants.expiresAt} is not null`,
    sql`(${creditGrants.expiresAt} at time zone 'Europe/Brussels')::date between ${f.expires_from_on}::date and ${f.expires_to_on}::date`,
    afterId ? sql`${creditGrants.id} > ${afterId}::uuid` : sql`true`,
  )!;
}

/** The number of grants a bulk extension would extend now (the staff form's live preview). */
export async function previewBulkExtension(db: DbOrTx, filter: BulkExtensionFilter): Promise<{ matched: number }> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(creditGrants)
    .where(matching(toJson(filter)));
  return { matched: Number(r?.n ?? 0) };
}

/**
 * Creates the bulk extension row and enqueues `credits.bulk_extend` (key
 * `bulk_extend:<bulk_extension_id>:start`), with one audit row `credits.bulk_extended` for the
 * batch. The form's `clientKey` is the row id, so a double submit creates one row.
 */
export async function startBulkExtension(
  tx: DbOrTx,
  ctx: Ctx,
  raw: unknown,
): Promise<{ bulkExtensionId: string; matched: number; created: boolean }> {
  const parsed = BulkExtendInput.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const i of parsed.error.issues) fields[String(i.path[0] ?? "_")] ??= i.message;
    throw new ValidationError("validation", fields);
  }
  const input = parsed.data;
  if (ctx.actor.kind !== "staff") throw new ValidationError("staff_only", { actor: "staff" });
  const id = input.clientKey;
  const [existing] = await tx.select().from(creditBulkExtensions).where(eq(creditBulkExtensions.id, id));
  if (existing) return { bulkExtensionId: id, matched: existing.matchedCount, created: false };

  const filter = toJson({ kinds: input.kinds, sources: input.sources, expiresFromOn: input.expiresFromOn, expiresToOn: input.expiresToOn });
  const { matched } = await previewBulkExtension(tx, { kinds: input.kinds, sources: input.sources, expiresFromOn: input.expiresFromOn, expiresToOn: input.expiresToOn });
  await tx.insert(creditBulkExtensions).values({
    id,
    reason: input.reason.trim(),
    days: input.days,
    filter,
    status: "pending",
    matchedCount: matched,
    createdByUserId: ctx.actor.userId,
  });
  await ctx.enqueue({ kind: "credits.bulk_extend", payload: { bulkExtensionId: id }, key: `bulk_extend:${id}:start` });
  await ctx.audit({
    action: "credits.bulk_extended",
    entityType: "credit_bulk_extension",
    entityId: id,
    oldValue: null,
    newValue: { days: input.days, filter, matched },
  });
  return { bulkExtensionId: id, matched, created: true };
}

/**
 * One run of `credits.bulk_extend`: up to 500 matching grants after `afterId`, each extended by
 * `days` Brussels calendar days under its lock; a grant that cannot be extended (expired
 * meanwhile, beyond the extension limit) is skipped. Enqueues the next chunk or sets `done`.
 */
export async function runBulkExtension(
  ctx: Ctx,
  input: { bulkExtensionId: string; afterId?: string },
): Promise<{ processed: number; extended: number; skipped: number; done: boolean }> {
  const tx = ctx.tx;
  const [row] = await tx.select().from(creditBulkExtensions).where(eq(creditBulkExtensions.id, input.bulkExtensionId)).for("update");
  if (!row) throw new ConflictError("bulk_extension_not_found");
  if (row.status === "done") return { processed: 0, extended: 0, skipped: 0, done: true };
  if (row.status === "pending") {
    await tx.update(creditBulkExtensions).set({ status: "running", updatedAt: ctx.now }).where(eq(creditBulkExtensions.id, row.id));
  }

  const ids = await tx
    .select({ id: creditGrants.id })
    .from(creditGrants)
    .where(matching(row.filter, input.afterId))
    .orderBy(asc(creditGrants.id))
    .limit(BULK_EXTEND_CHUNK);

  let extended = 0;
  let skipped = 0;
  for (const { id } of ids) {
    try {
      const [grant] = await lockGrants(tx, [id]);
      if (!grant?.expiresAt || (grant.status !== "active" && grant.status !== "exhausted")) {
        skipped += 1;
        continue;
      }
      // `extend` validates before it writes, so a refused grant leaves nothing behind.
      const r = await extend(tx, ctx, {
        grantId: id,
        newExpiresAt: addBrusselsDays(grant.expiresAt, row.days),
        reason: row.reason,
        bulkExtensionId: row.id,
      });
      if (r.created) extended += 1;
    } catch (error) {
      if (error instanceof ConflictError || error instanceof ValidationError) skipped += 1;
      else throw error;
    }
  }

  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(creditEntries)
    .where(and(eq(creditEntries.kind, "extend"), eq(creditEntries.refType, "bulk_extension"), eq(creditEntries.refId, row.id)));
  const extendedCount = Number(count?.n ?? 0);
  const last = ids.at(-1)?.id;
  const done = ids.length < BULK_EXTEND_CHUNK || !last;
  if (!done) {
    await ctx.enqueue({ kind: "credits.bulk_extend", payload: { bulkExtensionId: row.id, afterId: last }, key: `bulk_extend:${row.id}:after:${last}` });
  }
  await tx
    .update(creditBulkExtensions)
    .set({ extendedCount, updatedAt: ctx.now, ...(done ? { status: "done" as const, finishedAt: ctx.now } : {}) })
    .where(eq(creditBulkExtensions.id, row.id));
  return { processed: ids.length, extended, skipped, done };
}
