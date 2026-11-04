/**
 * Identity api (crm spec 4.8, rules 3.1 to 3.12, 3.52, 3.55), crm-P2. Re-exported by
 * `apps/web/modules/crm/api.ts`. Every function takes the caller's open transaction and context,
 * so the caller's action or job stays one transaction. Sibling files of this area (`actions.ts`,
 * `queries.ts`) build on the helpers exported at the bottom.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { persons, tags, vPersonStatus } from "@beam/db/schema";
import { NotImplementedError } from "@beam/core/errors";
import type { Locale } from "@beam/core/i18n";
import {
  captureAcquisition,
  emailHash,
  formatCustomerNumber,
  hasAcquisitionSource,
  isValidOverrideReason,
  mayApplyOverride,
  normaliseEmail,
  normalisePhone,
  type Acquisition,
  type EmergencyContact,
  type ImportPersonRow,
  type PersonFieldPatch,
  type PersonStatus,
  type PersonSummary,
  type PostalAddress,
} from "@beam/core/crm";
import { actorJson, and, eq, inArray, isNull, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { audit as writeAuditRow, type AuditInput } from "@/lib/audit";
import { rowsOf } from "@/lib/sensitive";
import { resolveReferralCode } from "@/modules/credits/api";
import type { EventCtx } from "../api";
import { applyTag } from "../tags/api";
import { searchPersonRows } from "./queries";

type PersonRow = typeof persons.$inferSelect;
type Caused = "manual" | "automation" | "import" | "form" | "system";

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/** Rules 3.1 to 3.4: one person per active address, under an advisory lock; fills only empty fields. */
export async function findOrCreatePersonByEmail(
  tx: Tx,
  ctx: EventCtx,
  input: {
    email: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    locale: Locale;
    acquisition?: Omit<Acquisition, "captured_at">;
    isTester?: boolean;
  },
): Promise<{ personId: string; created: boolean }> {
  const email = normaliseEmail(input.email);
  if (!email) throw new ValidationError("invalid_email", { email: "invalid_email" });
  await lockEmail(tx, email);
  const existing = await findByEmail(tx, email);
  if (existing) {
    await fillEmptyFields(tx, ctx, existing, { firstName: input.firstName, lastName: input.lastName, phone: input.phone });
    return { personId: existing.id, created: false };
  }
  const { personId } = await insertPerson(tx, ctx, {
    email,
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone,
    locale: input.locale,
    acquisition: input.acquisition,
    isTester: input.isTester,
    source: causedBy(ctx, input.acquisition),
  });
  return { personId, created: true };
}

/** Walk-ins and guests without email. */
export async function createPersonWithoutEmail(
  tx: Tx,
  ctx: EventCtx,
  input: { firstName: string; lastName?: string; phone?: string; locale: Locale; acquisition: Omit<Acquisition, "captured_at"> },
): Promise<{ personId: string }> {
  if (!input.firstName?.trim()) throw new ValidationError("first_name_required", { firstName: "required" });
  return insertPerson(tx, ctx, { ...input, source: causedBy(ctx, input.acquisition) });
}

/** Follows merges. */
export async function getPerson(tx: DbOrTx, personId: string): Promise<PersonSummary | null> {
  const id = await canonicalOrNull(tx, personId);
  if (!id) return null;
  const [row] = await tx
    .select({ p: persons, status: vPersonStatus.status })
    .from(persons)
    .leftJoin(vPersonStatus, eq(vPersonStatus.personId, persons.id))
    .where(eq(persons.id, id));
  if (!row) return null;
  const p = row.p;
  return {
    id: p.id,
    customerNumber: formatCustomerNumber(p.customerNumber),
    firstName: p.firstName,
    lastName: p.lastName,
    email: p.email,
    phone: p.phone,
    locale: p.locale,
    status: (row.status ?? p.statusOverride ?? "lead"),
    isTester: p.isTester,
    partnerCompanyId: p.partnerCompanyId,
    mergedIntoPersonId: p.mergedIntoPersonId,
    erasedAt: p.erasedAt,
  };
}

export async function resolveCanonicalPersonId(tx: DbOrTx, personId: string): Promise<string> {
  const id = await canonicalOrNull(tx, personId);
  if (!id) throw new NotFoundError("person_not_found");
  return id;
}

/** The winner plus every person merged into it (rule 3.32; merges flatten, so one level). */
export async function resolvePersonIds(tx: DbOrTx, personId: string): Promise<string[]> {
  const winner = await resolveCanonicalPersonId(tx, personId);
  const losers = await tx.select({ id: persons.id }).from(persons).where(eq(persons.mergedIntoPersonId, winner));
  return [winner, ...losers.map((r) => r.id).sort()];
}

/** Rules 3.8, 3.9 and 3.12: from credits' `v_person_status`; member pricing reads `hasActiveMembership`. */
export async function getPersonStatus(
  tx: DbOrTx,
  personId: string,
): Promise<{ status: PersonStatus; derivedStatus: PersonStatus; override: PersonStatus | null; hasActiveMembership: boolean }> {
  const id = await resolveCanonicalPersonId(tx, personId);
  const [row] = await tx
    .select({ override: persons.statusOverride, derived: vPersonStatus.derivedStatus, isMember: vPersonStatus.isMember })
    .from(persons)
    .leftJoin(vPersonStatus, eq(vPersonStatus.personId, persons.id))
    .where(eq(persons.id, id));
  const override = (row?.override ?? null);
  const derivedStatus = (row?.derived ?? "lead");
  return { status: override ?? derivedStatus, derivedStatus, override, hasActiveMembership: !!row?.isMember };
}

/**
 * Rules 3.9 and 3.10: the only writer of `status_override`. Locks the row, needs a reason of 3 to
 * 500 characters, audits `person.status_override` and records the event. `onlyIfUnset` (automation)
 * applies only when no override exists.
 */
export async function setStatusOverride(
  tx: Tx,
  ctx: EventCtx,
  input: { personId: string; status: PersonStatus | null; reason: string; onlyIfUnset?: boolean; source?: "manual" | "automation" },
): Promise<{ applied: boolean }> {
  const reason = (input.reason ?? "").trim();
  if (!isValidOverrideReason(reason)) throw new ValidationError("reason_length", { reason: "3..500" });
  const person = await lockActivePerson(tx, input.personId);
  const from = (person.statusOverride ?? null);
  if (!mayApplyOverride(from, !!input.onlyIfUnset)) return { applied: false };
  if (from === input.status) return { applied: false };
  const userId = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
  await tx
    .update(persons)
    .set(
      input.status
        ? { statusOverride: input.status, statusOverrideReason: reason, statusOverrideByUserId: userId, statusOverrideAt: ctx.now }
        : { statusOverride: null, statusOverrideReason: null, statusOverrideByUserId: null, statusOverrideAt: null },
    )
    .where(eq(persons.id, person.id));
  await bumpVersion(tx, person.id);
  await auditWith(tx, ctx, {
    action: "person.status_override",
    entityType: "person",
    entityId: person.id,
    personId: person.id,
    oldValue: { status_override: from },
    newValue: { status_override: input.status, reason },
  });
  if (input.status) {
    await ctx.recordEvent({ kind: "person.status_overridden", personId: person.id, data: { from, to: input.status, reason, source: input.source ?? "manual" } });
  } else {
    await ctx.recordEvent({ kind: "person.status_override_cleared", personId: person.id, data: { from: from!, reason } });
  }
  return { applied: true };
}

/** Imports: match by email, else by a legacy external id; fill only empty fields (rules 3.3, 3.20). */
export async function upsertPersonFromImport(
  tx: Tx,
  ctx: EventCtx,
  row: ImportPersonRow,
  importId: string,
): Promise<{ personId: string; outcome: "created" | "updated" | "unchanged" }> {
  const email = normaliseEmail(row.email ?? null);
  if (row.email && !email) throw new ValidationError("invalid_email", { email: "invalid_email" });
  let existing: PersonRow | null = null;
  if (email) {
    await lockEmail(tx, email);
    existing = await findByEmail(tx, email);
  }
  if (!existing && row.externalIds) {
    for (const [key, value] of Object.entries(row.externalIds)) {
      if (!value) continue;
      const [match] = await tx
        .select()
        .from(persons)
        .where(and(sql`${persons.externalIds} @> ${JSON.stringify({ [key]: value })}::jsonb`, isNull(persons.erasedAt)))
        .limit(1);
      if (match) {
        existing = await rowById(tx, await resolveCanonicalPersonId(tx, match.id));
        break;
      }
    }
  }
  const patch: PersonFieldPatch = compact({
    firstName: row.firstName ?? undefined,
    lastName: row.lastName ?? undefined,
    phone: row.phone ?? undefined,
    birthOn: row.birthOn ?? undefined,
    postalCode: row.postalCode ?? undefined,
    city: row.city ?? undefined,
    externalIds: row.externalIds,
  });
  if (existing) {
    const { changed } = await updatePersonFields(tx, ctx, existing.id, patch, { onlyEmpty: true });
    const tagged = await applyImportTags(tx, ctx, existing.id, row.tags);
    return { personId: existing.id, outcome: changed.length || tagged ? "updated" : "unchanged" };
  }
  if (!email && !row.firstName?.trim() && !row.lastName?.trim()) throw new ValidationError("identity_required", { email: "required" });
  const { personId } = await insertPerson(tx, ctx, {
    email,
    firstName: row.firstName ?? undefined,
    lastName: row.lastName ?? undefined,
    phone: row.phone ?? undefined,
    birthOn: row.birthOn ?? undefined,
    address: row.postalCode || row.city ? compact({ postal_code: row.postalCode ?? undefined, city: row.city ?? undefined, country: "BE" }) : undefined,
    locale: row.locale ?? "nl-BE",
    acquisition: row.acquisition ?? { source: "import", campaign: `import:${importId}`.slice(0, 200) },
    externalIds: row.externalIds,
    source: "import",
  });
  await applyImportTags(tx, ctx, personId, row.tags);
  return { personId, outcome: "created" };
}

/** ops privacy, in the same transaction as `processing_restrictions`. */
export async function restrictProcessing(tx: Tx, _ctx: EventCtx, personId: string, restricted: boolean): Promise<void> {
  const id = await resolveCanonicalPersonId(tx, personId);
  await tx.execute(sql`select id from persons where id = ${id}::uuid for update`);
  await tx
    .update(persons)
    .set({ processingRestrictedAt: restricted ? sql`coalesce(${persons.processingRestrictedAt}, now())` : null, version: sql`${persons.version} + 1` })
    .where(eq(persons.id, id));
}

/**
 * ops retention: active persons whose last activity (timeline event, else creation) is before
 * `cutoff`. `leadsOnly` also needs no paid order, booking, invoice or credit grant ever.
 */
export async function listInactiveProfiles(tx: DbOrTx, cutoff: Date, limit: number, filter?: { leadsOnly?: boolean }): Promise<string[]> {
  const leads = filter?.leadsOnly
    ? sql` and not exists (select 1 from orders o where o.person_id = p.id and o.paid_at is not null)
           and not exists (select 1 from bookings b where b.person_id = p.id)
           and not exists (select 1 from invoices i where i.person_id = p.id)
           and not exists (select 1 from credit_grants g where g.person_id = p.id)`
    : sql``;
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      select p.id::text as id from persons p
      where p.erased_at is null and p.merged_into_person_id is null and p.created_at < ${cutoff.toISOString()}::timestamptz
        and not exists (select 1 from activity_events e where e.person_id = p.id and e.occurred_at >= ${cutoff.toISOString()}::timestamptz)${leads}
      order by p.created_at, p.id limit ${Math.max(0, Math.floor(limit))}`),
  );
  return rows.map((r) => r.id);
}

/** booking, commerce POS, platform pickers; `limit` default 10, max 50 (rule 3.6). */
export async function searchPersons(
  tx: DbOrTx,
  input: { q: string; limit?: number },
): Promise<Array<{ personId: string; customerNumber: string; name: string; email: string | null; status: PersonStatus }>> {
  const limit = Math.min(50, Math.max(1, input.limit ?? 10));
  const rows = await searchPersonRows(tx, input.q, limit);
  return rows.map((r) => ({ personId: r.id, customerNumber: r.customerNumber, name: r.name, email: r.email, status: r.status }));
}

/**
 * The one write path for person columns (cross-module D13); never email, locale or acquisition.
 * `onlyEmpty` fills only empty columns, and merges `externalIds` key by key keeping existing keys.
 */
export async function updatePersonFields(
  tx: Tx,
  ctx: EventCtx,
  personId: string,
  patch: PersonFieldPatch,
  opts: { onlyEmpty: boolean },
): Promise<{ changed: string[] }> {
  const person = await lockActivePerson(tx, personId);
  const set: Partial<typeof persons.$inferInsert> = {};
  const changed: string[] = [];
  const take = (field: string, current: unknown, next: unknown, apply: () => void) => {
    if (next === undefined || next === null || next === "") return;
    const empty = current === null || current === undefined || current === "";
    if (opts.onlyEmpty && !empty) return;
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    apply();
    changed.push(field);
  };
  take("firstName", person.firstName, clean(patch.firstName), () => (set.firstName = clean(patch.firstName)));
  take("lastName", person.lastName, clean(patch.lastName), () => (set.lastName = clean(patch.lastName)));
  take("phone", person.phone, clean(patch.phone), () => {
    set.phone = clean(patch.phone);
    set.phoneE164 = normalisePhone(patch.phone);
  });
  take("birthOn", person.birthOn, patch.birthOn, () => (set.birthOn = assertBirthOn(patch.birthOn!, ctx.now)));
  take("preferredChannel", person.preferredChannel, patch.preferredChannel, () => (set.preferredChannel = patch.preferredChannel));
  if (patch.emergencyContact) {
    const contact = normaliseEmergencyContact(patch.emergencyContact);
    take("emergencyContact", person.emergencyContact, contact, () => (set.emergencyContact = contact));
  }
  const address: PostalAddress = { ...(person.address ?? { country: "BE" }) };
  let addressChanged = false;
  for (const [field, key] of [
    ["postalCode", "postal_code"],
    ["city", "city"],
  ] as const) {
    const next = clean(patch[field]);
    take(field, person.address?.[key], next, () => {
      address[key] = next;
      addressChanged = true;
    });
  }
  if (addressChanged) set.address = address;
  if (patch.externalIds) {
    const current: Record<string, string> = { ...(person.externalIds ?? {}) };
    let any = false;
    for (const [key, value] of Object.entries(patch.externalIds)) {
      if (!value) continue;
      if (current[key] === value || (opts.onlyEmpty && current[key])) continue;
      current[key] = value;
      any = true;
    }
    if (any) {
      set.externalIds = current;
      changed.push("externalIds");
    }
  }
  if (!changed.length) return { changed };
  await tx
    .update(persons)
    .set({ ...set, version: sql`${persons.version} + 1` })
    .where(eq(persons.id, person.id));
  await ctx.recordEvent({ kind: "person.updated", personId: person.id, data: { fields: changed } });
  if (changed.some((f) => DUPLICATE_FIELDS.has(f))) await enqueueDuplicateCheck(ctx, person.id, person.version + 1);
  return { changed };
}

/** forms rule A3, when the person already existed without a source. */
export async function fillAcquisitionIfEmpty(
  tx: Tx,
  ctx: EventCtx,
  personId: string,
  acquisition: Omit<Acquisition, "captured_at">,
): Promise<{ applied: boolean }> {
  const person = await lockActivePerson(tx, personId);
  if (hasAcquisitionSource(person.acquisition)) return { applied: false };
  const stored = await resolveAcquisition(tx, acquisition, ctx.now);
  await tx
    .update(persons)
    .set({ acquisition: stored.acquisition, version: sql`${persons.version} + 1` })
    .where(eq(persons.id, person.id));
  await ctx.recordEvent({ kind: "person.acquisition_filled", personId: person.id, data: { acquisition_source: stored.acquisition.source } });
  return { applied: true };
}

/** forms prefill; never the emergency contact (rule 3.55). */
export async function getPersonPrefill(
  tx: DbOrTx,
  personId: string,
): Promise<{
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  locale: Locale;
  birthOn: string | null;
  postalCode: string | null;
  city: string | null;
}> {
  const p = await rowById(tx, await resolveCanonicalPersonId(tx, personId));
  return {
    firstName: p.firstName,
    lastName: p.lastName,
    phone: p.phone,
    locale: p.locale,
    birthOn: p.birthOn,
    postalCode: p.address?.postal_code ?? null,
    city: p.address?.city ?? null,
  };
}

/** automation suppression exit; includes merged rows. */
export async function findPersonIdsByEmailHash(tx: DbOrTx, hash: string): Promise<string[]> {
  const rows = await tx.select({ id: persons.id }).from(persons).where(eq(persons.emailHash, hash)).orderBy(persons.createdAt, persons.id);
  return rows.map((r) => r.id);
}

/** platform flags. */
export async function setPersonTester(tx: Tx, _ctx: EventCtx, input: { personId: string; isTester: boolean }): Promise<void> {
  const person = await lockActivePerson(tx, input.personId);
  if (person.isTester === input.isTester) return;
  await tx
    .update(persons)
    .set({ isTester: input.isTester, version: sql`${persons.version} + 1` })
    .where(eq(persons.id, person.id));
}

// ---------------------------------------------------------------------------
// helpers shared with this area's actions and queries
// ---------------------------------------------------------------------------

export type NewPerson = {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  locale: Locale;
  address?: PostalAddress | null;
  birthOn?: string | null;
  preferredChannel?: "email" | "phone" | "whatsapp" | null;
  acquisition?: Omit<Acquisition, "captured_at">;
  externalIds?: Partial<Record<string, string>>;
  isTester?: boolean;
  source: Caused;
};

/** Inserts a person (rule 3.4 acquisition, 3.7 phone), records `person.created`, enqueues the duplicate check. */
export async function insertPerson(tx: Tx, ctx: EventCtx, input: NewPerson): Promise<{ personId: string }> {
  const email = normaliseEmail(input.email ?? null);
  const resolved = input.acquisition ? await resolveAcquisition(tx, input.acquisition, ctx.now) : null;
  const phone = clean(input.phone ?? undefined);
  const [row] = await tx
    .insert(persons)
    .values({
      email,
      emailHash: email ? emailHash(email) : null,
      phone: phone ?? null,
      phoneE164: normalisePhone(phone),
      firstName: clean(input.firstName ?? undefined) ?? null,
      lastName: clean(input.lastName ?? undefined) ?? null,
      locale: input.locale,
      address: input.address ?? null,
      birthOn: input.birthOn ? assertBirthOn(input.birthOn, ctx.now) : null,
      preferredChannel: input.preferredChannel ?? null,
      acquisition: (resolved?.acquisition ?? {}) as PersonRow["acquisition"],
      partnerCompanyId: resolved?.partnerCompanyId ?? null,
      externalIds: compact(input.externalIds ?? {}) as PersonRow["externalIds"],
      isTester: input.isTester ?? false,
    })
    .returning({ id: persons.id, version: persons.version });
  const personId = row!.id;
  const a = resolved?.acquisition;
  await ctx.recordEvent({
    kind: "person.created",
    personId,
    data: compact({ acquisition_source: a?.source, acquisition_campaign: a?.campaign, acquisition_medium: a?.medium, source: input.source }),
  });
  await enqueueDuplicateCheck(ctx, personId, row!.version);
  return { personId };
}

/**
 * Stamps the acquisition and resolves an R3 referral code through credits (rule 3.4): a known code
 * is stored upper-cased and fills `referrer_person_id` and `partner_company_id` when empty; an
 * unknown code, or the pre-R3 stub, drops it.
 */
export async function resolveAcquisition(
  tx: DbOrTx,
  input: Omit<Acquisition, "captured_at">,
  now: Date,
): Promise<{ acquisition: Acquisition; partnerCompanyId: string | null }> {
  let acquisition: Acquisition;
  try {
    acquisition = captureAcquisition(input, now);
  } catch (error) {
    const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] }).issues ?? [];
    const fields = Object.fromEntries(issues.map((i) => [`acquisition.${i.path.map(String).join(".")}`, i.message]));
    throw new ValidationError(issues[0]?.message ?? "invalid_acquisition", fields);
  }
  const code = acquisition.referral_code;
  if (!code) return { acquisition, partnerCompanyId: acquisition.partner_company_id ?? null };
  const { referral_code: _drop, ...rest } = acquisition;
  let known: Awaited<ReturnType<typeof resolveReferralCode>> = null;
  try {
    known = await resolveReferralCode(tx, code.toUpperCase());
  } catch (error) {
    if (!(error instanceof NotImplementedError)) throw error;
  }
  if (!known) return { acquisition: rest, partnerCompanyId: rest.partner_company_id ?? null };
  const out: Acquisition = { ...rest, referral_code: code.toUpperCase() };
  if (!out.referrer_person_id && known.referrerPersonId) out.referrer_person_id = known.referrerPersonId;
  if (!out.partner_company_id && known.partnerCompanyId) out.partner_company_id = known.partnerCompanyId;
  return { acquisition: out, partnerCompanyId: known.partnerCompanyId ?? out.partner_company_id ?? null };
}

/** The person row locked `FOR UPDATE`; a merged id is followed to its winner; erased is `not_found`. */
export async function lockActivePerson(tx: DbOrTx, personId: string): Promise<PersonRow> {
  const id = await resolveCanonicalPersonId(tx, personId);
  const [row] = await tx.select().from(persons).where(eq(persons.id, id)).for("update");
  if (!row || row.erasedAt) throw new NotFoundError("person_not_found");
  return row;
}

export async function rowById(tx: DbOrTx, personId: string): Promise<PersonRow> {
  const [row] = await tx.select().from(persons).where(eq(persons.id, personId));
  if (!row) throw new NotFoundError("person_not_found");
  return row;
}

/** Rule 3.2: `pg_advisory_xact_lock(hashtext(lower(email)))`. */
export async function lockEmail(tx: DbOrTx, email: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(lower(${email})))`);
}

/** The active person with the address, else the winner of a merged person with it (rule 3.2). */
export async function findByEmail(tx: DbOrTx, email: string): Promise<PersonRow | null> {
  const [active] = await tx
    .select()
    .from(persons)
    .where(and(sql`lower(${persons.email}) = ${email}`, isNull(persons.erasedAt), isNull(persons.mergedIntoPersonId)));
  if (active) return active;
  const [merged] = await tx
    .select({ winner: persons.mergedIntoPersonId })
    .from(persons)
    .where(and(sql`lower(${persons.email}) = ${email}`, isNull(persons.erasedAt), sql`${persons.mergedIntoPersonId} is not null`))
    .orderBy(persons.createdAt)
    .limit(1);
  if (!merged?.winner) return null;
  const winner = await rowById(tx, await resolveCanonicalPersonId(tx, merged.winner));
  return winner.erasedAt ? null : winner;
}

export async function bumpVersion(tx: DbOrTx, personId: string): Promise<void> {
  await tx
    .update(persons)
    .set({ version: sql`${persons.version} + 1` })
    .where(eq(persons.id, personId));
}

/** `ctx.audit` when the caller has it (actions), else a direct `audit_log` row (jobs, api callers). */
export async function auditWith(tx: DbOrTx, ctx: EventCtx, input: AuditInput): Promise<void> {
  const full = ctx as Partial<Ctx> & EventCtx;
  if (typeof full.audit === "function") return full.audit(input);
  await writeAuditRow(tx, { actor: actorJson(ctx.actor), requestId: ctx.requestId }, input);
}

/** Rule 3.29: `crm.check_duplicates`, key `dupcheck:<person_id>:<version>`. */
export async function enqueueDuplicateCheck(ctx: EventCtx, personId: string, version: number): Promise<void> {
  await ctx.enqueue({ kind: "crm.check_duplicates", payload: { personId }, key: `dupcheck:${personId}:${version}` });
}

export const DUPLICATE_FIELDS = new Set(["email", "phone", "firstName", "lastName", "birthOn", "postalCode"]);

/** Zod rejects future dates (crm spec 2.1); the table checks `> 1900-01-01`. */
export function assertBirthOn(value: string, now: Date): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value <= "1900-01-01" || value > now.toISOString().slice(0, 10)) {
    throw new ValidationError("invalid_birth_on", { birthOn: "invalid_birth_on" });
  }
  return value;
}

/** Name 1..100 and a phone normalised like rule 3.7 (crm spec 2.1). */
export function normaliseEmergencyContact(input: EmergencyContact): EmergencyContact {
  const name = input.name?.trim() ?? "";
  const phone = input.phone?.trim() ?? "";
  if (!name || name.length > 100) throw new ValidationError("invalid_emergency_contact", { "emergencyContact.name": "1..100" });
  if (!phone) throw new ValidationError("invalid_emergency_contact", { "emergencyContact.phone": "required" });
  const relation = input.relation?.trim();
  return { name, phone: normalisePhone(phone) ?? phone, ...(relation ? { relation } : {}) };
}

export function clean(value: string | null | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

/** Drops `undefined` values (Zod event schemas and jsonb columns get no undefined keys). */
export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** `source` of `person.created`: import, form, staff (manual), else system. */
function causedBy(ctx: EventCtx, acquisition: Omit<Acquisition, "captured_at"> | undefined): Caused {
  if (acquisition?.source === "import") return "import";
  if (acquisition?.form_slug) return "form";
  return ctx.actor.kind === "staff" ? "manual" : "system";
}

async function canonicalOrNull(tx: DbOrTx, personId: string): Promise<string | null> {
  let id = personId;
  for (let i = 0; i < 5; i++) {
    const [row] = await tx.select({ id: persons.id, into: persons.mergedIntoPersonId }).from(persons).where(eq(persons.id, id));
    if (!row) return null;
    if (!row.into) return row.id;
    id = row.into;
  }
  return id;
}

/** Rule 3.3: fills only empty `first_name`, `last_name`, `phone`; never locale, acquisition or consent. */
async function fillEmptyFields(tx: Tx, ctx: EventCtx, person: PersonRow, fields: { firstName?: string; lastName?: string; phone?: string }): Promise<void> {
  const patch = compact({ firstName: clean(fields.firstName), lastName: clean(fields.lastName), phone: clean(fields.phone) });
  if (!Object.keys(patch).length) return;
  await updatePersonFields(tx, ctx, person.id, patch, { onlyEmpty: true });
}

async function applyImportTags(tx: Tx, ctx: EventCtx, personId: string, keys: string[] | undefined): Promise<boolean> {
  if (!keys?.length) return false;
  const known = await tx.select({ key: tags.key }).from(tags).where(inArray(tags.key, keys));
  let any = false;
  for (const { key } of known) if ((await applyTag(tx, ctx, personId, key, "import")).applied) any = true;
  return any;
}
