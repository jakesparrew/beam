"use server";
/**
 * Customer self-service actions (crm spec 4.1, `audience: 'customer'`), crm-P3. The person is
 * always `ctx.actor.personId`: the input carries no person id, and the email is not editable here.
 * Self-service changes are not audited; the timeline records them with the customer actor.
 * The first-sign-in onboarding (owner requirements item 10) saves each answer through the same
 * paths: the profile patch below, `applyPreferences` for consent and `linkCustomerCompany`.
 */
import { z } from "zod";
import { persons, type OnboardingJson } from "@beam/db/schema";
import { normalisePhone, type ConsentOutcome, type MarketingPurpose } from "@beam/core/crm";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { ForbiddenError } from "@beam/core/errors";
import { ConflictError, eq, type Ctx } from "@/lib/ctx";
import { linkCustomerCompany } from "../companies/api";
import { applyPreferences } from "../consent/api";
import { assertBirthOn, clean, DUPLICATE_FIELDS, enqueueDuplicateCheck, lockActivePerson, normaliseEmergencyContact } from "../persons/api";

type PersonRow = Awaited<ReturnType<typeof lockActivePerson>>;
type Address = { street?: string; number?: string; box?: string; postal_code?: string; city?: string; country: string };
type ProfilePatch = {
  firstName?: string;
  lastName?: string;
  phone?: string;
  address?: Address;
  birthOn?: string;
  locale?: Locale;
  preferredChannel?: "email" | "phone" | "whatsapp";
  emergencyContact?: { name: string; phone: string; relation?: string };
};

function ownPersonId(ctx: Ctx): string {
  if (ctx.actor.kind !== "customer") throw new ForbiddenError("customer_only");
  return ctx.actor.personId;
}

const AddressInput = z
  .object({ street: z.string().max(200).optional(), number: z.string().max(20).optional(), box: z.string().max(20).optional(), postal_code: z.string().max(20).optional(), city: z.string().max(100).optional(), country: z.string().length(2) })
  .strict();
const ChannelInput = z.enum(["email", "phone", "whatsapp"]);
const EmergencyContactInput = z.object({ name: z.string().trim().min(1).max(100), phone: z.string().trim().min(6).max(40), relation: z.string().max(100).optional() }).strict();

/** Writes the changed fields of the patch with one `person.updated` (field names only); `undefined` leaves a field alone. */
async function patchOwnProfile(ctx: Ctx, person: PersonRow, input: ProfilePatch): Promise<{ version: number }> {
  const set: Partial<typeof persons.$inferInsert> = {};
  const changed: string[] = [];
  const differs = (a: unknown, b: unknown) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
  for (const field of ["firstName", "lastName"] as const) {
    if (input[field] !== undefined && differs(clean(input[field]), person[field])) {
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
    const address = Object.fromEntries(Object.entries(input.address).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]).filter(([, v]) => v !== "")) as Address;
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
  const localeChanged = input.locale !== undefined && input.locale !== person.locale;
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
      address: AddressInput.optional(),
      birthOn: z.iso.date().optional(),
      locale: z.enum(LOCALES),
      preferredChannel: ChannelInput.optional(),
      emergencyContact: EmergencyContactInput.optional(),
    }),
  },
  async (ctx, input): Promise<{ version: number }> => {
    const person = await lockActivePerson(ctx.tx, ownPersonId(ctx));
    if (person.version !== input.version) throw new ConflictError("stale_version");
    const { version: _version, ...patch } = input;
    return patchOwnProfile(ctx, person, patch);
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

// ---------------------------------------------------------------------------
// First-sign-in onboarding
// ---------------------------------------------------------------------------

/** Progress only (no version bump: it is not a profile field, and an open profile form stays valid). */
async function writeOnboarding(ctx: Ctx, person: PersonRow, change: (o: OnboardingJson) => OnboardingJson): Promise<void> {
  const current = person.onboarding ?? {};
  const next = change({ ...current, seen_at: current.seen_at ?? ctx.now.toISOString() });
  if (JSON.stringify(next) === JSON.stringify(person.onboarding)) return;
  await ctx.tx.update(persons).set({ onboarding: next }).where(eq(persons.id, person.id));
}

/** `seen` when the flow first opens (the portal home then stops opening it), `dismissed` when the client hides the home card. */
export const markMyOnboarding = action(
  { name: "crm.mark_my_onboarding", audience: "customer", input: z.object({ event: z.enum(["seen", "dismissed"]) }) },
  async (ctx, input): Promise<Record<string, never>> => {
    const person = await lockActivePerson(ctx.tx, ownPersonId(ctx));
    await writeOnboarding(ctx, person, (o) => (input.event === "dismissed" ? { ...o, dismissed_at: o.dismissed_at ?? ctx.now.toISOString() } : o));
    return {};
  },
);

const Purposes = { newsletter: z.boolean(), events: z.boolean(), member_comms: z.boolean(), b2b: z.boolean() };

const OnboardingStepInput = z.discriminatedUnion("step", [
  z.object({ step: z.literal("emergency"), answer: EmergencyContactInput.optional() }),
  z.object({ step: z.literal("communication"), answer: z.object({ ...Purposes, preferredChannel: ChannelInput.optional() }).optional() }),
  z.object({
    step: z.literal("company"),
    answer: z.object({ vatNumber: z.string().trim().min(4).max(30), companyName: z.string().trim().min(1).max(200), address: AddressInput.optional() }).optional(),
  }),
  z.object({ step: z.literal("about"), answer: z.object({ birthOn: z.iso.date().optional(), locale: z.enum(LOCALES).optional() }).optional() }),
]);

/**
 * One onboarding screen: with an `answer` it is saved and the step counts as answered, without
 * one the step is skipped. Each answer goes through the normal paths, so the timeline shows
 * `person.updated`, `consent.granted` or `company.contact_linked` as for any other change.
 * Marketing consent is recorded only for the purposes the client ticked (never pre-ticked).
 */
export const saveMyOnboardingStep = action(
  { name: "crm.save_my_onboarding_step", audience: "customer", input: OnboardingStepInput },
  async (ctx, input): Promise<{ skipped: Partial<Record<MarketingPurpose, ConsentOutcome>> }> => {
    const personId = (await lockActivePerson(ctx.tx, ownPersonId(ctx))).id;
    let skipped: Partial<Record<MarketingPurpose, ConsentOutcome>> = {};
    if (input.step === "emergency" && input.answer) {
      await patchOwnProfile(ctx, await lockActivePerson(ctx.tx, personId), { emergencyContact: input.answer });
    } else if (input.step === "communication" && input.answer) {
      const { preferredChannel, ...purposes } = input.answer;
      if (preferredChannel) await patchOwnProfile(ctx, await lockActivePerson(ctx.tx, personId), { preferredChannel });
      ({ skipped } = await applyPreferences(ctx.tx, ctx, personId, { purposes, method: "portal", source: "onboarding", ip: ctx.ip }));
    } else if (input.step === "company" && input.answer) {
      const { vatNumber, companyName, address } = input.answer;
      await linkCustomerCompany(ctx.tx, ctx, { personId, vatNumber, name: companyName, ...(address ? { address } : {}) });
    } else if (input.step === "about" && input.answer) {
      await patchOwnProfile(ctx, await lockActivePerson(ctx.tx, personId), input.answer);
    }
    const outcome = input.answer ? "answered" : "skipped";
    await writeOnboarding(ctx, await lockActivePerson(ctx.tx, personId), (o) => ({ ...o, steps: { ...o.steps, [input.step]: outcome } }));
    return { skipped };
  },
);
