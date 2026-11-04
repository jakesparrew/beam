/**
 * Tag api (crm spec 4.8), crm-P2: one tag per person at most (`person_tags` unique), and every
 * change records `tag.added` / `tag.removed` with `data.source` naming who caused that change
 * (the source that added the tag, or the one that removed it), so automation rule A-7 can
 * ignore what an automation or an import did.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { personTags, tags } from "@beam/db/schema";
import type { PersonTagSource } from "@beam/core/crm";
import { actorJson, and, eq, inArray, NotFoundError, sql } from "@/lib/ctx";
import type { EventCtx } from "../api";
import { lockActivePerson } from "../persons/api";

export async function applyTag(tx: Tx, ctx: EventCtx, personId: string, tagKey: string, source: PersonTagSource): Promise<{ applied: boolean }> {
  const tag = await tagByKey(tx, tagKey);
  const person = await lockActivePerson(tx, personId);
  const added = await addTagRows(tx, ctx, tag, [person.id], source);
  return { applied: added.length > 0 };
}

/**
 * Removes one tag from a person. `source` is who removes it (an automation's untag step passes
 * `'automation'`); when a caller leaves it out, a staff actor counts as `'manual'` and any other
 * actor (jobs, automations) as `'automation'`, so an unattributed removal never triggers journeys.
 */
export async function removeTag(tx: Tx, ctx: EventCtx, personId: string, tagKey: string, source?: PersonTagSource): Promise<{ removed: boolean }> {
  const tag = await tagByKey(tx, tagKey);
  const person = await lockActivePerson(tx, personId);
  const removed = await removeTagRows(tx, ctx, tag, [person.id], source ?? (ctx.actor.kind === "staff" ? "manual" : "automation"));
  return { removed: removed.length > 0 };
}

// ---------------------------------------------------------------------------
// helpers shared with this area's actions
// ---------------------------------------------------------------------------

export type TagRef = { id: string; key: string; isSystem: boolean };

export async function tagByKey(tx: DbOrTx, key: string): Promise<TagRef> {
  const [tag] = await tx.select({ id: tags.id, key: tags.key, isSystem: tags.isSystem }).from(tags).where(eq(tags.key, key));
  if (!tag) throw new NotFoundError(`unknown_tag: ${key}`);
  return tag;
}

export async function tagById(tx: DbOrTx, id: string): Promise<TagRef> {
  const [tag] = await tx.select({ id: tags.id, key: tags.key, isSystem: tags.isSystem }).from(tags).where(eq(tags.id, id));
  if (!tag) throw new NotFoundError("tag_not_found");
  return tag;
}

/** Inserts the missing `person_tags` rows of active persons and records one `tag.added` each. */
export async function addTagRows(tx: DbOrTx, ctx: EventCtx, tag: TagRef, personIds: string[], source: PersonTagSource): Promise<string[]> {
  if (!personIds.length) return [];
  const active = await tx.execute(sql`select id::text as id from persons where id in (${sql.join(personIds.map((id) => sql`${id}::uuid`), sql`, `)})
    and erased_at is null and merged_into_person_id is null`);
  const ids = rowsOfIds(active);
  if (!ids.length) return [];
  const inserted = await tx
    .insert(personTags)
    .values(ids.map((personId) => ({ personId, tagId: tag.id, source, addedBy: actorJson(ctx.actor) })))
    .onConflictDoNothing({ target: [personTags.personId, personTags.tagId] })
    .returning({ personId: personTags.personId });
  for (const { personId } of inserted) {
    await ctx.recordEvent({ kind: "tag.added", personId, data: { tag_key: tag.key, source } });
  }
  return inserted.map((r) => r.personId);
}

/**
 * Deletes `person_tags` rows and records one `tag.removed` each, with `source` = who removed the
 * tag (not the source that once added it: A-7 must see an automation's untag as `'automation'`).
 */
export async function removeTagRows(tx: DbOrTx, ctx: EventCtx, tag: TagRef, personIds: string[] | "all", source: PersonTagSource): Promise<string[]> {
  if (personIds !== "all" && !personIds.length) return [];
  const where = personIds === "all" ? eq(personTags.tagId, tag.id) : and(eq(personTags.tagId, tag.id), inArray(personTags.personId, personIds));
  const removed = await tx.delete(personTags).where(where).returning({ personId: personTags.personId });
  for (const { personId } of removed) {
    await ctx.recordEvent({ kind: "tag.removed", personId, data: { tag_key: tag.key, source } });
  }
  return removed.map((r) => r.personId);
}

function rowsOfIds(result: unknown): string[] {
  const rows = result && typeof result === "object" && "rows" in result ? (result as { rows: { id: string }[] }).rows : (result as { id: string }[]);
  return rows.map((r) => r.id);
}
