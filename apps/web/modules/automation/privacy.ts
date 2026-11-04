/**
 * automation's GDPR registration (automation spec section 9, ops rule 62). Facade read by
 * `pnpm gen:indexes`. ops seeds the two retention policies (`automation.automation_runs`, 730
 * days; `automation.automation_enrolments`, ended enrolments after 1,095 days) and its
 * `privacy.retention_sweep` calls the `sweep` handlers below.
 *
 * `erase` first ends the active journeys with `erased` (the count is in the report), then
 * deletes the runs and the enrolments under `SET LOCAL beam.allow_rewrite = 'on'` (runs first,
 * FK order). `email_messages.enrolment_id` has no FK, so email deletes or nulls it later.
 *
 * Both run over `crm.resolvePersonIds(personId)` (crm rule 32): a merge leaves enrolments and
 * runs on the loser, and a loser's enrolment left behind would block crm's `activity_events`
 * delete through `trigger_event_id` (ON DELETE RESTRICT).
 */
import type { Tx } from "@beam/db";
import { automationEnrolments, automationRuns, automations, automationVersions } from "@beam/db/schema";
import type { EraseReportRow, PrivacyRegistration } from "@beam/core/privacy";
import { asc, eq, inArray, sql, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { resolvePersonIds } from "@/modules/crm/api";
import { exitPersonEnrolments } from "./engine/exits";

export const RETENTION_KEYS = ["automation.automation_runs", "automation.automation_enrolments"] as const;
export type AutomationRetentionKey = (typeof RETENTION_KEYS)[number];

const affected = async (tx: DbOrTx, q: ReturnType<typeof sql>) => rowsOf(await tx.execute(q)).length;
const allowRewrite = (tx: DbOrTx) => tx.execute(sql`set local beam.allow_rewrite = 'on'`);

/**
 * Retention purge (spec 9): runs older than `cutoff`, or ended enrolments whose `ended_at` is
 * older than `cutoff` (their runs first). Active enrolments are never purged.
 */
export async function purgeAutomationHistory(tx: Tx, key: AutomationRetentionKey, cutoff: Date): Promise<number> {
  await allowRewrite(tx);
  if (key === "automation.automation_runs") {
    return affected(tx, sql`delete from automation_runs where occurred_at < ${cutoff} returning id`);
  }
  const old = sql`select id from automation_enrolments where status <> 'active' and ended_at < ${cutoff}`;
  await tx.execute(sql`delete from automation_runs where enrolment_id in (${old})`);
  await tx.execute(sql`update automation_enrolments set migrated_from_enrolment_id = null where migrated_from_enrolment_id in (${old})`);
  return affected(tx, sql`delete from automation_enrolments where status <> 'active' and ended_at < ${cutoff} returning id`);
}

export const sweep: Record<AutomationRetentionKey, (tx: Tx, cutoff: Date) => Promise<number>> = {
  "automation.automation_runs": (tx, cutoff) => purgeAutomationHistory(tx, "automation.automation_runs", cutoff),
  "automation.automation_enrolments": (tx, cutoff) => purgeAutomationHistory(tx, "automation.automation_enrolments", cutoff),
};

/** The person and every person merged into it (crm rule 32). */
async function personIds(tx: Tx, personId: string): Promise<string[]> {
  return [...new Set([personId, ...(await resolvePersonIds(tx, personId))])];
}

/** Articles 15 and 20: every enrolment and every run of the person and of its merged losers. */
async function exportPerson(tx: Tx, personId: string): Promise<{ enrolments: unknown[]; runs: unknown[] }> {
  const ids = await personIds(tx, personId);
  const enrolments = await tx
    .select({
      id: automationEnrolments.id,
      automationSlug: automations.slug,
      automationName: automations.name,
      version: automationVersions.version,
      status: automationEnrolments.status,
      source: automationEnrolments.source,
      subjectKey: automationEnrolments.subjectKey,
      enteredAt: automationEnrolments.enteredAt,
      endedAt: automationEnrolments.endedAt,
      endReason: automationEnrolments.endReason,
      anchorAt: automationEnrolments.anchorAt,
      nextStepKey: automationEnrolments.nextStepKey,
      nextStepAt: automationEnrolments.nextStepAt,
      plan: automationEnrolments.plan,
      context: automationEnrolments.context,
    })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .innerJoin(automationVersions, eq(automationVersions.id, automationEnrolments.automationVersionId))
    .where(inArray(automationEnrolments.personId, ids))
    .orderBy(asc(automationEnrolments.enteredAt), asc(automationEnrolments.id));
  const runs = await tx
    .select({
      id: automationRuns.id,
      occurredAt: automationRuns.occurredAt,
      automationSlug: automations.slug,
      enrolmentId: automationRuns.enrolmentId,
      stepKey: automationRuns.stepKey,
      outcome: automationRuns.outcome,
      reason: automationRuns.reason,
      emailMessageId: automationRuns.emailMessageId,
      taskId: automationRuns.taskId,
    })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(inArray(automationRuns.personId, ids))
    .orderBy(asc(automationRuns.occurredAt), asc(automationRuns.id));
  return { enrolments, runs };
}

async function erasePerson(tx: Tx, personId: string): Promise<EraseReportRow[]> {
  const ids = await personIds(tx, personId);
  let exited = 0;
  for (const id of ids) exited += (await exitPersonEnrolments(tx, { personId: id, reason: "erased", actor: { kind: "system", jobId: "" } })).exited;
  const inIds = sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
  await allowRewrite(tx);
  const runs = await affected(tx, sql`delete from automation_runs where person_id in ${inIds} returning id`);
  await tx.execute(sql`update automation_enrolments set migrated_from_enrolment_id = null where migrated_from_enrolment_id in (select id from automation_enrolments where person_id in ${inIds})`);
  const enrolments = await affected(tx, sql`delete from automation_enrolments where person_id in ${inIds} returning id`);
  return [
    { table: "automation_enrolments", rows: exited, action: "exited" },
    { table: "automation_runs", rows: runs, action: "deleted" },
    { table: "automation_enrolments", rows: enrolments, action: "deleted" },
  ];
}

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["automation_enrolments", "automation_runs"],
  export: exportPerson,
  erase: erasePerson,
  sweep,
};

/** The spec's name for the registration (section 9). */
export const automationPrivacy = privacy;

/** Configuration tables: staff user ids only, no personal data (section 9). */
export const noPiiTables = ["automation_groups", "automations", "automation_versions"];
