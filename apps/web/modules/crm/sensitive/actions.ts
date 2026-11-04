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
import { and, AppError, ConflictError, eq, NotFoundError } from "@/lib/ctx";
import { encryptSensitive, readSensitive, sensitiveAad } from "@/modules/platform/api";

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
 * Decrypts the requested fields or sensitive notes through `readSensitive` (purpose `staff_view`,
 * which writes the `sensitive.read` audit row with the keys and event ids, never the values).
 * At least one key or event id is required.
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
    const scope = { ...(input.keys?.length ? { keys: input.keys } : {}), ...(input.eventIds?.length ? { eventIds: input.eventIds } : {}) };
    const bundle = await readSensitive(ctx, input.personId, "staff_view", scope);
    return { fields: bundle.fields, notes: bundle.notes };
  },
);
