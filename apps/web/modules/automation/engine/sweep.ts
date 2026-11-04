/**
 * `automation.sweep_enrolments` (every 15 minutes; A-35, A-45):
 * 1. completes active enrolments with no next step and no pending plan entry;
 * 2. fallback of the `onDead` hook (platform edge case 32): dead `automation.step` and
 *    `automation.call_webhook` jobs of the last 7 days whose step has no `failed` run go through
 *    `recordDeadStep` (its dedupe key makes the hook and the sweep write one row);
 * 3. raises the health alerts of A-45 (`health.ts`).
 * Reads platform's `jobs` rows (section 2.9); writes only this module's tables and Slack jobs.
 */
import type { Tx } from "@beam/db";
import { sql, type Ctx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { recordDeadStep, type DeadJobKind } from "./advance";
import { endEnrolmentWith } from "./exits";
import { raiseHealthAlerts } from "./health";

export const DEAD_LOOKBACK_DAYS = 7;
const MAX_DEAD_PER_RUN = 500;
const MAX_COMPLETE_PER_RUN = 500;

export type SweepResult = { completed: number; deadRecorded: number; alerts: string[] };

/** Active enrolments with nothing left to run (a lost advance): completed. */
async function completeFinished(tx: Tx, ctx: Ctx): Promise<number> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`select id::text as id from automation_enrolments
      where status = 'active' and next_step_key is null
        and not exists (select 1 from jsonb_array_elements(plan) p where p->>'state' = 'pending' and p->>'type' <> 'wait')
      order by id limit ${MAX_COMPLETE_PER_RUN}`),
  );
  let n = 0;
  for (const r of rows) if (await endEnrolmentWith(tx, r.id, "completed", "completed", ctx.actor, { by: "sweep" })) n++;
  return n;
}

/** Dead step and webhook jobs of the last 7 days without a `failed` run. */
async function recordDeadJobs(tx: Tx, ctx: Ctx, now: Date): Promise<number> {
  const rows = rowsOf<{ kind: DeadJobKind; enrolment_id: string; step_key: string; last_error: string | null }>(
    await tx.execute(sql`select j.kind, j.payload->>'enrolmentId' as enrolment_id, j.payload->>'stepKey' as step_key, j.last_error
      from jobs j
      where j.kind in ('automation.step', 'automation.call_webhook') and j.status = 'dead'
        and coalesce(j.finished_at, j.updated_at) > ${now.toISOString()}::timestamptz - make_interval(days => ${DEAD_LOOKBACK_DAYS})
        and j.payload->>'enrolmentId' ~ '^[0-9a-f-]{36}$' and j.payload->>'stepKey' is not null
        and not exists (select 1 from automation_runs r
          where r.dedupe_key = 'run:' || (j.payload->>'enrolmentId') || ':' || (j.payload->>'stepKey') || ':failed')
      order by coalesce(j.finished_at, j.updated_at) limit ${MAX_DEAD_PER_RUN}`),
  );
  let n = 0;
  for (const r of rows) {
    const message = r.last_error ?? "dead job";
    const permanent = /PermanentError|IntegrationError|permanent/i.test(message);
    const res = await tx.transaction((sp) =>
      recordDeadStep({ tx: sp, actor: ctx.actor, now }, { enrolmentId: r.enrolment_id, stepKey: r.step_key }, { message, permanent }, r.kind),
    );
    if (res.written) n++;
  }
  return n;
}

export async function sweepEnrolments(tx: Tx, ctx: Ctx, now: Date): Promise<SweepResult> {
  const completed = await completeFinished(tx, ctx);
  const deadRecorded = await recordDeadJobs(tx, ctx, now);
  const { alerts } = await raiseHealthAlerts(ctx, now);
  return { completed, deadRecorded, alerts };
}
