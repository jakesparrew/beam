"use server";
/**
 * Tag actions (crm spec 4.1), crm-P2. Tags are created, renamed (LocalizedText, all three
 * locales), recoloured and deleted by staff with `persons.write`; system tags (`vip`,
 * `interest:*` of the seed) keep their key and cannot be deleted. Bulk tag and untag take at most
 * 5000 persons and audit counts only.
 */
import { z } from "zod";
import { personTags, tags } from "@beam/db/schema";
import { completeLocalizedText } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { ConflictError, eq, NotFoundError, sql } from "@/lib/ctx";
import { addTagRows, removeTagRows, tagById } from "./api";

const TagInput = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_:-]{1,62}$/),
  name: completeLocalizedText(),
  color: z.string().regex(/^#[0-9a-f]{6}$/),
  description: z.string().max(500).optional(),
});
const Bulk = z.object({ tagId: z.uuid(), personIds: z.array(z.uuid()).min(1).max(5000) });

export const createTag = action({ name: "crm.create_tag", audience: "staff", permission: "persons.write", input: TagInput, audit: false }, async (ctx, input) => {
  const [taken] = await ctx.tx.select({ id: tags.id }).from(tags).where(eq(tags.key, input.key));
  if (taken) throw new ConflictError("tag_key_taken");
  const [row] = await ctx.tx
    .insert(tags)
    .values({ key: input.key, name: input.name, color: input.color, description: input.description ?? null })
    .returning({ id: tags.id });
  await ctx.audit({ action: "tag.create", entityType: "tag", entityId: row!.id, newValue: input });
  return { id: row!.id };
});

export const updateTag = action(
  { name: "crm.update_tag", audience: "staff", permission: "persons.write", input: TagInput.extend({ id: z.uuid() }), audit: false },
  async (ctx, input) => {
    const [old] = await ctx.tx.select().from(tags).where(eq(tags.id, input.id)).for("update");
    if (!old) throw new NotFoundError("tag_not_found");
    if (old.isSystem && old.key !== input.key) throw new ConflictError("system_tag_key");
    if (old.key !== input.key) {
      const [taken] = await ctx.tx.select({ id: tags.id }).from(tags).where(eq(tags.key, input.key));
      if (taken) throw new ConflictError("tag_key_taken");
    }
    await ctx.tx
      .update(tags)
      .set({ key: input.key, name: input.name, color: input.color, description: input.description ?? null })
      .where(eq(tags.id, input.id));
    await ctx.audit({
      action: "tag.update",
      entityType: "tag",
      entityId: input.id,
      oldValue: { key: old.key, name: old.name, color: old.color, description: old.description },
      newValue: { key: input.key, name: input.name, color: input.color, description: input.description ?? null },
    });
    return { id: input.id };
  },
);

/** Refuses system tags; removes the tag from every person (one `tag.removed` each) before deleting it. */
export const deleteTag = action(
  { name: "crm.delete_tag", audience: "staff", permission: "persons.write", input: z.object({ id: z.uuid() }), audit: false },
  async (ctx, input): Promise<Record<string, never>> => {
    const tag = await tagById(ctx.tx, input.id);
    if (tag.isSystem) throw new ConflictError("system_tag");
    await ctx.tx.execute(sql`select id from tags where id = ${tag.id}::uuid for update`);
    const removed = await removeTagRows(ctx.tx, ctx, tag, "all");
    await ctx.tx.delete(personTags).where(eq(personTags.tagId, tag.id));
    await ctx.tx.delete(tags).where(eq(tags.id, tag.id));
    await ctx.audit({ action: "tag.delete", entityType: "tag", entityId: tag.id, oldValue: { key: tag.key, persons: removed.length } });
    return {};
  },
);

export const tagPersons = action({ name: "crm.tag_persons", audience: "staff", permission: "persons.write", input: Bulk, audit: false }, async (ctx, input) => {
  const tag = await tagById(ctx.tx, input.tagId);
  const added = await addTagRows(ctx.tx, ctx, tag, [...new Set(input.personIds)], "manual");
  await ctx.audit({ action: "tag.assign", entityType: "tag", entityId: tag.id, newValue: { added: added.length, requested: input.personIds.length } });
  return { changed: added.length };
});

export const untagPersons = action({ name: "crm.tag_persons", audience: "staff", permission: "persons.write", input: Bulk, audit: false }, async (ctx, input) => {
  const tag = await tagById(ctx.tx, input.tagId);
  const removed = await removeTagRows(ctx.tx, ctx, tag, [...new Set(input.personIds)]);
  await ctx.audit({ action: "tag.assign", entityType: "tag", entityId: tag.id, newValue: { removed: removed.length, requested: input.personIds.length } });
  return { changed: removed.length };
});
