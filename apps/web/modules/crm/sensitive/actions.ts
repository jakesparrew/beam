"use server";
/**
 * Sensitive field actions (crm rules 3.23 to 3.26), crm-P4. Values are encrypted with platform's
 * `encryptSensitive` (AAD `person_sensitive_fields:<person_id>:<key>`) and read back only through
 * `readSensitive(ctx, personId, 'staff_view', scope)`. Neither action lets a value reach the
 * audit log, the timeline or the action's automatic audit row (`audit: false`).
 */
import { z } from "zod";
import type { DbOrTx } from "@beam/db";
import { personSensitiveFields, persons } from "@beam/db/schema";
import { SENSITIVE_FIELD_KEYS, type SensitiveFieldKey } from "@beam/core/privacy";
import { action } from "@/lib/action";
import { and, AppError, ConflictError, eq, NotFoundError, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { encryptSensitive, readSensitive, sensitiveAad } from "@/modules/platform/api";
import { resolvePersonIds } from "../persons/api";

async function requireActivePerson(tx: DbOrTx, personId: string): Promise<void> {
  const [row] = await tx.select({ erasedAt: persons.erasedAt, mergedInto: persons.mergedIntoPersonId }).from(persons).where(eq(persons.id, personId));
  if (!row) throw new NotFoundError("person_not_found");
  if (row.erasedAt) throw new ConflictError("person_erased");
  if (row.mergedInto) throw new ConflictError("person_merged");
}

/**
 * Sets (or with `value: null` clears) one sensitive field. Audit `sensitive.write` with
 * `{ key, changed: true }` only; event `sensitive.updated` with `{ key }`.
 */
export const setSensitiveField = action(
  {
    name: "crm.set_sensitive_field",
    audience: "staff",
    permission: "persons.sensitive_read",
    input: z.object({ personId: z.uuid(), key: z.enum(SENSITIVE_FIELD_KEYS), value: z.string().min(1).max(5000).nullable() }),
    audit: false,
  },
  async (ctx, input): Promise<Record<string, never>> => {
    await requireActivePerson(ctx.tx, input.personId);
    const userId = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
    const where = and(eq(personSensitiveFields.personId, input.personId), eq(personSensitiveFields.key, input.key));
    const [existing] = await ctx.tx.select({ id: personSensitiveFields.id }).from(personSensitiveFields).where(where).for("update");
    if (input.value === null) {
      if (!existing) return {};
      await ctx.tx.delete(personSensitiveFields).where(where);
    } else {
      const { valueEnc, keyVersion } = encryptSensitive(input.value, sensitiveAad.personField(input.personId, input.key));
      await ctx.tx
        .insert(personSensitiveFields)
        .values({ personId: input.personId, key: input.key, valueEnc, keyVersion, updatedByUserId: userId })
        .onConflictDoUpdate({
          target: [personSensitiveFields.personId, personSensitiveFields.key],
          set: { valueEnc, keyVersion, updatedByUserId: userId, updatedAt: ctx.now },
        });
    }
    await ctx.audit({
      action: "sensitive.write",
      entityType: "person",
      entityId: input.personId,
      personId: input.personId,
      oldValue: existing ? { key: input.key, changed: true } : null,
      newValue: { key: input.key, changed: true },
    });
    await ctx.recordEvent({ kind: "sensitive.updated", personId: input.personId, data: { key: input.key } });
    return {};
  },
);

/**
 * The owner of each requested sensitive note among the person and everyone merged into it
 * (rule 3.32: the 360 timeline lists the losers' notes too), grouped by owner. The owner comes
 * from the database, never from the client.
 */
async function noteOwners(tx: DbOrTx, personId: string, eventIds: readonly string[]): Promise<Map<string, string[]>> {
  const ids = await resolvePersonIds(tx, personId);
  const rows = rowsOf<{ id: string; person_id: string }>(
    await tx.execute(sql`select id::text as id, person_id::text as person_id from activity_events
      where is_sensitive and id::text in (${sql.join([...new Set(eventIds)].map((id) => sql`${id}`), sql`, `)})
      and person_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) order by id`),
  );
  const groups = new Map<string, string[]>();
  for (const r of rows) groups.set(r.person_id, [...(groups.get(r.person_id) ?? []), r.id]);
  return groups;
}

/**
 * Decrypts the requested fields or sensitive notes through `readSensitive` (purpose `staff_view`,
 * which writes the `sensitive.read` audit row with the keys and event ids, never the values).
 * At least one key or event id is required. Fields are read for `personId`; each note is read
 * for the person that owns it among `personId` and the persons merged into it (one
 * `readSensitive` call and audit row per owner), so a merged loser's note can be revealed on the
 * winner's timeline.
 */
export const revealSensitive = action(
  {
    name: "crm.reveal_sensitive",
    audience: "staff",
    permission: "persons.sensitive_read",
    input: z.object({ personId: z.uuid(), keys: z.array(z.enum(SENSITIVE_FIELD_KEYS)).optional(), eventIds: z.array(z.string().regex(/^[0-9]+$/)).max(50).optional() }),
    audit: false,
  },
  async (ctx, input): Promise<{ fields: Partial<Record<SensitiveFieldKey, string>>; notes: { eventId: string; body: string }[] }> => {
    if (!input.keys?.length && !input.eventIds?.length) throw new AppError("validation", "nothing_to_reveal", { keys: "required" });
    const groups = input.eventIds?.length ? await noteOwners(ctx.tx, input.personId, input.eventIds) : new Map<string, string[]>();
    // The page's person: its keys and its own notes (or, when no requested note is found, the ids as asked, so the attempt is audited).
    const own = groups.get(input.personId) ?? (groups.size ? [] : (input.eventIds ?? []));
    groups.delete(input.personId);
    const fields: Partial<Record<SensitiveFieldKey, string>> = {};
    const notes: { eventId: string; body: string }[] = [];
    if (input.keys?.length || own.length) {
      const scope = { ...(input.keys?.length ? { keys: input.keys } : {}), ...(own.length ? { eventIds: own } : {}) };
      const bundle = await readSensitive(ctx, input.personId, "staff_view", scope);
      Object.assign(fields, bundle.fields);
      notes.push(...bundle.notes);
    }
    for (const [ownerId, eventIds] of groups) notes.push(...(await readSensitive(ctx, ownerId, "staff_view", { eventIds })).notes);
    return { fields, notes };
  },
);
