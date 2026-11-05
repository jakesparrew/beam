/**
 * Moving an enrolment along its plan (A-25, A-34, A-35). Shared by the step job, the bulk jobs
 * and the dead-step hook.
 *
 * - `lockEnrolment` reads one enrolment `FOR UPDATE` with its automation and parsed version.
 * - `advance` marks the current step `done` (or `skipped` with a reason), picks the next step
 *   (the branch target for a condition, A-34), stores the plan and `next_step_*`, writes the
 *   `scheduled` run of the next step, or completes the enrolment when nothing is left.
 * - `recordDeadStep` is the `onDead` hook of `automation.step` and `automation.call_webhook`
 *   (PL-29a) and the sweep fallback (A-35): one `failed` run per step, then the advance.
 *
 * Lock order (person, then enrolment): every path that locks an enrolment and may then reach
 * crm (tag, untag, set_field, status_override, an `enrol` step) first locks the enrolment's
 * person with `lockEnrolmentPerson`, as the evaluator does (enrol() locks the person, then the
 * domain holder enrolment). The step job, the dead-step hook and the version migration take it
 * before `lockEnrolment` / their enrolment `FOR UPDATE`; crm's `lockActivePerson` then re-takes
 * a lock the transaction already holds. The opposite order deadlocks with the evaluator.
 *
 * Dedupe keys: a step outcome is `run:<enrolment_id>:<step_key>:<outcome>`; a re-plan of the
 * same step (anchor moved, A-27a; deferred by quiet hours, A-32) writes its extra `scheduled`
 * row with `run:<enrolment_id>:<step_key>:scheduled:<qualifier>:<YYYY-MM-DDTHH:mm>`.
 */
import type { Tx } from "@beam/db";
import { automationEnrolments, automations, automationVersions, type EnrolmentContextJson, type RunDataJson } from "@beam/db/schema";
import {
  markStep,
  nextStep,
  type AutomationPurpose,
  type AutomationRunOutcome,
  type Definition,
  type PlannedStep,
} from "@beam/core/automation";
import { eq, sql, type Actor } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { endEnrolmentWith, versionDefinition } from "./exits";
import { runDedupeKey, writeRun, type NewRun } from "./runs";

/**
 * Locks the person of an enrolment (the first lock of the person-then-enrolment order, see the
 * header), with the engine's `PERSON_LOCK` mode `for no key update` (enrol.ts): foreign-key
 * inserts that reference the person do not wait for it. False when the enrolment does not exist.
 */
export async function lockEnrolmentPerson(tx: Tx, enrolmentId: string): Promise<boolean> {
  const r = await tx.execute(
    sql`select p.id from persons p join automation_enrolments e on e.person_id = p.id where e.id = ${enrolmentId}::uuid for no key update of p`,
  );
  return rowsOf(r).length > 0;
}

/** An enrolment locked for a step decision, with its automation and definition. */
export type LockedEnrolment = {
  id: string;
  automationId: string;
  versionId: string;
  personId: string;
  status: "active" | "completed" | "exited";
  source: string;
  subjectKey: string;
  nextStepKey: string | null;
  nextStepAt: Date | null;
  anchorAt: Date | null;
  enteredAt: Date;
  plan: PlannedStep[];
  context: EnrolmentContextJson;
  automation: {
    slug: string;
    name: string;
    status: "draft" | "active" | "paused" | "archived";
    isMarketing: boolean;
    purpose: AutomationPurpose | null;
    pausedAt: Date | null;
    lastResumedAt: Date | null;
    requiresFlag: string | null;
  };
  definition: Definition | null;
};

/** Reads one enrolment `FOR UPDATE` (the enrolment row only); null when it does not exist. */
export async function lockEnrolment(tx: Tx, enrolmentId: string): Promise<LockedEnrolment | null> {
  const [r] = await tx
    .select({
      id: automationEnrolments.id,
      automationId: automationEnrolments.automationId,
      versionId: automationEnrolments.automationVersionId,
      personId: automationEnrolments.personId,
      status: automationEnrolments.status,
      source: automationEnrolments.source,
      subjectKey: automationEnrolments.subjectKey,
      nextStepKey: automationEnrolments.nextStepKey,
      nextStepAt: automationEnrolments.nextStepAt,
      anchorAt: automationEnrolments.anchorAt,
      enteredAt: automationEnrolments.enteredAt,
      plan: automationEnrolments.plan,
      context: automationEnrolments.context,
      slug: automations.slug,
      name: automations.name,
      automationStatus: automations.status,
      isMarketing: automations.isMarketing,
      purpose: automations.purpose,
      pausedAt: automations.pausedAt,
      lastResumedAt: automations.lastResumedAt,
      requiresFlag: automations.requiresFlag,
      definition: automationVersions.definition,
    })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .innerJoin(automationVersions, eq(automationVersions.id, automationEnrolments.automationVersionId))
    .where(eq(automationEnrolments.id, enrolmentId))
    .for("update", { of: automationEnrolments });
  if (!r) return null;
  return {
    id: r.id,
    automationId: r.automationId,
    versionId: r.versionId,
    personId: r.personId,
    status: r.status,
    source: r.source,
    subjectKey: r.subjectKey,
    nextStepKey: r.nextStepKey,
    nextStepAt: r.nextStepAt,
    anchorAt: r.anchorAt,
    enteredAt: r.enteredAt,
    plan: r.plan,
    context: r.context,
    automation: {
      slug: r.slug,
      name: r.name,
      status: r.automationStatus,
      isMarketing: r.isMarketing,
      purpose: r.purpose,
      pausedAt: r.pausedAt,
      lastResumedAt: r.lastResumedAt,
      requiresFlag: r.requiresFlag,
    },
    definition: versionDefinition(r.versionId, r.definition),
  };
}

export type StepRunExtra = Pick<NewRun, "reason" | "data" | "emailMessageId" | "taskId">;

/** Writes one step outcome of an enrolment (`run:<enrolment_id>:<step_key>:<outcome>`). */
export function writeStepRun(tx: Tx, e: LockedEnrolment, stepKey: string, outcome: AutomationRunOutcome, actor: Actor, extra: StepRunExtra = {}): Promise<void> {
  return writeRun(tx, {
    enrolmentId: e.id,
    personId: e.personId,
    automationId: e.automationId,
    automationVersionId: e.versionId,
    stepKey,
    outcome,
    actor,
    dedupeKey: runDedupeKey(e.id, stepKey, outcome),
    ...extra,
  });
}

/** The `scheduled` dedupe key of a re-plan of a step that was already scheduled once. */
export const replanDedupeKey = (enrolmentId: string, stepKey: string, qualifier: string, at: Date): string =>
  `${runDedupeKey(enrolmentId, stepKey, "scheduled")}:${qualifier}:${at.toISOString().slice(0, 16)}`;

/** Stores a plan and the next step on the enrolment (no run). */
export async function storePlan(tx: Tx, enrolmentId: string, plan: PlannedStep[], next: PlannedStep | null): Promise<void> {
  await tx
    .update(automationEnrolments)
    .set({ plan, nextStepKey: next?.key ?? null, nextStepAt: next ? new Date(next.due_at) : null, updatedAt: sql`now()` })
    .where(eq(automationEnrolments.id, enrolmentId));
}

export type AdvanceOptions = {
  actor: Actor;
  now: Date;
  /** A condition's target (`'end'` closes the rest of the plan). */
  branch?: { target: string };
  /** How the current step ends in the plan (default `done`). */
  state?: "done" | "skipped";
  reason?: string;
};

export type AdvanceResult = { next: PlannedStep | null; completed: boolean };

/**
 * A-34: the step `fromKey` is finished; schedule the next one or complete the enrolment. A step
 * key that is not in the plan (a definition without it) completes the enrolment.
 */
export async function advance(tx: Tx, e: LockedEnrolment, fromKey: string, opts: AdvanceOptions): Promise<AdvanceResult> {
  let plan = opts.state === "skipped" ? markStep(e.plan, fromKey, "skipped", opts.reason) : e.plan;
  let next: PlannedStep | null = null;
  if (e.definition && plan.some((p) => p.key === fromKey)) {
    const r = nextStep(e.definition, plan, fromKey, opts.branch, opts.now);
    plan = r.plan;
    next = r.next;
  }
  await storePlan(tx, e.id, plan, next);
  e.plan = plan;
  e.nextStepKey = next?.key ?? null;
  e.nextStepAt = next ? new Date(next.due_at) : null;
  if (next) {
    await writeStepRun(tx, e, next.key, "scheduled", opts.actor, { data: { due_at: next.due_at } });
    return { next, completed: false };
  }
  await endEnrolmentWith(tx, e.id, "completed", "completed", opts.actor);
  e.status = "completed";
  return { next: null, completed: true };
}

/** Writes a step-time skip (or failure) and advances past the step. */
export async function skipStep(
  tx: Tx,
  e: LockedEnrolment,
  stepKey: string,
  outcome: AutomationRunOutcome,
  reason: string | null,
  opts: { actor: Actor; now: Date; data?: RunDataJson },
): Promise<AdvanceResult> {
  await writeStepRun(tx, e, stepKey, outcome, opts.actor, { reason, ...(opts.data ? { data: opts.data } : {}) });
  return advance(tx, e, stepKey, { actor: opts.actor, now: opts.now, state: "skipped", reason: outcome });
}

export const DEAD_REASON_MAX = 200;

/** `error.message`, first 200 characters, prefixed `permanent:` for a permanent failure (A-35). */
export function deadReason(error: { message: string; permanent: boolean }): string {
  return `${error.permanent ? "permanent:" : ""}${error.message}`.slice(0, DEAD_REASON_MAX);
}

export type DeadJobKind = "automation.step" | "automation.call_webhook";

/**
 * A-35: writes one `failed` run for a dead step job and advances a still-active enrolment whose
 * `next_step_key` is that step. For `automation.call_webhook` the enrolment advanced when the
 * step ran, so only the run is written (also after the enrolment completed). A missing
 * enrolment, an ended one (step jobs) or a run already written is a no-op; it never throws for those.
 */
export async function recordDeadStep(
  ctx: { tx: Tx; actor: Actor; now?: Date },
  input: { enrolmentId: string; stepKey: string },
  error: { message: string; permanent: boolean },
  kind: DeadJobKind = "automation.step",
): Promise<{ written: boolean; advanced: boolean }> {
  const tx = ctx.tx;
  if (!(await lockEnrolmentPerson(tx, input.enrolmentId))) return { written: false, advanced: false };
  const e = await lockEnrolment(tx, input.enrolmentId);
  if (!e) return { written: false, advanced: false };
  if (kind === "automation.step" && e.status !== "active") return { written: false, advanced: false };
  const dedupeKey = runDedupeKey(e.id, input.stepKey, "failed");
  const existing = rowsOf(await tx.execute(sql`select 1 from automation_runs where dedupe_key = ${dedupeKey} limit 1`));
  if (existing.length) return { written: false, advanced: false };
  await writeStepRun(tx, e, input.stepKey, "failed", ctx.actor, { reason: deadReason(error), data: { job_kind: kind } });
  if (kind !== "automation.step" || e.nextStepKey !== input.stepKey) return { written: true, advanced: false };
  await advance(tx, e, input.stepKey, { actor: ctx.actor, now: ctx.now ?? new Date(), state: "skipped", reason: "failed" });
  return { written: true, advanced: true };
}
