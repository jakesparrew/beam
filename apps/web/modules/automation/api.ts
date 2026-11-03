/**
 * automation's cross-module door (02-data-model section 6.9). Wave 0 stubs by platform-P7 with
 * the owner's final signatures: each throws `NotImplementedError('automation.<fn>')` until
 * automation implements it. `PersonAutomationsPanel` moves to `./ui/person-automations-panel`
 * when automation builds it; the Wave 0 stand-in throws.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { AutomationTimelineItem, EnrolResult, PersonEnrolmentSummary } from "@beam/core/automation";
import type { Actor, Ctx } from "@/lib/ctx";

export type { AutomationRunOutcome, AutomationTimelineItem, EnrolResult, PersonEnrolmentSummary } from "@beam/core/automation";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`automation.${fn}`));

/** Called only by crm.addSuppression in the transaction that inserts the suppression (D8). */
export function requestSuppressionExit(_tx: Tx, _input: { suppressionId: string }): Promise<{ jobId: string | null }> {
  return notYet("requestSuppressionExit");
}

/** Called by crm merge (loser, 'merged') and by this module's privacy erase ('erased'). */
export function exitPersonEnrolments(
  _tx: Tx,
  _input: { personId: string; reason: "erased" | "merged" | "manual" | "restricted" | "objected"; onlyMarketing?: boolean; actor: Actor },
): Promise<{ exited: number }> {
  return notYet("exitPersonEnrolments");
}

/** Ops' restriction and objection transaction (ops rules 65, 66). */
export function exitAllForPerson(_tx: Tx, _ctx: Ctx, _personId: string, _reason: "restricted" | "objected"): Promise<{ exited: number }> {
  return notYet("exitAllForPerson");
}

/** Enrol into a manual-trigger automation from another module. */
export function enrolPersonBySlug(
  _tx: Tx,
  _input: { slug: string; personId: string; anchorAt?: Date; subjectKey?: string; context?: Record<string, string | number | boolean | null> },
): Promise<EnrolResult> {
  return notYet("enrolPersonBySlug");
}

/** Called by email before archiving a template (email rule 15). */
export function isTemplateInUse(_tx: DbOrTx, _templateSlug: string): Promise<boolean> {
  return notYet("isTemplateInUse");
}

/** Called by crm's archiveSegment guard. */
export function isSegmentInUse(_db: DbOrTx, _segmentId: string): Promise<boolean> {
  return notYet("isSegmentInUse");
}

export function listPersonEnrolments(_db: DbOrTx, _personId: string): Promise<PersonEnrolmentSummary[]> {
  return notYet("listPersonEnrolments");
}

/** Merged into the crm person timeline. */
export function getTimelineItems(_db: DbOrTx, _personId: string, _opts?: { before?: Date; limit?: number }): Promise<AutomationTimelineItem[]> {
  return notYet("getTimelineItems");
}

export function hasActiveEnrolment(_db: DbOrTx, _personId: string, _slug: string): Promise<boolean> {
  return notYet("hasActiveEnrolment");
}

/** Read by ops.daily_digest. */
export function countAutomationIssues(
  _db: DbOrTx,
  _since: Date,
): Promise<{ failed: number; skippedTranslation: number; stuck: number; evaluatorLagSeconds: number }> {
  return notYet("countAutomationIssues");
}

/** Server component rendered by crm in the person page "Automations" tab (Wave 0 stand-in). */
export function PersonAutomationsPanel(_props: { personId: string }): never {
  throw new NotImplementedError("automation.PersonAutomationsPanel");
}
