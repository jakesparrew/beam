/**
 * The run log (automation spec 2.6): one append-only `automation_runs` row per engine decision.
 * `writeRun` inserts `on conflict (dedupe_key) do nothing`, so a retried job or a re-read event
 * never writes a decision twice.
 *
 * Dedupe keys (`dedupe_key`):
 * - step outcomes: `run:<enrolment_id>:<step_key>:<outcome>`;
 * - enrolment-level outcomes (`entered`, `exited`, `completed`; no step): `run:<enrolment_id>:<outcome>`;
 * - entry skips and entry failures without an enrolment: `entry:<automation_id>:<event_id>`.
 */
import type { Tx } from "@beam/db";
import { automationRuns, type ActorJson, type RunDataJson } from "@beam/db/schema";
import type { AutomationRunOutcome } from "@beam/core/automation";
import { actorJson, type Actor } from "@/lib/ctx";

export type NewRun = {
  enrolmentId: string | null;
  personId: string;
  automationId: string;
  automationVersionId?: string | null;
  stepKey?: string | null;
  outcome: AutomationRunOutcome;
  reason?: string | null;
  data?: RunDataJson;
  emailMessageId?: string | null;
  taskId?: string | null;
  /** An `Actor` of the runtime or the stored `ActorJson`. */
  actor: Actor | ActorJson;
  dedupeKey?: string | null;
  occurredAt?: Date;
};

/** `run:<enrolment_id>:<step_key>:<outcome>`, or `run:<enrolment_id>:<outcome>` without a step. */
export function runDedupeKey(enrolmentId: string, stepKey: string | null, outcome: AutomationRunOutcome): string {
  return stepKey ? `run:${enrolmentId}:${stepKey}:${outcome}` : `run:${enrolmentId}:${outcome}`;
}

/** `entry:<automation_id>:<event_id>` for entry decisions that create no enrolment. */
export const entryDedupeKey = (automationId: string, eventId: bigint | number | string): string => `entry:${automationId}:${String(eventId)}`;

const isActorJson = (a: Actor | ActorJson): a is ActorJson => "id" in a && !("userId" in a) && !("jobId" in a);

/** The stored actor of a run: a job, a staff user or the system. */
export function runActor(actor: Actor | ActorJson): ActorJson {
  return isActorJson(actor) ? actor : actorJson(actor);
}

/** Inserts one run; a row whose `dedupe_key` exists already is skipped. */
export async function writeRun(tx: Tx, row: NewRun): Promise<void> {
  await tx
    .insert(automationRuns)
    .values({
      enrolmentId: row.enrolmentId,
      personId: row.personId,
      automationId: row.automationId,
      automationVersionId: row.automationVersionId ?? null,
      stepKey: row.stepKey ?? null,
      outcome: row.outcome,
      reason: row.reason ?? null,
      data: row.data ?? {},
      emailMessageId: row.emailMessageId ?? null,
      taskId: row.taskId ?? null,
      actor: runActor(row.actor),
      dedupeKey: row.dedupeKey ?? null,
      ...(row.occurredAt ? { occurredAt: row.occurredAt } : {}),
    })
    .onConflictDoNothing({ target: automationRuns.dedupeKey });
}
