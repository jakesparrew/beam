/**
 * Ending enrolments (A-21 to A-25). `endEnrolment` is the one way an enrolment ends: it locks
 * the row, sets `status`, `ended_at`, `end_reason`, clears `next_step_*`, marks pending plan
 * entries `not_taken` and writes exactly one `exited` or `completed` run. Pending
 * `automation.step` jobs find the enrolment ended and finish as no-ops.
 *
 * Event exits run in the order of A-9: built-in exits first, then `exit_on`, both under the
 * A-22 guard (an event never ends the enrolment it created or a later one).
 */
import type { Tx } from "@beam/db";
import { automationEnrolments, automations, automationVersions, suppressions, type RunDataJson } from "@beam/db/schema";
import {
  builtInExitReason,
  closePlan,
  exitGuard,
  matchesExit,
  parseDefinition,
  suppressionCovers,
  type AutomationPurpose,
  type Definition,
  type EventView,
} from "@beam/core/automation";
import { and, eq, sql, type Actor } from "@/lib/ctx";
import { findPersonIdsByEmailHash } from "@/modules/crm/api";
import { runDedupeKey, writeRun } from "./runs";

const definitionCache = new Map<string, Definition | null>();

/** The parsed definition of a published version (immutable, so cached per version id); null when invalid. */
export function versionDefinition(versionId: string, json: unknown): Definition | null {
  if (definitionCache.has(versionId)) return definitionCache.get(versionId)!;
  const parsed = parseDefinition(json);
  const def = parsed.ok ? parsed.value : null;
  definitionCache.set(versionId, def);
  return def;
}

/**
 * Ends one active enrolment. Returns false (and writes nothing) when the enrolment is missing
 * or already ended. `data` is stored on the end run (`superseded_by`, `event_id`).
 */
export async function endEnrolmentWith(
  tx: Tx,
  enrolmentId: string,
  outcome: "exited" | "completed",
  reason: string,
  actor: Actor,
  data: RunDataJson = {},
): Promise<boolean> {
  const [row] = await tx
    .select({
      id: automationEnrolments.id,
      status: automationEnrolments.status,
      plan: automationEnrolments.plan,
      personId: automationEnrolments.personId,
      automationId: automationEnrolments.automationId,
      versionId: automationEnrolments.automationVersionId,
    })
    .from(automationEnrolments)
    .where(eq(automationEnrolments.id, enrolmentId))
    .for("update");
  if (!row || row.status !== "active") return false;
  await tx
    .update(automationEnrolments)
    .set({
      status: outcome,
      endedAt: sql`now()`,
      endReason: reason,
      nextStepKey: null,
      nextStepAt: null,
      plan: closePlan(row.plan),
      updatedAt: sql`now()`,
    })
    .where(eq(automationEnrolments.id, enrolmentId));
  await writeRun(tx, {
    enrolmentId,
    personId: row.personId,
    automationId: row.automationId,
    automationVersionId: row.versionId,
    outcome,
    reason,
    data,
    actor,
    dedupeKey: runDedupeKey(enrolmentId, null, outcome),
  });
  return true;
}

/** A-25: ends an enrolment (`exited` with a reason, or `completed`). */
export function endEnrolment(tx: Tx, enrolmentId: string, outcome: "exited" | "completed", reason: string, actor: Actor): Promise<boolean> {
  return endEnrolmentWith(tx, enrolmentId, outcome, reason, actor);
}

/** One active enrolment of a person, with what the exit rules read. */
export type ActiveEnrolment = {
  id: string;
  automationId: string;
  versionId: string;
  subjectKey: string;
  triggerEventId: bigint | null;
  context: { trigger?: { data?: Record<string, unknown> } };
  isMarketing: boolean;
  purpose: AutomationPurpose | null;
  definition: Definition | null;
};

/** Every active enrolment of a person (any automation status: exits apply while paused too). */
export async function activeEnrolmentsOf(tx: Tx, personId: string): Promise<ActiveEnrolment[]> {
  const rows = await tx
    .select({
      id: automationEnrolments.id,
      automationId: automationEnrolments.automationId,
      versionId: automationEnrolments.automationVersionId,
      subjectKey: automationEnrolments.subjectKey,
      triggerEventId: automationEnrolments.triggerEventId,
      context: automationEnrolments.context,
      isMarketing: automations.isMarketing,
      purpose: automations.purpose,
      definition: automationVersions.definition,
    })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .innerJoin(automationVersions, eq(automationVersions.id, automationEnrolments.automationVersionId))
    .where(and(eq(automationEnrolments.personId, personId), eq(automationEnrolments.status, "active")))
    .orderBy(automationEnrolments.enteredAt, automationEnrolments.id);
  return rows.map((r) => ({ ...r, definition: versionDefinition(r.versionId, r.definition) }));
}

/**
 * A-9 steps 1 and 2 for one event: built-in exits (A-21), then `exit_on` matches (A-22) of the
 * person's active enrolments. Returns the number of enrolments ended.
 */
export async function applyEventExits(tx: Tx, ev: EventView, actor: Actor): Promise<number> {
  if (!ev.personId) return 0;
  const enrolments = (await activeEnrolmentsOf(tx, ev.personId)).filter((e) => exitGuard(e, ev));
  if (!enrolments.length) return 0;
  const ended = new Set<string>();
  const data: RunDataJson = { event_id: ev.id.toString() };

  // (1) Built-in exits. `person.merged` ends the loser's journeys only (crm writes the event for both).
  const isWinner = ev.kind === "person.merged" && ev.data.role === "winner";
  for (const e of enrolments) {
    if (isWinner) break;
    const reason = builtInExitReason(ev, { isMarketing: e.isMarketing, purpose: e.purpose });
    if (reason && (await endEnrolmentWith(tx, e.id, "exited", reason, actor, data))) ended.add(e.id);
  }
  // (2) exit_on of each enrolment's own version.
  for (const e of enrolments) {
    if (ended.has(e.id) || !e.definition) continue;
    const vars = { trigger: { data: e.context.trigger?.data ?? {} } };
    if (!matchesExit(e.definition.exit_on, ev, e.subjectKey, vars)) continue;
    if (await endEnrolmentWith(tx, e.id, "exited", `exit_event:${ev.kind}`, actor, data)) ended.add(e.id);
  }
  return ended.size;
}

export type PersonExitReason = "erased" | "merged" | "manual" | "restricted" | "objected";

/** Ends every active enrolment of a person (only marketing automations with `onlyMarketing`). */
export async function exitPersonEnrolments(
  tx: Tx,
  input: { personId: string; reason: PersonExitReason; onlyMarketing?: boolean; actor: Actor },
): Promise<{ exited: number }> {
  let exited = 0;
  for (const e of await activeEnrolmentsOf(tx, input.personId)) {
    if (input.onlyMarketing && !e.isMarketing) continue;
    if (await endEnrolment(tx, e.id, "exited", input.reason, input.actor)) exited++;
  }
  return { exited };
}

/**
 * A-23 (scenario 2): ends every active enrolment of a marketing automation whose purpose the
 * suppression scope covers, for every person with the suppressed address (merged rows included),
 * with `unsubscribed`. Transactional journeys keep running (A-24).
 */
export async function exitForSuppression(tx: Tx, suppressionId: string, actor: Actor): Promise<{ exited: number; persons: number }> {
  const [supp] = await tx
    .select({ emailHash: suppressions.emailHash, scope: suppressions.scope })
    .from(suppressions)
    .where(eq(suppressions.id, suppressionId));
  if (!supp) return { exited: 0, persons: 0 };
  const personIds = await findPersonIdsByEmailHash(tx, supp.emailHash);
  let exited = 0;
  for (const personId of personIds) {
    for (const e of await activeEnrolmentsOf(tx, personId)) {
      if (!e.isMarketing || !suppressionCovers(supp.scope, e.purpose)) continue;
      if (await endEnrolmentWith(tx, e.id, "exited", "unsubscribed", actor, { suppression_id: suppressionId })) exited++;
    }
  }
  return { exited, persons: personIds.length };
}
