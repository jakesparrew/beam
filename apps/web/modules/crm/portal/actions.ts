"use server";
/**
 * Customer self-service actions (crm spec 4.1, `audience: 'customer'`), crm-P3. The person is
 * always `ctx.actor.personId`: the input carries no person id, and the email is not editable here.
 * Self-service changes are not audited; the timeline records them with the customer actor.
 */
import { z } from "zod";
import { persons } from "@beam/db/schema";
import { normalisePhone, type ConsentOutcome, type MarketingPurpose } from "@beam/core/crm";
import { LOCALES } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { ForbiddenError } from "@beam/core/errors";
import { ConflictError, eq, type Ctx } from "@/lib/ctx";
import { applyPreferences } from "../consent/api";
import { assertBirthOn, clean, DUPLICATE_FIELDS, enqueueDuplicateCheck, lockActivePerson, normaliseEmergencyContact } from "../persons/api";

function ownPersonId(ctx: Ctx): string {
  if (ctx.actor.kind !== "customer") throw new ForbiddenError("customer_only");
  return ctx.actor.personId;
}

export const updateMyProfile = action(
  {
    name: "crm.update_my_profile",
    audience: "customer",
    input: z.object({
      version: z.number().int().positive(),
      firstName: z.string().trim().min(1).max(100),
      lastName: z.string().trim().min(1).max(100),
      phone: z.string().max(40).optional(),
      address: z
        .object({ street: z.string().max(200).optional(), number: z.string().max(20).optional(), box: z.string().max(20).optional(), postal_code: z.string().max(20).optional(), city: z.string().max(100).optional(), country: z.string().length(2) })
        .strict()
        .optional(),
      birthOn: z.iso.date().optional(),
      locale: z.enum(LOCALES),
      preferredChannel: z.enum(["email", "phone", "whatsapp"]).optional(),
      emergencyContact: z.object({ name: z.string().trim().min(1).max(100), phone: z.string().trim().min(6).max(40), relation: z.string().max(100).optional() }).strict().optional(),
    }),
  },
  async (ctx, input): Promise<{ version: number }> => {
    const person = await lockActivePerson(ctx.tx, ownPersonId(ctx));
    if (person.version !== input.version) throw new ConflictError("stale_version");
    const set: Partial<typeof persons.$inferInsert> = {};
    const changed: string[] = [];
    const differs = (a: unknown, b: unknown) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
    for (const field of ["firstName", "lastName"] as const) {
      if (differs(clean(input[field]), person[field])) {
        set[field] = clean(input[field]) ?? null;
        changed.push(field);
      }
    }
    if (input.phone !== undefined && differs(clean(input.phone), person.phone)) {
      set.phone = clean(input.phone) ?? null;
      set.phoneE164 = normalisePhone(input.phone);
      changed.push("phone");
    }
    if (input.address !== undefined) {
      const address = Object.fromEntries(Object.entries(input.address).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]).filter(([, v]) => v !== "")) as typeof input.address;
      if (differs(address, person.address)) {
        set.address = address;
        changed.push("address");
      }
    }
    if (input.birthOn !== undefined && differs(input.birthOn, person.birthOn)) {
      set.birthOn = assertBirthOn(input.birthOn, ctx.now);
      changed.push("birthOn");
    }
    if (input.preferredChannel !== undefined && differs(input.preferredChannel, person.preferredChannel)) {
      set.preferredChannel = input.preferredChannel;
      changed.push("preferredChannel");
    }
    if (input.emergencyContact !== undefined) {
      const contact = normaliseEmergencyContact(input.emergencyContact);
      if (differs(contact, person.emergencyContact)) {
        set.emergencyContact = contact;
        changed.push("emergencyContact");
      }
    }
    const localeChanged = input.locale !== person.locale;
    if (localeChanged) {
      set.locale = input.locale;
      changed.push("locale");
    }
    if (!changed.length) return { version: person.version };
    const version = person.version + 1;
    await ctx.tx
      .update(persons)
      .set({ ...set, version })
      .where(eq(persons.id, person.id));
    await ctx.recordEvent({ kind: "person.updated", personId: person.id, data: { fields: changed } });
    if (localeChanged) await ctx.recordEvent({ kind: "person.locale_changed", personId: person.id, data: { from: person.locale, to: input.locale } });
    if (changed.some((f) => DUPLICATE_FIELDS.has(f))) await enqueueDuplicateCheck(ctx, person.id, version);
    return { version };
  },
);

export const updateMyPreferences = action(
  {
    name: "crm.update_my_preferences",
    audience: "customer",
    input: z.object({ newsletter: z.boolean(), events: z.boolean(), member_comms: z.boolean(), b2b: z.boolean(), unsubscribeAll: z.boolean().optional() }),
  },
  async (ctx, input): Promise<{ changed: MarketingPurpose[]; skipped: Partial<Record<MarketingPurpose, ConsentOutcome>> }> => {
    const person = await lockActivePerson(ctx.tx, ownPersonId(ctx));
    return applyPreferences(ctx.tx, ctx, person.id, {
      purposes: { newsletter: input.newsletter, events: input.events, member_comms: input.member_comms, b2b: input.b2b },
      unsubscribeAll: input.unsubscribeAll,
      method: "portal",
      source: "portal",
      ip: ctx.ip,
    });
  },
);
