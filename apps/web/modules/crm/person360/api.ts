/**
 * Reception card api (crm spec 4.8, rules 3.54 and 3.55, cross-module D15), crm-P7. The data of
 * the reception quick view in the 360 header, which booking's check-in desk also renders with
 * the `ReceptionCard` component re-exported here. It never carries sensitive values: only the
 * name, customer number, status, tags (keys), the emergency contact and three declaration
 * states (site's terms, forms' `health-declaration` submission and crm's guardian consent).
 * A sibling function that is still a `NotImplementedError` stub counts as "not valid".
 */
import type { DbOrTx } from "@beam/db";
import { personTags, persons, tags } from "@beam/db/schema";
import { formatCustomerNumber, isMinor, type PersonStatus } from "@beam/core/crm";
import { NotImplementedError } from "@beam/core/errors";
import { asc, eq, NotFoundError } from "@/lib/ctx";
import { hasValidSubmission } from "@/modules/forms/api";
import { hasAcceptedCurrentTerms } from "@/modules/site/api";
import { hasValidDeclaration } from "../declarations/api";
import { getPersonStatus, resolveCanonicalPersonId } from "../persons/api";

export { ReceptionCard, receptionCardLabels, type ReceptionCardLabels } from "../ui/person-360/reception-card";

export type ReceptionCardData = {
  name: string;
  customerNumber: string;
  status: PersonStatus;
  isMember: boolean;
  tags: string[];
  emergencyContact: { name: string; phone: string } | null;
  declarations: { termsAccepted: boolean; healthDeclarationValid: boolean; guardianConsentValid: boolean };
  isMinor: boolean;
};

/** A not-yet-implemented sibling reads as `false`; any other error propagates. */
async function orFalse(load: () => Promise<boolean>): Promise<boolean> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof NotImplementedError) return false;
    throw error;
  }
}

export const personName = (p: { firstName: string | null; lastName: string | null }): string =>
  [p.firstName, p.lastName].filter((s): s is string => !!s && s.trim().length > 0).join(" ");

/** The reception quick view of a person (a merged id resolves to its winner). */
export async function getReceptionCard(tx: DbOrTx, personId: string, now: Date = new Date()): Promise<ReceptionCardData> {
  const id = await resolveCanonicalPersonId(tx, personId);
  const [p] = await tx
    .select({
      firstName: persons.firstName,
      lastName: persons.lastName,
      customerNumber: persons.customerNumber,
      birthOn: persons.birthOn,
      emergencyContact: persons.emergencyContact,
    })
    .from(persons)
    .where(eq(persons.id, id));
  if (!p) throw new NotFoundError("person_not_found");
  const [status, tagRows, termsAccepted, healthDeclarationValid, guardianConsentValid] = await Promise.all([
    getPersonStatus(tx, id),
    tx.select({ key: tags.key }).from(personTags).innerJoin(tags, eq(tags.id, personTags.tagId)).where(eq(personTags.personId, id)).orderBy(asc(tags.key)),
    orFalse(() => hasAcceptedCurrentTerms(tx, id)),
    orFalse(async () => (await hasValidSubmission(tx, { personId: id, formSlug: "health-declaration" })).valid),
    orFalse(() => hasValidDeclaration(tx, { personId: id, kind: "guardian_consent" })),
  ]);
  const ec = p.emergencyContact;
  return {
    name: personName(p),
    customerNumber: formatCustomerNumber(p.customerNumber),
    status: status.status,
    isMember: status.hasActiveMembership,
    tags: tagRows.map((t) => t.key),
    emergencyContact: ec && ec.name && ec.phone ? { name: ec.name, phone: ec.phone } : null,
    declarations: { termsAccepted, healthDeclarationValid, guardianConsentValid },
    isMinor: isMinor(p.birthOn, now),
  };
}
