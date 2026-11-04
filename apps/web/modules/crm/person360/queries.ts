/**
 * Customer 360 query (crm spec 4.3, 5.1, rules 3.9 to 3.11, 3.55), crm-P7: everything the page
 * shows that crm owns. A merged id returns `redirectTo` (the winner) and the page redirects; the
 * foreign panels (credits, booking, commerce, finance, ops, automation, email) are loaded by the
 * page through `safePanel()`. Never returns sensitive values: the sensitive panel lists only the
 * keys that hold a value and their change dates.
 */
import type { DbOrTx } from "@beam/db";
import {
  activityEvents,
  companies,
  personSensitiveFields,
  personTags,
  persons,
  segmentMembers,
  segments,
  tags,
  type AcquisitionJson,
  type PostalAddressJson,
} from "@beam/db/schema";
import { formatCustomerNumber, type PersonStatus } from "@beam/core/crm";
import type { Locale } from "@beam/core/i18n";
import type { SensitiveFieldKey } from "@beam/core/privacy";
import { and, asc, desc, eq, gte } from "@/lib/ctx";
import { listPersonCompanies } from "../companies/api";
import { getPersonStatus } from "../persons/api";
import { getReceptionCard, personName, type ReceptionCardData } from "./api";

export type Person360 = {
  /** Set when the requested id was merged: the page redirects to the winner. */
  redirectTo: string | null;
  person: {
    id: string;
    customerNumber: string;
    name: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    locale: Locale;
    version: number;
    address: PostalAddressJson | null;
    birthOn: string | null;
    preferredChannel: "email" | "phone" | "whatsapp" | null;
    linkedinUrl: string | null;
    emergencyContact: { name: string; phone: string; relation?: string } | null;
    acquisition: AcquisitionJson;
    partnerCompany: { id: string; name: string } | null;
    isTester: boolean;
    erasedAt: Date | null;
    processingRestrictedAt: Date | null;
    createdAt: Date;
  };
  status: {
    status: PersonStatus;
    derivedStatus: PersonStatus;
    override: PersonStatus | null;
    isMember: boolean;
    overrideReason: string | null;
    overrideAt: Date | null;
    /** Rule 3.11: the override differs from the derived status and was not kept for this derived status. */
    showConflictBanner: boolean;
  };
  tags: Array<{ id: string; key: string; name: Record<string, string | undefined>; color: string }>;
  companies: Array<{ companyId: string; name: string; position: string | null; decisionRole: string | null }>;
  reception: ReceptionCardData;
  sensitiveKeys: Array<{ key: SensitiveFieldKey; updatedAt: Date }>;
};

/** Rule 3.11: "Keep" hides the banner until the derived status changes again (or the override changes). */
async function overrideConfirmed(tx: DbOrTx, personId: string, override: PersonStatus, derived: PersonStatus, since: Date | null): Promise<boolean> {
  const [row] = await tx
    .select({ data: activityEvents.data })
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.personId, personId),
        eq(activityEvents.kind, "person.status_override_confirmed"),
        since ? gte(activityEvents.occurredAt, since) : undefined,
      ),
    )
    .orderBy(desc(activityEvents.occurredAt), desc(activityEvents.id))
    .limit(1);
  const data = (row?.data ?? null) as { status?: string; derived_status?: string } | null;
  return !!data && data.status === override && data.derived_status === derived;
}

/** The 360 "Segments" panel: the non-archived segments whose stored member set holds the person. */
export function listPersonSegments(tx: DbOrTx, personId: string): Promise<Array<{ id: string; name: string; kind: "dynamic" | "static"; computedAt: Date }>> {
  return tx
    .select({ id: segments.id, name: segments.name, kind: segments.kind, computedAt: segmentMembers.computedAt })
    .from(segmentMembers)
    .innerJoin(segments, eq(segments.id, segmentMembers.segmentId))
    .where(and(eq(segmentMembers.personId, personId), eq(segments.isArchived, false)))
    .orderBy(asc(segments.name), asc(segments.id));
}

export async function getPerson360(tx: DbOrTx, personId: string, now: Date = new Date()): Promise<Person360 | null> {
  const [p] = await tx.select().from(persons).where(eq(persons.id, personId));
  if (!p) return null;
  if (p.mergedIntoPersonId) {
    const [winner] = await tx.select({ id: persons.id, mergedInto: persons.mergedIntoPersonId }).from(persons).where(eq(persons.id, p.mergedIntoPersonId));
    const target = winner?.mergedInto ?? winner?.id ?? p.mergedIntoPersonId;
    return { ...(await build(tx, p, now)), redirectTo: target };
  }
  return build(tx, p, now);
}

async function build(tx: DbOrTx, p: typeof persons.$inferSelect, now: Date): Promise<Person360> {
  const [status, tagRows, companyRows, reception, sensitive, partner] = await Promise.all([
    getPersonStatus(tx, p.id),
    tx
      .select({ id: tags.id, key: tags.key, name: tags.name, color: tags.color })
      .from(personTags)
      .innerJoin(tags, eq(tags.id, personTags.tagId))
      .where(eq(personTags.personId, p.id))
      .orderBy(asc(tags.key)),
    listPersonCompanies(tx, p.id),
    getReceptionCard(tx, p.id, now),
    tx
      .select({ key: personSensitiveFields.key, updatedAt: personSensitiveFields.updatedAt })
      .from(personSensitiveFields)
      .where(eq(personSensitiveFields.personId, p.id))
      .orderBy(asc(personSensitiveFields.key)),
    p.partnerCompanyId
      ? tx.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, p.partnerCompanyId))
      : Promise.resolve([] as Array<{ id: string; name: string }>),
  ]);
  const conflict = status.override !== null && status.override !== status.derivedStatus;
  const showConflictBanner = conflict && !(await overrideConfirmed(tx, p.id, status.override!, status.derivedStatus, p.statusOverrideAt));
  return {
    redirectTo: null,
    person: {
      id: p.id,
      customerNumber: formatCustomerNumber(p.customerNumber),
      name: personName(p),
      firstName: p.firstName,
      lastName: p.lastName,
      email: p.email,
      phone: p.phone,
      locale: p.locale,
      version: p.version,
      address: p.address ?? null,
      birthOn: p.birthOn ?? null,
      preferredChannel: p.preferredChannel ?? null,
      linkedinUrl: p.linkedinUrl ?? null,
      emergencyContact: p.emergencyContact ?? null,
      acquisition: p.acquisition,
      partnerCompany: partner[0] ?? null,
      isTester: p.isTester,
      erasedAt: p.erasedAt,
      processingRestrictedAt: p.processingRestrictedAt,
      createdAt: p.createdAt,
    },
    status: {
      status: status.status,
      derivedStatus: status.derivedStatus,
      override: status.override,
      isMember: status.hasActiveMembership,
      overrideReason: p.statusOverrideReason,
      overrideAt: p.statusOverrideAt,
      showConflictBanner,
    },
    tags: tagRows.map((t) => ({ ...t, name: t.name as Record<string, string | undefined> })),
    companies: companyRows,
    reception,
    sensitiveKeys: sensitive.map((s) => ({ key: s.key as SensitiveFieldKey, updatedAt: s.updatedAt })),
  };
}
