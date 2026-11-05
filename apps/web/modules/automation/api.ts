/**
 * automation's cross-module door (automation spec 4.7, 02-data-model section 6.9). automation-P2
 * implements every function; automation-P6 gives `PersonAutomationsPanel` its full panel (staff
 * controls, preview drawer, timeline with outcome filters), replacing automation-P4's interim one.
 */
import type { ReactElement } from "react";
import type { DbOrTx, Tx } from "@beam/db";
import {
  automationEnrolments,
  automationRuns,
  automations,
  automationVersions,
  vPersonAutomationTimeline,
} from "@beam/db/schema";
import type { AutomationTimelineItem, EnrolResult, PersonEnrolmentSummary } from "@beam/core/automation";
import { and, desc, enqueueJob, eq, gt, inArray, lt, sql, type Actor, type Ctx } from "@/lib/ctx";
import { evaluatorLagSeconds } from "./engine/cursor";
import { enrol, IN_USE_STATUSES, loadAutomations } from "./engine/enrol";
import { exitPersonEnrolments as exitAll } from "./engine/exits";
import type { PersonAutomationsPanelProps } from "./ui/person-automations-panel";

export type { AutomationRunOutcome, AutomationTimelineItem, EnrolResult, PersonEnrolmentSummary } from "@beam/core/automation";
export { endEnrolment } from "./engine/exits";

const SYSTEM: Actor = { kind: "system", jobId: "" };

/** Called only by crm.addSuppression in the transaction that inserts the suppression (D8): enqueues `automation.exit_for_suppression`. */
export async function requestSuppressionExit(tx: Tx, input: { suppressionId: string }): Promise<{ jobId: string | null }> {
  const { id } = await enqueueJob(tx, {
    kind: "automation.exit_for_suppression",
    payload: { suppressionId: input.suppressionId },
    key: `supp:${input.suppressionId}`,
    lane: "fast",
  });
  return { jobId: id };
}

/** Called by crm merge (loser, 'merged') and by this module's privacy erase ('erased'). */
export function exitPersonEnrolments(
  tx: Tx,
  input: { personId: string; reason: "erased" | "merged" | "manual" | "restricted" | "objected"; onlyMarketing?: boolean; actor: Actor },
): Promise<{ exited: number }> {
  return exitAll(tx, input);
}

/** Ops' restriction and objection transaction (ops rules 65, 66): ends marketing journeys only. */
export function exitAllForPerson(tx: Tx, ctx: Ctx, personId: string, reason: "restricted" | "objected"): Promise<{ exited: number }> {
  return exitAll(tx, { personId, reason, onlyMarketing: true, actor: ctx.actor });
}

/** Enrol from another module (forms R2 outcomes, site, crm R3): source `api`, every entry rule applies. */
export async function enrolPersonBySlug(
  tx: Tx,
  input: { slug: string; personId: string; anchorAt?: Date; subjectKey?: string; context?: Record<string, string | number | boolean | null> },
): Promise<EnrolResult> {
  const [automation] = await loadAutomations(tx, { slugs: [input.slug] });
  if (!automation) return { status: "skipped", outcome: "inactive" };
  return enrol(tx, {
    automation,
    personId: input.personId,
    source: "api",
    actor: SYSTEM,
    now: new Date(),
    anchorAt: input.anchorAt ?? null,
    ...(input.subjectKey !== undefined ? { subjectKey: input.subjectKey } : {}),
    ...(input.context ? { vars: input.context } : {}),
  });
}

/** The current-version and draft definitions of every draft, active or paused automation. */
async function inUseDefinitions(db: DbOrTx): Promise<unknown[]> {
  const rows = await db
    .select({ draft: automations.draftDefinition, current: automationVersions.definition })
    .from(automations)
    .leftJoin(automationVersions, eq(automationVersions.id, automations.currentVersionId))
    .where(inArray(automations.status, [...IN_USE_STATUSES]));
  return rows.flatMap((r) => [r.current, r.draft].filter((d) => d !== null && d !== undefined));
}

/** Walks a definition (parsed or a draft with issues) and calls `visit` for every object. */
function walk(value: unknown, visit: (obj: Record<string, unknown>) => boolean): boolean {
  if (Array.isArray(value)) return value.some((v) => walk(v, visit));
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return visit(obj) || Object.values(obj).some((v) => walk(v, visit));
}

/** Called by email before archiving a template (email rule 15). */
export async function isTemplateInUse(tx: DbOrTx, templateSlug: string): Promise<boolean> {
  return (await inUseDefinitions(tx)).some((def) => walk(def, (o) => o.type === "email" && o.template === templateSlug));
}

/** Called by crm's archiveSegment guard: trigger, audience, exclusions or an `in_segment` condition. */
export async function isSegmentInUse(db: DbOrTx, segmentId: string): Promise<boolean> {
  return (await inUseDefinitions(db)).some((def) =>
    walk(
      def,
      (o) =>
        o.segment_enter === segmentId ||
        o.segment_id === segmentId ||
        o.in_segment === segmentId ||
        (Array.isArray(o.exclude_segment_ids) && o.exclude_segment_ids.includes(segmentId)),
    ),
  );
}

export async function listPersonEnrolments(db: DbOrTx, personId: string): Promise<PersonEnrolmentSummary[]> {
  return db
    .select({
      enrolmentId: automationEnrolments.id,
      automationSlug: automations.slug,
      automationName: automations.name,
      status: automationEnrolments.status,
      enteredAt: automationEnrolments.enteredAt,
      endedAt: automationEnrolments.endedAt,
      endReason: automationEnrolments.endReason,
      nextStepKey: automationEnrolments.nextStepKey,
      nextStepAt: automationEnrolments.nextStepAt,
    })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .where(eq(automationEnrolments.personId, personId))
    .orderBy(desc(automationEnrolments.enteredAt), desc(automationEnrolments.id));
}

/** Merged into the crm person timeline, newest first (default 100, at most 500). */
export async function getTimelineItems(db: DbOrTx, personId: string, opts: { before?: Date; limit?: number } = {}): Promise<AutomationTimelineItem[]> {
  const v = vPersonAutomationTimeline;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return db
    .select({
      id: v.id,
      occurredAt: v.occurredAt,
      automationSlug: v.automationSlug,
      automationName: v.automationName,
      stepKey: v.stepKey,
      outcome: v.outcome,
      reason: v.reason,
      endReason: v.endReason,
      emailMessageId: v.emailMessageId,
      emailStatus: v.emailStatus,
      taskId: v.taskId,
    })
    .from(v)
    .where(and(eq(v.personId, personId), opts.before ? lt(v.occurredAt, opts.before) : undefined))
    .orderBy(desc(v.occurredAt), desc(v.id))
    .limit(limit);
}

export async function hasActiveEnrolment(db: DbOrTx, personId: string, slug: string): Promise<boolean> {
  const [row] = await db
    .select({ id: automationEnrolments.id })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .where(and(eq(automationEnrolments.personId, personId), eq(automations.slug, slug), eq(automationEnrolments.status, "active")))
    .limit(1);
  return !!row;
}

/** Stuck: an active enrolment of an active automation more than 30 minutes past `next_step_at` (A-45). */
export const STUCK_AFTER_MS = 30 * 60_000;

/** Read by ops.daily_digest and the System page (A-45). */
export async function countAutomationIssues(
  db: DbOrTx,
  since: Date,
): Promise<{ failed: number; skippedTranslation: number; stuck: number; evaluatorLagSeconds: number }> {
  const now = new Date();
  const [runs] = await db
    .select({
      failed: sql<number>`count(*) filter (where ${automationRuns.outcome} = 'failed')`.mapWith(Number),
      skippedTranslation: sql<number>`count(*) filter (where ${automationRuns.outcome} = 'skipped_translation')`.mapWith(Number),
    })
    .from(automationRuns)
    .where(and(gt(automationRuns.occurredAt, since), inArray(automationRuns.outcome, ["failed", "skipped_translation"])));
  const [stuck] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .where(
      and(
        eq(automationEnrolments.status, "active"),
        eq(automations.status, "active"),
        lt(automationEnrolments.nextStepAt, new Date(now.getTime() - STUCK_AFTER_MS)),
      ),
    );
  const lag = await evaluatorLagSeconds(db, now);
  return {
    failed: runs?.failed ?? 0,
    skippedTranslation: runs?.skippedTranslation ?? 0,
    stuck: Number(stuck?.n ?? 0),
    evaluatorLagSeconds: lag,
  };
}

export type { PersonAutomationsPanelProps } from "./ui/person-automations-panel";

/**
 * Server component rendered by crm in the person page "Automations" tab (spec 4.7 and 5,
 * A-36 to A-41): the panel of `./ui/person-automations-panel` with its props (`{ personId }`,
 * plus `db`, `locale`, `canMove` and `now` for tests). The panel module (client dialogs and
 * their server actions) loads when the panel renders, so importing this api from jobs and other
 * modules does not pull the UI in.
 */
export async function PersonAutomationsPanel(props: PersonAutomationsPanelProps): Promise<ReactElement> {
  const ui = await import("./ui/person-automations-panel");
  return ui.PersonAutomationsPanel(props);
}
