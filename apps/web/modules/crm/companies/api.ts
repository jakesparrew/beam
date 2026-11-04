/**
 * Company api (crm spec 2.7, rule 3.45), crm-P6. `getCompany`, `listPersonCompanies`,
 * `listPartnerCompanies`, `upsertCompany` and `addCompanyContact` are the cross-module door
 * (re-exported by `../api`); `saveStaffCompany`, `linkStaffContact` and `updateStaffContact`
 * are the handlers of the staff actions in `./actions`, kept here so the rules are testable
 * with a plain `Ctx`. A VAT number is stored normalised (`BE0123456789`) and is unique.
 * Linking a person to a company never touches their person row, status, consent or bookings.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { companies, companyContacts, persons } from "@beam/db/schema";
import {
  normaliseEmail,
  normaliseVat,
  type AcquisitionSource,
  type CompanySize,
  type CompanyStatus,
  type CompanySummary,
  type DecisionRole,
  type PostalAddress,
} from "@beam/core/crm";
import type { Locale } from "@beam/core/i18n";
import { and, AppError, asc, ConflictError, eq, isNull, ne, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import type { EventCtx } from "../api";
import { findByEmail, insertPerson, lockEmail, resolveCanonicalPersonId } from "../persons/api";

type CompanyRecord = typeof companies.$inferSelect;
type ContactRecord = typeof companyContacts.$inferSelect;

const pct = (v: string | null): number | null => (v === null ? null : Number(v));

/** Rule 3.45: normalised VAT, `null` when empty; `ValidationError('vat_invalid')` when it does not look like one. */
export function vatOrNull(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || !raw.trim()) return null;
  const vat = normaliseVat(raw);
  if (!vat) throw new ValidationError("vat_invalid", { vatNumber: "vat_invalid" });
  return vat;
}

const vatTaken = () => new AppError("conflict", "vat_taken", { vatNumber: "vat_taken" });

async function companyByVat(tx: DbOrTx, vat: string, exceptId?: string): Promise<CompanyRecord | null> {
  const [row] = await tx
    .select()
    .from(companies)
    .where(and(eq(companies.vatNumber, vat), exceptId ? ne(companies.id, exceptId) : undefined))
    .limit(1);
  return row ?? null;
}

export async function getCompany(tx: DbOrTx, companyId: string): Promise<CompanySummary | null> {
  const [row] = await tx.select().from(companies).where(eq(companies.id, companyId));
  if (!row) return null;
  return { id: row.id, name: row.name, vatNumber: row.vatNumber, status: row.status, isPartner: row.isPartner, commissionPct: pct(row.partnerCommissionPct) };
}

/** The companies a person is a current contact of (ended contacts excluded), by name. */
export async function listPersonCompanies(
  tx: DbOrTx,
  personId: string,
): Promise<Array<{ companyId: string; name: string; position: string | null; decisionRole: DecisionRole | null }>> {
  return tx
    .select({ companyId: companies.id, name: companies.name, position: companyContacts.position, decisionRole: companyContacts.decisionRole })
    .from(companyContacts)
    .innerJoin(companies, eq(companies.id, companyContacts.companyId))
    .where(and(eq(companyContacts.personId, personId), isNull(companyContacts.endedOn)))
    .orderBy(asc(companies.name), asc(companies.id));
}

export async function listPartnerCompanies(tx: DbOrTx): Promise<Array<{ id: string; name: string; commissionPct: number | null }>> {
  const rows = await tx
    .select({ id: companies.id, name: companies.name, commissionPct: companies.partnerCommissionPct })
    .from(companies)
    .where(eq(companies.isPartner, true))
    .orderBy(asc(companies.name), asc(companies.id));
  return rows.map((r) => ({ ...r, commissionPct: pct(r.commissionPct) }));
}

type UpsertInput = {
  name: string;
  vatNumber?: string;
  address?: PostalAddress;
  website?: string;
  industry?: string;
  size?: CompanySize;
  status?: CompanyStatus;
  isPartner?: boolean;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * ops imports. Matches on the normalised VAT number, else `lower(name)` (a name match whose
 * stored VAT differs from the given one is another company). Only the given fields are
 * written; nothing changed is `unchanged`. Serialised per VAT and name with an advisory lock.
 */
export async function upsertCompany(tx: Tx, ctx: EventCtx, input: UpsertInput): Promise<{ companyId: string; outcome: "created" | "updated" | "unchanged" }> {
  const name = input.name.trim().slice(0, 200);
  if (!name) throw new ValidationError("validation", { name: "required" });
  const vat = vatOrNull(input.vatNumber);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`company:${vat ?? ""}:${name.toLowerCase()}`}))`);

  let match = vat ? await companyByVat(tx, vat) : null;
  if (!match) {
    const [byName] = await tx
      .select()
      .from(companies)
      .where(sql`lower(${companies.name}) = ${name.toLowerCase()}`)
      .orderBy(asc(companies.createdAt), asc(companies.id))
      .limit(5)
      .then((rows) => rows.filter((r) => !vat || !r.vatNumber || r.vatNumber === vat));
    match = byName ?? null;
  }

  const fields = {
    name,
    ...(vat ? { vatNumber: vat } : {}),
    ...(input.address ? { address: input.address } : {}),
    ...(input.website?.trim() ? { website: input.website.trim() } : {}),
    ...(input.industry?.trim() ? { industry: input.industry.trim() } : {}),
    ...(input.size ? { size: input.size } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.isPartner !== undefined ? { isPartner: input.isPartner } : {}),
  };

  if (!match) {
    const [row] = await tx.insert(companies).values(fields).returning();
    await ctx.recordEvent({ kind: "company.created", companyId: row!.id, data: { name: row!.name }, ref: { type: "company", id: row!.id } });
    return { companyId: row!.id, outcome: "created" };
  }

  const found = match;
  const changed = Object.entries(fields).filter(([k, v]) => !same(found[k as keyof CompanyRecord], v));
  // A name found keeps its stored spelling; only a case change of the same name is no change.
  const patch = Object.fromEntries(changed.filter(([k, v]) => !(k === "name" && typeof v === "string" && v.toLowerCase() === found.name.toLowerCase())));
  if (!Object.keys(patch).length) return { companyId: found.id, outcome: "unchanged" };
  await tx
    .update(companies)
    .set({ ...patch, updatedAt: ctx.now })
    .where(eq(companies.id, found.id));
  await ctx.recordEvent({ kind: "company.updated", companyId: found.id, data: { fields: Object.keys(patch) }, ref: { type: "company", id: found.id } });
  return { companyId: found.id, outcome: "updated" };
}

/** ops imports. One row per company and person: a repeat returns the existing row with `created: false`. */
export async function addCompanyContact(
  tx: Tx,
  ctx: EventCtx,
  input: { companyId: string; personId: string; position?: string; decisionRole?: DecisionRole; relationship?: string },
): Promise<{ contactId: string; created: boolean }> {
  const personId = await resolveCanonicalPersonId(tx, input.personId);
  const [row] = await tx
    .insert(companyContacts)
    .values({
      companyId: input.companyId,
      personId,
      position: input.position?.trim() || null,
      decisionRole: input.decisionRole ?? null,
      relationship: input.relationship?.trim() || null,
    })
    .onConflictDoNothing({ target: [companyContacts.companyId, companyContacts.personId] })
    .returning();
  if (!row) {
    const [existing] = await tx
      .select({ id: companyContacts.id })
      .from(companyContacts)
      .where(and(eq(companyContacts.companyId, input.companyId), eq(companyContacts.personId, personId)));
    if (!existing) throw new ConflictError("company_contact_race");
    return { contactId: existing.id, created: false };
  }
  await recordLinked(ctx, row);
  return { contactId: row.id, created: true };
}

async function recordLinked(ctx: EventCtx, row: ContactRecord): Promise<void> {
  await ctx.recordEvent({
    kind: "company.contact_linked",
    personId: row.personId,
    companyId: row.companyId,
    ref: { type: "company_contact", id: row.id },
    data: { contact_id: row.id, decision_role: row.decisionRole },
  });
}

// ---------------------------------------------------------------------------
// Staff handlers (the actions in ./actions)
// ---------------------------------------------------------------------------

export type StaffCompanyInput = {
  id?: string;
  name: string;
  vatNumber?: string;
  address?: PostalAddress;
  website?: string;
  industry?: string;
  size?: CompanySize;
  status: CompanyStatus;
  ownerUserId?: string;
  notes?: string;
  isPartner: boolean;
  partnerCommissionPct?: number;
};

const companyAudit = (c: CompanyRecord) => ({
  name: c.name,
  vatNumber: c.vatNumber,
  address: c.address,
  website: c.website,
  industry: c.industry,
  size: c.size,
  status: c.status,
  ownerUserId: c.ownerUserId,
  notes: c.notes,
  isPartner: c.isPartner,
  partnerCommissionPct: pct(c.partnerCommissionPct),
});

/** `saveCompany` (`crm.save_company`, audit `company.save`): `conflict` `vat_taken` when another company has the VAT number. */
export async function saveStaffCompany(ctx: Ctx, input: StaffCompanyInput): Promise<{ companyId: string }> {
  const vat = vatOrNull(input.vatNumber);
  if (vat) await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`company_vat:${vat}`}))`);
  const values = {
    name: input.name.trim(),
    vatNumber: vat,
    address: input.address ?? null,
    website: input.website?.trim() || null,
    industry: input.industry?.trim() || null,
    size: input.size ?? null,
    status: input.status,
    ownerUserId: input.ownerUserId ?? null,
    notes: input.notes?.trim() || null,
    isPartner: input.isPartner,
    partnerCommissionPct: input.isPartner && input.partnerCommissionPct !== undefined ? input.partnerCommissionPct.toFixed(2) : null,
  };

  if (!input.id) {
    if (vat && (await companyByVat(ctx.tx, vat))) throw vatTaken();
    const [row] = await ctx.tx.insert(companies).values(values).returning();
    await ctx.recordEvent({ kind: "company.created", companyId: row!.id, data: { name: row!.name }, ref: { type: "company", id: row!.id } });
    await ctx.audit({ action: "company.save", entityType: "companies", entityId: row!.id, newValue: companyAudit(row!) });
    return { companyId: row!.id };
  }

  const [before] = await ctx.tx.select().from(companies).where(eq(companies.id, input.id)).for("update");
  if (!before) throw new NotFoundError("company_not_found");
  if (vat && (await companyByVat(ctx.tx, vat, input.id))) throw vatTaken();
  const [after] = await ctx.tx
    .update(companies)
    .set({ ...values, updatedAt: ctx.now })
    .where(eq(companies.id, input.id))
    .returning();
  const oldView = companyAudit(before);
  const newView = companyAudit(after!);
  const fields = Object.keys(newView).filter((k) => !same(oldView[k as keyof typeof oldView], newView[k as keyof typeof newView]));
  if (fields.length) await ctx.recordEvent({ kind: "company.updated", companyId: input.id, data: { fields }, ref: { type: "company", id: input.id } });
  await ctx.audit({ action: "company.save", entityType: "companies", entityId: input.id, oldValue: oldView, newValue: newView });
  return { companyId: input.id };
}

export type NewContactPerson = {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  locale: Locale;
  acquisition: { source: AcquisitionSource; campaign?: string };
};

export type LinkContactInput = {
  companyId: string;
  personId?: string;
  newPerson?: NewContactPerson;
  position?: string;
  decisionRole?: DecisionRole;
  relationship?: string;
  isPrimary: boolean;
};

async function clearPrimary(tx: Tx, companyId: string, exceptContactId?: string): Promise<void> {
  await tx
    .update(companyContacts)
    .set({ isPrimary: false, updatedAt: sql`now()` })
    .where(
      and(
        eq(companyContacts.companyId, companyId),
        eq(companyContacts.isPrimary, true),
        isNull(companyContacts.endedOn),
        exceptContactId ? ne(companyContacts.id, exceptContactId) : undefined,
      ),
    );
}

const contactAudit = (c: ContactRecord) => ({
  companyId: c.companyId,
  personId: c.personId,
  position: c.position,
  decisionRole: c.decisionRole,
  relationship: c.relationship,
  isPrimary: c.isPrimary,
  endedOn: c.endedOn,
});

/** A new contact person (`persons.write` as well): `conflict` `email_taken` when an active person has the address. */
async function createContactPerson(ctx: Ctx, p: NewContactPerson): Promise<string> {
  ctx.require("persons.write");
  const email = p.email?.trim() ? normaliseEmail(p.email) : null;
  if (p.email?.trim() && !email) throw new ValidationError("invalid_email", { email: "invalid_email" });
  if (!email && !p.phone?.trim() && !p.lastName?.trim()) throw new ValidationError("need_identity", { email: "need_identity" });
  if (email) {
    await lockEmail(ctx.tx, email);
    const taken = await findByEmail(ctx.tx, email);
    if (taken) throw new AppError("conflict", "email_taken", { email: "email_taken", personId: taken.id });
  }
  const { personId } = await insertPerson(ctx.tx, ctx, {
    email,
    phone: p.phone ?? null,
    firstName: p.firstName ?? null,
    lastName: p.lastName ?? null,
    locale: p.locale,
    acquisition: { source: p.acquisition.source, ...(p.acquisition.campaign ? { campaign: p.acquisition.campaign } : {}) },
    source: "manual",
  });
  await ctx.audit({ action: "person.create", entityType: "person", entityId: personId, personId, newValue: { acquisition_source: p.acquisition.source, via: "company_contact" } });
  return personId;
}

/**
 * `linkContact` (`crm.link_contact`, audit `company.contact_link`): an existing or a new person.
 * A current link is `conflict` `contact_exists`; an ended link is reopened (one row per company
 * and person). `isPrimary` moves the primary flag from the previous primary contact.
 */
export async function linkStaffContact(ctx: Ctx, input: LinkContactInput): Promise<{ contactId: string; personId: string }> {
  const [company] = await ctx.tx.select({ id: companies.id }).from(companies).where(eq(companies.id, input.companyId)).for("update");
  if (!company) throw new NotFoundError("company_not_found");
  if (!input.personId && !input.newPerson) throw new ValidationError("validation", { personId: "required" });

  let personId: string;
  if (input.personId) {
    personId = await resolveCanonicalPersonId(ctx.tx, input.personId);
    const [p] = await ctx.tx.select({ id: persons.id, erasedAt: persons.erasedAt }).from(persons).where(eq(persons.id, personId));
    if (!p || p.erasedAt) throw new NotFoundError("person_not_found");
  } else {
    personId = await createContactPerson(ctx, input.newPerson!);
  }

  const fields = {
    position: input.position?.trim() || null,
    decisionRole: input.decisionRole ?? null,
    relationship: input.relationship?.trim() || null,
    isPrimary: input.isPrimary,
  };
  const [existing] = await ctx.tx
    .select()
    .from(companyContacts)
    .where(and(eq(companyContacts.companyId, input.companyId), eq(companyContacts.personId, personId)))
    .for("update");
  if (existing && !existing.endedOn) throw new ConflictError("contact_exists");
  if (input.isPrimary) await clearPrimary(ctx.tx, input.companyId, existing?.id);

  let row: ContactRecord;
  if (existing) {
    [row] = (await ctx.tx
      .update(companyContacts)
      .set({ ...fields, endedOn: null, updatedAt: ctx.now })
      .where(eq(companyContacts.id, existing.id))
      .returning()) as [ContactRecord];
  } else {
    [row] = (await ctx.tx
      .insert(companyContacts)
      .values({ companyId: input.companyId, personId, ...fields })
      .returning()) as [ContactRecord];
  }
  await recordLinked(ctx, row);
  await ctx.audit({
    action: "company.contact_link",
    entityType: "company_contacts",
    entityId: row.id,
    personId,
    ...(existing ? { oldValue: contactAudit(existing) } : {}),
    newValue: contactAudit(row),
  });
  return { contactId: row.id, personId };
}

export type UpdateContactInput = {
  contactId: string;
  position?: string | null;
  decisionRole?: DecisionRole | null;
  relationship?: string | null;
  isPrimary?: boolean;
  endedOn?: string;
};

/**
 * `updateContact` / `endContact` (`crm.update_contact`, audit `company.contact_update`). An end
 * keeps the row (history) and records `company.contact_unlinked`; ending an ended contact is
 * `conflict` `contact_ended`, and an ended contact cannot become primary.
 */
export async function updateStaffContact(ctx: Ctx, input: UpdateContactInput): Promise<{ contactId: string }> {
  const [before] = await ctx.tx.select().from(companyContacts).where(eq(companyContacts.id, input.contactId)).for("update");
  if (!before) throw new NotFoundError("contact_not_found");
  if (before.endedOn && (input.endedOn || input.isPrimary)) throw new ConflictError("contact_ended");
  const trimmed = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
  const patch = {
    ...(input.position !== undefined ? { position: trimmed(input.position) ?? null } : {}),
    ...(input.decisionRole !== undefined ? { decisionRole: input.decisionRole } : {}),
    ...(input.relationship !== undefined ? { relationship: trimmed(input.relationship) ?? null } : {}),
    ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
    ...(input.endedOn ? { endedOn: input.endedOn } : {}),
  };
  if (input.isPrimary) await clearPrimary(ctx.tx, before.companyId, before.id);
  const [after] = await ctx.tx
    .update(companyContacts)
    .set({ ...patch, updatedAt: ctx.now })
    .where(eq(companyContacts.id, before.id))
    .returning();
  if (input.endedOn) {
    await ctx.recordEvent({
      kind: "company.contact_unlinked",
      personId: before.personId,
      companyId: before.companyId,
      ref: { type: "company_contact", id: before.id },
      data: { contact_id: before.id },
    });
  }
  await ctx.audit({ action: "company.contact_update", entityType: "company_contacts", entityId: before.id, personId: before.personId, oldValue: contactAudit(before), newValue: contactAudit(after!) });
  return { contactId: before.id };
}
