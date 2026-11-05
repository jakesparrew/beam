/**
 * crm's cross-module door (crm spec 4.8, 02-data-model section 6.2). A barrel written once by
 * crm-P1: every function lives in its area file (`./<area>/api.ts`) with the owner's final
 * signature and is implemented by the package that owns that area (P2 persons and tags, P3
 * consent and declarations, P4 duplicates, P5 segments, P6 tasks and companies, P7 timeline
 * and reception card, P9 inbox). Until then each throws `NotImplementedError('crm.<fn>')`.
 * Every function takes the caller's open transaction first, so the caller stays one transaction.
 */
import type { DbOrTx } from "@beam/db";
import type { Ctx } from "@/lib/ctx";
import type { ReceptionCardData } from "./person360/api";

export type { Acquisition, AcquisitionSource, PersonFieldPatch, PersonStatus } from "@beam/core/crm";

/** crm spec 4.8: the context crm functions need from the caller. */
export type EventCtx = Pick<Ctx, "actor" | "now" | "requestId" | "enqueue" | "recordEvent">;

// identity
export {
  createPersonWithoutEmail,
  fillAcquisitionIfEmpty,
  findOrCreatePersonByEmail,
  findPersonIdsByEmailHash,
  getPerson,
  getPersonPrefill,
  getPersonStatus,
  listInactiveProfiles,
  resolveCanonicalPersonId,
  resolvePersonIds,
  restrictProcessing,
  searchPersons,
  setPersonTester,
  setStatusOverride,
  updatePersonFields,
  upsertPersonFromImport,
} from "./persons/api";
export { findLikelyDuplicates } from "./duplicates/api";
export { hasValidDeclaration } from "./declarations/api";
export type { ReceptionCardData } from "./person360/api";
// booking-P4's check-in desk renders crm's card (crm-P7 request). Exported from the component
// file itself: `./person360/api` imports forms' api, which reaches ops' api, which imports this
// barrel; a static re-export would close that cycle (ops-P5 request).
export { ReceptionCard, receptionCardLabels, type ReceptionCardLabels } from "./ui/person-360/reception-card";

/** `getReceptionCard` (crm-P7), loaded lazily to keep forms' and ops' apis out of this barrel's import graph. */
export async function getReceptionCard(tx: DbOrTx, personId: string, now?: Date): Promise<ReceptionCardData> {
  const { getReceptionCard: load } = await import("./person360/api");
  return load(tx, personId, now);
}

// consent and suppression
export { addSuppression, buildPreferenceUrls, currentWordingVersion, getCurrentConsents, isSuppressed, recordConsent, unsubscribe } from "./consent/api";
// The published consent wording (text and version) of each marketing purpose, for forms that
// show crm's wording outside crm (webinar registration; webinar-P3 request).
export { getCurrentMarketingWordings } from "./consent/queries";

// timeline, tags, segments, tasks
export { listTimeline } from "./timeline/api";
export { applyTag, removeTag } from "./tags/api";
export { countSegmentRefreshErrors, getSegmentRef, getSegmentSummaries, isInSegment, refreshSegment, segmentAudienceSql } from "./segments/api";
export { countOpenTasks, createTask } from "./tasks/api";

// companies
export { addCompanyContact, getCompany, listPartnerCompanies, listPersonCompanies, upsertCompany } from "./companies/api";

// R3 inbox entry points
export { createInboxThreadFromForm, ingestInboundEmail } from "./inbox/api";
