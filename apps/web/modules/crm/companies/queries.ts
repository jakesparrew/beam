/**
 * Company queries (crm spec 4.3, 5.1), crm-P6. `contacts` counts current contacts (no
 * `ended_on`); the detail lists every contact, current ones first, and for a partner company
 * the persons it referred (`persons.partner_company_id`, merged and erased persons left out).
 */
import type { DbOrTx } from "@beam/db";
import { companies, companyContacts, persons, users } from "@beam/db/schema";
import { normaliseVat, type CompanySize, type CompanyStatus, type DecisionRole, type PostalAddress } from "@beam/core/crm";
import { and, asc, eq, isNull, or, sql, type SQL } from "@/lib/ctx";

export type CompanyRow = {
  id: string;
  name: string;
  vatNumber: string | null;
  status: CompanyStatus;
  size: CompanySize | null;
  ownerUserId: string | null;
  ownerName: string | null;
  contacts: number;
  isPartner: boolean;
};

export type CompanyDetail = CompanyRow & {
  address: PostalAddress | null;
  website: string | null;
  industry: string | null;
  notes: string | null;
  partnerCommissionPct: number | null;
  contactList: Array<{ id: string; personId: string; name: string; position: string | null; decisionRole: DecisionRole | null; isPrimary: boolean; endedOn: string | null }>;
  referredPersons: Array<{ id: string; name: string }>;
  referredCount: number;
};

const REFERRED_LIMIT = 200;

const personName = sql<string>`coalesce(nullif(trim(concat_ws(' ', ${persons.firstName}, ${persons.lastName})), ''), 'C-' || lpad(${persons.customerNumber}::text, 6, '0'))`;
const ownerName = sql<string | null>`coalesce(${users.name}, ${users.email})`;
const contactCount = sql<number>`(select count(*)::int from company_contacts cc where cc.company_id = ${companies.id} and cc.ended_on is null)`;

export async function listCompanies(tx: DbOrTx, input: { q?: string; status?: CompanyStatus; isPartner?: boolean; limit?: number }): Promise<CompanyRow[]> {
  const where: SQL[] = [];
  const q = input.q?.trim();
  if (q) {
    const vat = normaliseVat(q);
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(or(sql`${companies.name} ilike ${like}`, sql`${companies.vatNumber} ilike ${like}`, vat ? eq(companies.vatNumber, vat) : undefined)!);
  }
  if (input.status) where.push(eq(companies.status, input.status));
  if (input.isPartner !== undefined) where.push(eq(companies.isPartner, input.isPartner));
  const rows = await tx
    .select({
      id: companies.id,
      name: companies.name,
      vatNumber: companies.vatNumber,
      status: companies.status,
      size: companies.size,
      ownerUserId: companies.ownerUserId,
      ownerName,
      contacts: contactCount,
      isPartner: companies.isPartner,
    })
    .from(companies)
    .leftJoin(users, eq(users.id, companies.ownerUserId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(sql`lower(${companies.name})`, asc(companies.id))
    .limit(Math.min(Math.max(input.limit ?? 200, 1), 500));
  return rows.map((r) => ({ ...r, contacts: Number(r.contacts) }));
}

export async function getCompany(tx: DbOrTx, id: string): Promise<CompanyDetail | null> {
  const [row] = await tx
    .select({ c: companies, ownerName, contacts: contactCount })
    .from(companies)
    .leftJoin(users, eq(users.id, companies.ownerUserId))
    .where(eq(companies.id, id));
  if (!row) return null;
  const c = row.c;
  const contactList = await tx
    .select({
      id: companyContacts.id,
      personId: companyContacts.personId,
      name: personName,
      position: companyContacts.position,
      decisionRole: companyContacts.decisionRole,
      isPrimary: companyContacts.isPrimary,
      endedOn: companyContacts.endedOn,
    })
    .from(companyContacts)
    .innerJoin(persons, eq(persons.id, companyContacts.personId))
    .where(eq(companyContacts.companyId, id))
    .orderBy(sql`${companyContacts.endedOn} is not null`, sql`${companyContacts.isPrimary} desc`, asc(personName), asc(companyContacts.id));

  const referredWhere = and(eq(persons.partnerCompanyId, id), isNull(persons.mergedIntoPersonId), isNull(persons.erasedAt));
  const [referredPersons, [count]] = c.isPartner
    ? await Promise.all([
        tx.select({ id: persons.id, name: personName }).from(persons).where(referredWhere).orderBy(asc(personName), asc(persons.id)).limit(REFERRED_LIMIT),
        tx.select({ n: sql<number>`count(*)::int` }).from(persons).where(referredWhere),
      ])
    : [[], [{ n: 0 }]];

  return {
    id: c.id,
    name: c.name,
    vatNumber: c.vatNumber,
    status: c.status,
    size: c.size,
    ownerUserId: c.ownerUserId,
    ownerName: row.ownerName,
    contacts: Number(row.contacts),
    isPartner: c.isPartner,
    address: c.address,
    website: c.website,
    industry: c.industry,
    notes: c.notes,
    partnerCommissionPct: c.partnerCommissionPct === null ? null : Number(c.partnerCommissionPct),
    contactList,
    referredPersons,
    referredCount: Number(count?.n ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Screen helpers (server side): labels of `ui/company-form.tsx` and `ui/contact-list.tsx`
// ---------------------------------------------------------------------------

type Tr = (key: string) => string;

export const COMPANY_SIZES = ["1_9", "10_49", "50_249", "250_plus"] as const;
export const COMPANY_STATUSES = ["target", "prospect", "customer", "partner", "inactive"] as const;
const DECISION_ROLES = ["decision_maker", "influencer", "user", "gatekeeper"] as const;

export function companyFormLabels(tr: Tr) {
  const f = (k: string) => tr(`crm.companies.form.${k}`);
  const p = (k: string) => tr(`crm.persons.new.${k}`);
  return {
    name: f("name"),
    vat: f("vat"),
    address: f("address"),
    street: p("street"),
    number: p("number"),
    postalCode: p("postal_code"),
    city: p("city"),
    country: p("country"),
    website: f("website"),
    industry: f("industry"),
    size: f("size"),
    status: f("status"),
    owner: f("owner"),
    notes: f("notes"),
    isPartner: f("is_partner"),
    commission: f("commission"),
    vatTaken: f("vat_taken"),
    vatInvalid: f("vat_invalid"),
    none: tr("crm.common.none"),
    save: tr("crm.common.save"),
    saving: tr("crm.common.saving"),
    saved: tr("crm.common.saved"),
    cancel: tr("crm.common.cancel"),
    error: tr("crm.common.error"),
  };
}

export function companyOptions(tr: Tr) {
  return {
    sizes: COMPANY_SIZES.map((s) => ({ value: s, label: tr(`crm.enums.company_size.${s}`) })),
    statuses: COMPANY_STATUSES.map((s) => ({ value: s, label: tr(`crm.enums.company_status.${s}`) })),
  };
}

/** `emailTaken` and `contactExists` show the generic error until the catalogue has their sentences (requested). */
export function contactListLabels(tr: Tr) {
  const d = (k: string) => tr(`crm.companies.detail.${k}`);
  const c = (k: string) => tr(`crm.companies.contact.${k}`);
  const p = (k: string) => tr(`crm.persons.new.${k}`);
  return {
    empty: d("contacts_empty"),
    name: tr("crm.companies.col_name"),
    position: c("position"),
    decisionRole: c("decision_role"),
    relationship: c("relationship"),
    isPrimary: c("is_primary"),
    primary: d("primary"),
    endedOn: c("ended_on"),
    endContact: d("end_contact"),
    makePrimary: c("is_primary"),
    linkContact: d("link_contact"),
    linkExisting: d("link_existing"),
    linkNew: d("link_new"),
    search: tr("crm.common.search"),
    searchPlaceholder: tr("crm.persons.list.search_placeholder"),
    firstName: p("first_name"),
    lastName: p("last_name"),
    email: p("email"),
    phone: p("phone"),
    emailTaken: tr("crm.common.error"),
    contactExists: tr("crm.common.error"),
    none: tr("crm.common.none"),
    save: tr("crm.common.save"),
    saving: tr("crm.common.saving"),
    cancel: tr("crm.common.cancel"),
    open: tr("crm.common.open"),
    error: tr("crm.common.error"),
    decisionRoles: Object.fromEntries(DECISION_ROLES.map((r) => [r, tr(`crm.enums.decision_role.${r}`)])) as Record<string, string>,
  };
}
