"use server";
/**
 * Person actions (crm spec 4.1), crm-P2: create (with the duplicate panel of rule 3.29), edit with
 * optimistic `version` (rule 3.52 email change), fill a missing acquisition (rule 3.4), and the
 * manual status override (rules 3.9 to 3.11). Each handler audits its own `audit_log.action`.
 */
import { z } from "zod";
import { persons } from "@beam/db/schema";
import { ACQUISITION_SOURCES, emailHash, formatCustomerNumber, hasAcquisitionSource, normaliseEmail, normalisePhone, PERSON_STATUSES, scorePair } from "@beam/core/crm";
import { LOCALES } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { AppError, ConflictError, eq, sql, ValidationError, type Ctx, type Tx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { syncCustomerAccountEmail } from "@/modules/platform/api";
import { addCompanyContact } from "../companies/api";
import {
  assertBirthOn,
  bumpVersion,
  clean,
  compact,
  DUPLICATE_FIELDS,
  enqueueDuplicateCheck,
  getPersonStatus,
  insertPerson,
  lockActivePerson,
  resolveAcquisition,
  normaliseEmergencyContact,
  setStatusOverride as applyStatusOverride,
} from "./api";
import { displayName } from "./queries";

const Address = z
  .object({
    street: z.string().max(200).optional(),
    number: z.string().max(20).optional(),
    box: z.string().max(20).optional(),
    postal_code: z.string().max(20).optional(),
    city: z.string().max(100).optional(),
    country: z.string().length(2),
  })
  .strict();
const EmergencyContact = z.object({ name: z.string().trim().min(1).max(100), phone: z.string().trim().min(6).max(40), relation: z.string().max(100).optional() }).strict();
const AcquisitionInput = z.object({ source: z.enum(ACQUISITION_SOURCES), campaign: z.string().max(200).optional(), medium: z.string().max(200).optional(), funnel: z.string().max(200).optional() });
const Channel = z.enum(["email", "phone", "whatsapp"]);
const BirthOn = z.iso.date();

export type DuplicateCandidate = { personId: string; customerNumber: string; name: string; score: number; reasons: string[] };

const CreatePersonInput = z.object({
  email: z.string().max(254).optional(),
  phone: z.string().max(40).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  locale: z.enum(LOCALES),
  address: Address.optional(),
  birthOn: BirthOn.optional(),
  preferredChannel: Channel.optional(),
  acquisition: AcquisitionInput,
  companyId: z.uuid().optional(),
  confirmDuplicates: z.boolean().optional(),
});

/**
 * `conflict` with `fields.candidates` (JSON of `DuplicateCandidate[]`) when a candidate scores 50 or
 * more and the staff member has not confirmed "create anyway"; `conflict` `email_taken` always.
 */
export const createPerson = action(
  { name: "crm.create_person", audience: "staff", permission: "persons.write", input: CreatePersonInput, audit: false },
  async (ctx, input) => {
    const email = input.email?.trim() ? normaliseEmail(input.email) : null;
    if (input.email?.trim() && !email) throw new ValidationError("invalid_email", { email: "invalid_email" });
    if (!email && !clean(input.phone) && !clean(input.lastName)) throw new ValidationError("need_identity", { email: "need_identity" });
    if (input.birthOn) assertBirthOn(input.birthOn, ctx.now);
    if (email) {
      await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(lower(${email})))`);
      const taken = await activeWithEmail(ctx.tx, email);
      if (taken) throw new AppError("conflict", "email_taken", { email: "email_taken", customerNumber: taken.customerNumber, personId: taken.personId });
    }
    if (!input.confirmDuplicates) {
      const candidates = await duplicateCandidates(ctx.tx, { ...input, email });
      if (candidates.length) throw new AppError("conflict", "possible_duplicates", { candidates: JSON.stringify(candidates) });
    }
    const { personId } = await insertPerson(ctx.tx, ctx, {
      email,
      phone: input.phone,
      firstName: input.firstName,
      lastName: input.lastName,
      locale: input.locale,
      address: input.address ?? null,
      birthOn: input.birthOn ?? null,
      preferredChannel: input.preferredChannel ?? null,
      acquisition: compact(input.acquisition),
      source: "manual",
    });
    if (input.companyId) await addCompanyContact(ctx.tx, ctx, { companyId: input.companyId, personId });
    await ctx.audit({ action: "person.create", entityType: "person", entityId: personId, personId, newValue: { acquisition_source: input.acquisition.source, confirmed_duplicates: !!input.confirmDuplicates } });
    return { personId };
  },
);

const UpdatePersonInput = z.object({
  personId: z.uuid(),
  version: z.number().int().positive(),
  patch: z.object({
    email: z.string().max(254).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    firstName: z.string().max(100).nullable().optional(),
    lastName: z.string().max(100).nullable().optional(),
    locale: z.enum(LOCALES).optional(),
    address: Address.nullable().optional(),
    birthOn: BirthOn.nullable().optional(),
    preferredChannel: Channel.nullable().optional(),
    linkedinUrl: z.url().max(300).nullable().optional(),
    emergencyContact: EmergencyContact.nullable().optional(),
    externalIds: z.record(z.string(), z.string().max(100)).optional(),
  }),
});

/**
 * Staff edit. `conflict` `stale_version` on a stale version, `email_taken` (with the holder's
 * customer number) when another active person has the address, and platform's `email_in_use` when
 * another login uses it (rule 3.52, checked before any write).
 */
export const updatePerson = action(
  { name: "crm.update_person", audience: "staff", permission: "persons.write", input: UpdatePersonInput, audit: false },
  async (ctx, input) => {
    const person = await lockActivePerson(ctx.tx, input.personId);
    if (person.id !== input.personId || person.mergedIntoPersonId) throw new ConflictError("merged");
    if (person.version !== input.version) throw new ConflictError("stale_version");
    const p = input.patch;
    const set: Partial<typeof persons.$inferInsert> = {};
    const changed: string[] = [];
    const differs = (a: unknown, b: unknown) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);

    if (p.email !== undefined) {
      const email = p.email?.trim() ? normaliseEmail(p.email) : null;
      if (p.email?.trim() && !email) throw new ValidationError("invalid_email", { "patch.email": "invalid_email" });
      if (email !== person.email) {
        if (email) {
          await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(lower(${email})))`);
          const taken = await activeWithEmail(ctx.tx, email);
          if (taken && taken.personId !== person.id) {
            throw new AppError("conflict", "email_taken", { "patch.email": "email_taken", customerNumber: taken.customerNumber, personId: taken.personId });
          }
        }
        await syncCustomerAccountEmail(ctx, { personId: person.id, email });
        set.email = email;
        set.emailHash = email ? emailHash(email) : null;
        changed.push("email");
      }
    }
    if (p.phone !== undefined && differs(clean(p.phone), person.phone)) {
      set.phone = clean(p.phone) ?? null;
      set.phoneE164 = normalisePhone(p.phone);
      changed.push("phone");
    }
    for (const field of ["firstName", "lastName"] as const) {
      if (p[field] !== undefined && differs(clean(p[field]), person[field])) {
        set[field] = clean(p[field]) ?? null;
        changed.push(field);
      }
    }
    if (p.address !== undefined && differs(p.address, person.address)) {
      set.address = p.address;
      changed.push("address");
    }
    if (p.birthOn !== undefined && differs(p.birthOn, person.birthOn)) {
      set.birthOn = p.birthOn ? assertBirthOn(p.birthOn, ctx.now) : null;
      changed.push("birthOn");
    }
    if (p.preferredChannel !== undefined && differs(p.preferredChannel, person.preferredChannel)) {
      set.preferredChannel = p.preferredChannel;
      changed.push("preferredChannel");
    }
    if (p.linkedinUrl !== undefined && differs(p.linkedinUrl, person.linkedinUrl)) {
      set.linkedinUrl = p.linkedinUrl;
      changed.push("linkedinUrl");
    }
    if (p.emergencyContact !== undefined) {
      const contact = p.emergencyContact ? normaliseEmergencyContact(p.emergencyContact) : null;
      if (differs(contact, person.emergencyContact)) {
        set.emergencyContact = contact;
        changed.push("emergencyContact");
      }
    }
    if (p.externalIds) {
      const merged = { ...(person.externalIds ?? {}), ...p.externalIds };
      if (differs(merged, person.externalIds)) {
        set.externalIds = merged;
        changed.push("externalIds");
      }
    }
    const localeChanged = p.locale !== undefined && p.locale !== person.locale;
    if (localeChanged) {
      set.locale = p.locale;
      changed.push("locale");
    }
    if (!changed.length) return { version: person.version };

    const version = person.version + 1;
    await ctx.tx
      .update(persons)
      .set({ ...set, version })
      .where(eq(persons.id, person.id));
    await ctx.recordEvent({ kind: "person.updated", personId: person.id, data: { fields: changed } });
    if (localeChanged) await ctx.recordEvent({ kind: "person.locale_changed", personId: person.id, data: { from: person.locale, to: p.locale } });
    if (changed.some((f) => DUPLICATE_FIELDS.has(f))) await enqueueDuplicateCheck(ctx, person.id, version);
    await ctx.audit({ action: "person.update", entityType: "person", entityId: person.id, personId: person.id, newValue: { fields: changed, version } });
    return { version };
  },
);

/** Rule 3.4: staff may fill the acquisition only while its source is missing; audited. */
export const fillAcquisition = action(
  { name: "crm.fill_acquisition", audience: "staff", permission: "persons.write", input: z.object({ personId: z.uuid(), acquisition: AcquisitionInput }), audit: false },
  async (ctx, input): Promise<Record<string, never>> => {
    const person = await lockActivePerson(ctx.tx, input.personId);
    if (hasAcquisitionSource(person.acquisition)) throw new ConflictError("acquisition_already_set");
    const { acquisition } = await resolveAcquisition(ctx.tx, compact(input.acquisition), ctx.now);
    await ctx.tx
      .update(persons)
      .set({ acquisition: acquisition, version: person.version + 1 })
      .where(eq(persons.id, person.id));
    await ctx.recordEvent({ kind: "person.acquisition_filled", personId: person.id, data: { acquisition_source: acquisition.source } });
    await ctx.audit({ action: "person.acquisition", entityType: "person", entityId: person.id, personId: person.id, oldValue: person.acquisition, newValue: acquisition });
    return {};
  },
);

/** Sets or clears the manual status (rule 3.9); returns the resulting `status`. */
export const setStatusOverride = action(
  {
    name: "crm.set_status_override",
    audience: "staff",
    permission: "persons.write",
    input: z.object({ personId: z.uuid(), status: z.enum(PERSON_STATUSES).nullable(), reason: z.string().trim().min(3).max(500) }),
    audit: false,
  },
  async (ctx, input) => {
    await applyStatusOverride(ctx.tx, ctx, { personId: input.personId, status: input.status, reason: input.reason, source: "manual" });
    const { status } = await getPersonStatus(ctx.tx, input.personId);
    return { status };
  },
);

/** "Keep" on the 360 banner (rule 3.11): records `person.status_override_confirmed`; `conflict` without a conflict. */
export const confirmStatusOverride = action(
  { name: "crm.confirm_status_override", audience: "staff", permission: "persons.write", input: z.object({ personId: z.uuid() }), audit: false },
  async (ctx, input): Promise<Record<string, never>> => {
    const person = await lockActivePerson(ctx.tx, input.personId);
    const { override, derivedStatus } = await getPersonStatus(ctx.tx, person.id);
    if (!override || override === derivedStatus) throw new ConflictError("no_override_conflict");
    const at = person.statusOverrideAt?.toISOString().slice(0, 16) ?? "none";
    await ctx.recordEvent({
      kind: "person.status_override_confirmed",
      personId: person.id,
      data: { status: override, derived_status: derivedStatus },
      dedupeKey: `override_confirmed:${person.id}:${override}:${derivedStatus}:${at}`,
    });
    await bumpVersion(ctx.tx, person.id);
    await ctx.audit({ action: "person.status_override", entityType: "person", entityId: person.id, personId: person.id, newValue: { confirmed: override, derived_status: derivedStatus } });
    return {};
  },
);

// ---------------------------------------------------------------------------

async function activeWithEmail(tx: Tx, email: string): Promise<{ personId: string; customerNumber: string } | null> {
  const [row] = rowsOf<{ id: string; customer_number: string | number }>(
    await tx.execute(sql`select id::text as id, customer_number from persons
      where lower(email) = ${email} and erased_at is null and merged_into_person_id is null limit 1`),
  );
  return row ? { personId: row.id, customerNumber: formatCustomerNumber(row.customer_number) } : null;
}

/** Rule 3.29: active persons scoring 50 or more against the new person (rule 3.28 scores). */
async function duplicateCandidates(
  tx: Ctx["tx"],
  input: { email: string | null; phone?: string; firstName?: string; lastName?: string; birthOn?: string; address?: { postal_code?: string } },
): Promise<DuplicateCandidate[]> {
  const phone = normalisePhone(input.phone);
  const first = clean(input.firstName)?.toLowerCase();
  const last = clean(input.lastName)?.toLowerCase();
  const local = input.email?.split("@")[0]?.replace(/\+.*$/, "").replace(/\./g, "");
  const gmail = input.email && /@(gmail|googlemail)\.com$/.test(input.email) ? local : null;
  const ors = [
    gmail
      ? sql`(split_part(lower(email), '@', 2) in ('gmail.com', 'googlemail.com')
             and regexp_replace(regexp_replace(split_part(lower(email), '@', 1), '\\+.*$', ''), '\\.', '', 'g') = ${gmail})`
      : null,
    phone ? sql`phone_e164 = ${phone}` : null,
    first && last ? sql`(lower(first_name) = ${first} and lower(last_name) = ${last})` : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);
  if (!ors.length) return [];
  const rows = rowsOf<{
    id: string;
    customer_number: string | number;
    email: string | null;
    phone_e164: string | null;
    first_name: string | null;
    last_name: string | null;
    birth_on: string | null;
    postal_code: string | null;
  }>(
    await tx.execute(sql`select id::text as id, customer_number, email, phone_e164, first_name, last_name, birth_on::text as birth_on, address->>'postal_code' as postal_code
      from persons where erased_at is null and merged_into_person_id is null and (${sql.join(ors, sql` or `)}) limit 50`),
  );
  const me = { email: input.email, phoneE164: phone, firstName: input.firstName, lastName: input.lastName, birthOn: input.birthOn, postalCode: input.address?.postal_code };
  return rows
    .map((r) => {
      const { score, reasons } = scorePair(me, { email: r.email, phoneE164: r.phone_e164, firstName: r.first_name, lastName: r.last_name, birthOn: r.birth_on, postalCode: r.postal_code });
      const customerNumber = formatCustomerNumber(r.customer_number);
      return { personId: r.id, customerNumber, name: displayName(r, customerNumber), score, reasons: reasons.map(String) };
    })
    .filter((c) => c.score >= 50)
    .sort((a, b) => b.score - a.score);
}
