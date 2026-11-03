/**
 * crm's cross-module door (02-data-model section 6.2). Wave 0 stubs by platform-P7 with the
 * owner's final signatures: each throws `NotImplementedError('crm.<fn>')` until crm implements
 * it. `findOrCreatePersonByEmail` is platform-P5's forward stub, kept unchanged (DR-10).
 */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { Locale } from "@beam/core/i18n";
import type {
  Acquisition,
  CompanySize,
  CompanyStatus,
  CompanySummary,
  ConsentMethod,
  ConsentPurpose,
  ConsentState,
  DecisionRole,
  DuplicateReason,
  ImportPersonRow,
  MarketingPurpose,
  PersonFieldPatch,
  PersonStatus,
  PersonSummary,
  PersonTagSource,
  PostalAddress,
  SuppressionReason,
  SuppressionScope,
  TaskKind,
  TaskPriority,
  TaskSource,
  TimelineCategory,
  TimelinePage,
} from "@beam/core/crm";
import type { RoleKey } from "@beam/db/schema";
import type { Ctx, SQL } from "@/lib/ctx";

export type { Acquisition, AcquisitionSource, PersonFieldPatch, PersonStatus } from "@beam/core/crm";

/** crm spec 4.8: the context crm functions need from the caller. */
export type EventCtx = Pick<Ctx, "actor" | "now" | "requestId" | "enqueue" | "recordEvent">;

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`crm.${fn}`));

// identity --------------------------------------------------------------------

export function findOrCreatePersonByEmail(
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
  void tx;
  void ctx;
  void input;
  return Promise.reject(new NotImplementedError("crm.findOrCreatePersonByEmail"));
}

export function createPersonWithoutEmail(
  _tx: Tx,
  _ctx: EventCtx,
  _input: { firstName: string; lastName?: string; phone?: string; locale: Locale; acquisition: Omit<Acquisition, "captured_at"> },
): Promise<{ personId: string }> {
  return notYet("createPersonWithoutEmail");
}

export function getPerson(_tx: DbOrTx, _personId: string): Promise<PersonSummary | null> {
  return notYet("getPerson");
}

export function resolveCanonicalPersonId(_tx: DbOrTx, _personId: string): Promise<string> {
  return notYet("resolveCanonicalPersonId");
}

export function resolvePersonIds(_tx: DbOrTx, _personId: string): Promise<string[]> {
  return notYet("resolvePersonIds");
}

export function getPersonStatus(
  _tx: DbOrTx,
  _personId: string,
): Promise<{ status: PersonStatus; derivedStatus: PersonStatus; override: PersonStatus | null; hasActiveMembership: boolean }> {
  return notYet("getPersonStatus");
}

export function setStatusOverride(
  _tx: Tx,
  _ctx: EventCtx,
  _input: { personId: string; status: PersonStatus | null; reason: string; onlyIfUnset?: boolean; source?: "manual" | "automation" },
): Promise<{ applied: boolean }> {
  return notYet("setStatusOverride");
}

export function upsertPersonFromImport(
  _tx: Tx,
  _ctx: EventCtx,
  _row: ImportPersonRow,
  _importId: string,
): Promise<{ personId: string; outcome: "created" | "updated" | "unchanged" }> {
  return notYet("upsertPersonFromImport");
}

export function findLikelyDuplicates(
  _tx: DbOrTx,
  _personId: string,
  _minScore?: number,
): Promise<Array<{ personId: string; score: number; reasons: DuplicateReason[] }>> {
  return notYet("findLikelyDuplicates");
}

export function restrictProcessing(_tx: Tx, _ctx: EventCtx, _personId: string, _restricted: boolean): Promise<void> {
  return notYet("restrictProcessing");
}

export function listInactiveProfiles(_tx: DbOrTx, _cutoff: Date, _limit: number, _filter?: { leadsOnly?: boolean }): Promise<string[]> {
  return notYet("listInactiveProfiles");
}

export function searchPersons(
  _tx: DbOrTx,
  _input: { q: string; limit?: number },
): Promise<Array<{ personId: string; customerNumber: string; name: string; email: string | null; status: PersonStatus }>> {
  return notYet("searchPersons");
}

export function updatePersonFields(
  _tx: Tx,
  _ctx: EventCtx,
  _personId: string,
  _patch: PersonFieldPatch,
  _opts: { onlyEmpty: boolean },
): Promise<{ changed: string[] }> {
  return notYet("updatePersonFields");
}

export function fillAcquisitionIfEmpty(
  _tx: Tx,
  _ctx: EventCtx,
  _personId: string,
  _acquisition: Omit<Acquisition, "captured_at">,
): Promise<{ applied: boolean }> {
  return notYet("fillAcquisitionIfEmpty");
}

export function getPersonPrefill(
  _tx: DbOrTx,
  _personId: string,
): Promise<{
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  locale: Locale;
  birthOn: string | null;
  postalCode: string | null;
  city: string | null;
}> {
  return notYet("getPersonPrefill");
}

export function findPersonIdsByEmailHash(_tx: DbOrTx, _emailHash: string): Promise<string[]> {
  return notYet("findPersonIdsByEmailHash");
}

export function setPersonTester(_tx: Tx, _ctx: EventCtx, _input: { personId: string; isTester: boolean }): Promise<void> {
  return notYet("setPersonTester");
}

export function hasValidDeclaration(_db: DbOrTx, _input: { personId: string; kind: "guardian_consent" }): Promise<boolean> {
  return notYet("hasValidDeclaration");
}

export function getReceptionCard(
  _tx: DbOrTx,
  _personId: string,
): Promise<{
  name: string;
  customerNumber: string;
  status: PersonStatus;
  isMember: boolean;
  tags: string[];
  emergencyContact: { name: string; phone: string } | null;
  declarations: { termsAccepted: boolean; healthDeclarationValid: boolean; guardianConsentValid: boolean };
  isMinor: boolean;
}> {
  return notYet("getReceptionCard");
}

// consent and suppression -----------------------------------------------------

export function recordConsent(
  _tx: Tx,
  _ctx: EventCtx,
  _input: {
    personId: string;
    purpose: ConsentPurpose;
    status: "granted" | "withdrawn";
    method: ConsentMethod;
    source: string;
    wordingVersion: string;
    lawfulBasis?: "consent" | "legitimate_interest";
    ip?: string;
    userAgent?: string;
    recordedAt?: Date;
    ref?: { type: string; id: string };
  },
): Promise<{ recordId: string | null; outcome: "recorded" | "unchanged" | "needs_confirmation" | "skipped_suppressed" | "skipped_minor" }> {
  return notYet("recordConsent");
}

export function getCurrentConsents(_tx: DbOrTx, _personId: string): Promise<Record<ConsentPurpose, ConsentState | null>> {
  return notYet("getCurrentConsents");
}

export function addSuppression(
  _tx: Tx,
  _ctx: EventCtx,
  _input: { email: string; scope: SuppressionScope; reason: SuppressionReason; source: string; personId?: string },
): Promise<{ suppressionId: string; created: boolean }> {
  return notYet("addSuppression");
}

export function unsubscribe(
  _tx: Tx,
  _ctx: EventCtx,
  _input: { personId: string; purpose: MarketingPurpose | "all"; method: ConsentMethod; source: string },
): Promise<{ suppressionId: string }> {
  return notYet("unsubscribe");
}

export function isSuppressed(_tx: DbOrTx, _email: string, _purpose: MarketingPurpose): Promise<boolean> {
  return notYet("isSuppressed");
}

/** Pure; email passes the message's link token. */
export function buildPreferenceUrls(_linkToken: string, _locale: Locale): { unsubscribeUrl: string; oneClickPostUrl: string; preferencesUrl: string } {
  throw new NotImplementedError("crm.buildPreferenceUrls");
}

// timeline, tags, segments, tasks ---------------------------------------------

export function listTimeline(
  _tx: DbOrTx,
  _input: { personId?: string; companyId?: string; before?: { occurredAt: Date; id: string }; categories?: TimelineCategory[]; limit?: number },
): Promise<TimelinePage> {
  return notYet("listTimeline");
}

export function applyTag(_tx: Tx, _ctx: EventCtx, _personId: string, _tagKey: string, _source: PersonTagSource): Promise<{ applied: boolean }> {
  return notYet("applyTag");
}

export function removeTag(_tx: Tx, _ctx: EventCtx, _personId: string, _tagKey: string): Promise<{ removed: boolean }> {
  return notYet("removeTag");
}

/** `select person_id …` of the segment, minus the excluded segments. */
export function segmentAudienceSql(_segmentId: string, _excludeSegmentIds?: string[]): SQL {
  throw new NotImplementedError("crm.segmentAudienceSql");
}

export function refreshSegment(
  _tx: Tx,
  _ctx: EventCtx,
  _segmentId: string,
  _reason: "campaign" | "manual" | "save",
): Promise<{ count: number; entered: number; left: number }> {
  return notYet("refreshSegment");
}

export function isInSegment(_tx: DbOrTx, _segmentId: string, _personId: string): Promise<boolean> {
  return notYet("isInSegment");
}

export function getSegmentRef(
  _tx: DbOrTx,
  _segmentId: string,
): Promise<{ id: string; name: string; kind: "dynamic" | "static"; isArchived: boolean } | null> {
  return notYet("getSegmentRef");
}

export function countSegmentRefreshErrors(_tx: DbOrTx): Promise<number> {
  return notYet("countSegmentRefreshErrors");
}

export function getSegmentSummaries(
  _tx: DbOrTx,
): Promise<Array<{ id: string; name: string; description: string | null; kind: "dynamic" | "static"; lastCount: number | null; lastCountedAt: Date | null }>> {
  return notYet("getSegmentSummaries");
}

export function createTask(
  _tx: Tx,
  _ctx: EventCtx,
  _input: {
    title: string;
    kind: TaskKind;
    ownerUserId?: string;
    ownerRole?: RoleKey;
    dueAt?: Date;
    priority?: TaskPriority;
    personId?: string;
    companyId?: string;
    source: TaskSource;
    ref?: { type: string; id: string };
    notes?: string;
    dedupeKey?: string;
  },
): Promise<{ taskId: string; created: boolean }> {
  return notYet("createTask");
}

export function countOpenTasks(_tx: DbOrTx, _filter: { overdue?: boolean; kind?: TaskKind; source?: TaskSource }): Promise<number> {
  return notYet("countOpenTasks");
}

// companies -------------------------------------------------------------------

export function getCompany(_tx: DbOrTx, _companyId: string): Promise<CompanySummary | null> {
  return notYet("getCompany");
}

export function listPersonCompanies(
  _tx: DbOrTx,
  _personId: string,
): Promise<Array<{ companyId: string; name: string; position: string | null; decisionRole: DecisionRole | null }>> {
  return notYet("listPersonCompanies");
}

export function listPartnerCompanies(_tx: DbOrTx): Promise<Array<{ id: string; name: string; commissionPct: number | null }>> {
  return notYet("listPartnerCompanies");
}

export function upsertCompany(
  _tx: Tx,
  _ctx: EventCtx,
  _input: {
    name: string;
    vatNumber?: string;
    address?: PostalAddress;
    website?: string;
    industry?: string;
    size?: CompanySize;
    status?: CompanyStatus;
    isPartner?: boolean;
  },
): Promise<{ companyId: string; outcome: "created" | "updated" | "unchanged" }> {
  return notYet("upsertCompany");
}

export function addCompanyContact(
  _tx: Tx,
  _ctx: EventCtx,
  _input: { companyId: string; personId: string; position?: string; decisionRole?: DecisionRole; relationship?: string },
): Promise<{ contactId: string; created: boolean }> {
  return notYet("addCompanyContact");
}

// R3 inbox entry points ---------------------------------------------------------

export function ingestInboundEmail(
  _tx: Tx,
  _ctx: EventCtx,
  _msg: {
    messageId: string;
    inReplyTo?: string;
    from: string;
    fromName?: string;
    subject: string;
    text: string;
    attachmentCount: number;
    receivedAt: Date;
  },
): Promise<{ threadId: string }> {
  return notYet("ingestInboundEmail");
}

export function createInboxThreadFromForm(
  _tx: Tx,
  _ctx: EventCtx,
  _input: { personId: string; submissionId: string; subject: string; body: string },
): Promise<{ threadId: string }> {
  return notYet("createInboxThreadFromForm");
}
