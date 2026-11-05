/**
 * Pipeline jobs (crm spec 4.5), crm-P8. The kinds are declared in `apps/web/modules/crm/jobs.ts`
 * and scheduled in `schedules.ts`.
 *
 * - `crm.escalate_opportunities` (rule 3.48): an opportunity in one stage longer than the
 *   active playbook stage's `escalation.after_days` gets one task for the first user with role
 *   `escalation.notify_role` and one Slack line (dedupe
 *   `escalate:<opportunity_id>:<stage>:<stage_entered_at minute>`).
 * - `crm.apply_btoc_playbook` (rule 3.56): `ops.stage_changed` events of the last 30 minutes
 *   whose `data.to` has an active `b2c` playbook stage get one task for the stage's
 *   `owner_role` (dedupe `playbook:b2c:<person_id>:<to_stage>:<event_id>`) and the enrolment of
 *   the person when the stage has an `automation_slug`; a B2C playbook task open longer than
 *   its stage's `escalation.after_days` is escalated like rule 3.48 (dedupe
 *   `escalate:b2c:<task_id>`).
 *
 * Every task carries a dedupe key and a Slack line is sent only when its task (or, with
 * `create_task: false`, its once-guard) is new, so reruns and overlapping windows are harmless.
 */
import { z } from "zod";
import { activityEvents, opportunities, persons, playbookStages, tasks, type RoleKey } from "@beam/db/schema";
import type { Tx } from "@beam/db";
import { and, eq, gte, isNull, lt, notInArray, sql, ValidationError } from "@/lib/ctx";
import { claimOnce } from "@/lib/alerts";
import type { JobCtx } from "@/lib/job-runner";
import { enrolPersonBySlug } from "@/modules/automation/api";
import { notifySlack } from "@/modules/platform/api";
import { createTask, resolveTaskOwner } from "../tasks/api";
import { asRoleKey, btocTaskKey, escalationKey, titleFrom, userLocale, type PlaybookStageRecord } from "./api";

export const EscalateOpportunitiesInput = z.object({});
export const ApplyBtocPlaybookInput = z.object({});

const DAY_MS = 86_400_000;
/** Rule 3.56: the look-back window over the 5-minute cadence. */
export const BTOC_WINDOW_MS = 30 * 60_000;
/** How long a `create_task: false` escalation's once-guard lives. */
const ONCE_GUARD_MS = 400 * DAY_MS;

/** The first active user of `role` (else the owner role holder), or `null` when nobody qualifies. */
async function ownerFor(tx: Tx, role: RoleKey | undefined): Promise<string | null> {
  try {
    return await resolveTaskOwner(tx, role ? { ownerRole: role } : { ownerRole: "owner" });
  } catch (error) {
    if (error instanceof ValidationError) return null;
    throw error;
  }
}

const afterDays = (stage: PlaybookStageRecord): number | null => {
  const n = stage.escalation.after_days;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * One escalation: a task for the first active user of `notify_role` (else the fallback owner)
 * unless `create_task` is false, and one Slack line when that task (or the once-guard) is new.
 */
async function escalate(
  ctx: JobCtx,
  stage: PlaybookStageRecord,
  input: { key: string; title: string; fallbackOwnerUserId?: string; personId?: string; companyId?: string; opportunityId?: string; ref: { type: string; id: string }; slackText: string; fingerprint: string },
): Promise<boolean> {
  const role = asRoleKey(stage.escalation.notify_role);
  let fresh: boolean;
  if (stage.escalation.create_task === false) {
    fresh = await claimOnce(ctx.tx, input.key, new Date(ctx.now.getTime() + ONCE_GUARD_MS));
  } else {
    const ownerUserId = (role ? await ownerFor(ctx.tx, role) : null) ?? input.fallbackOwnerUserId;
    if (!ownerUserId) return false;
    const task = await createTask(ctx.tx, ctx, {
      title: input.title,
      kind: "follow_up",
      priority: "high",
      ...(ownerUserId ? { ownerUserId } : {}),
      dueAt: ctx.now,
      ...(input.personId ? { personId: input.personId } : {}),
      ...(input.companyId ? { companyId: input.companyId } : {}),
      ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
      source: "system",
      ref: input.ref,
      dedupeKey: input.key,
    });
    fresh = task.created;
  }
  if (fresh) await notifySlack(ctx, { fingerprint: input.fingerprint, severity: "normal", text: input.slackText });
  return fresh;
}

async function escalationTitle(tx: Tx, stage: PlaybookStageRecord, userId: string, prefix: Record<string, string>): Promise<string> {
  const locale = await userLocale(tx, userId);
  return `${prefix[locale] ?? prefix.en}: ${titleFrom(stage.name, locale)}`.slice(0, 200);
}

const ESCALATED: Record<string, string> = { "nl-BE": "Escalatie", "fr-BE": "Escalade", en: "Escalation" };

/** `crm.escalate_opportunities` (rule 3.48). */
export async function runEscalateOpportunities(ctx: JobCtx, _input: z.infer<typeof EscalateOpportunitiesInput>): Promise<{ escalated: number }> {
  const rows = await ctx.tx
    .select({ o: opportunities, s: playbookStages })
    .from(opportunities)
    .innerJoin(playbookStages, and(eq(playbookStages.pipeline, "b2b"), eq(playbookStages.stageKey, sql`${opportunities.stage}::text`), eq(playbookStages.isActive, true)))
    .where(and(notInArray(opportunities.stage, ["won", "lost"]), sql`${playbookStages.escalation} ? 'after_days'`))
    .orderBy(opportunities.id);
  let escalated = 0;
  for (const { o, s } of rows) {
    const days = afterDays(s);
    if (days === null || ctx.now.getTime() <= o.stageEnteredAt.getTime() + days * DAY_MS) continue;
    const role = asRoleKey(s.escalation.notify_role);
    const titleUser = (role ? await ownerFor(ctx.tx, role) : null) ?? o.ownerUserId;
    const done = await escalate(ctx, s, {
      key: escalationKey(o.id, o.stage, o.stageEnteredAt),
      title: await escalationTitle(ctx.tx, s, titleUser, ESCALATED),
      fallbackOwnerUserId: o.ownerUserId,
      companyId: o.companyId,
      opportunityId: o.id,
      ref: { type: "opportunity", id: o.id },
      fingerprint: `opportunity:${o.id}:${o.stage}:escalated`,
      slackText: `Opportunity ${o.id} has been in stage ${o.stage} for more than ${days} days.`,
    });
    if (done) escalated++;
  }
  return { escalated };
}

/** `crm.apply_btoc_playbook` (rule 3.56). */
export async function runApplyBtocPlaybook(ctx: JobCtx, _input: z.infer<typeof ApplyBtocPlaybookInput>): Promise<{ created: number; enrolled: number; escalated: number }> {
  const since = new Date(ctx.now.getTime() - BTOC_WINDOW_MS);
  const events = await ctx.tx
    .select({ id: activityEvents.id, personId: activityEvents.personId, occurredAt: activityEvents.occurredAt, to: sql<string>`${activityEvents.data}->>'to'` })
    .from(activityEvents)
    .innerJoin(persons, eq(persons.id, activityEvents.personId))
    .where(and(eq(activityEvents.kind, "ops.stage_changed"), gte(activityEvents.occurredAt, since), isNull(persons.erasedAt), isNull(persons.mergedIntoPersonId)))
    .orderBy(activityEvents.occurredAt, activityEvents.id);
  const stages = new Map(
    (await ctx.tx.select().from(playbookStages).where(and(eq(playbookStages.pipeline, "b2c"), eq(playbookStages.isActive, true)))).map((s) => [s.stageKey, s] as const),
  );

  let created = 0;
  let enrolled = 0;
  for (const e of events) {
    const stage = stages.get(e.to);
    if (!stage || !e.personId) continue;
    // No staff user for the role (nor an owner): skip; the event stays in the window for the next run.
    const ownerUserId = await ownerFor(ctx.tx, asRoleKey(stage.ownerRole));
    if (!ownerUserId) continue;
    const locale = await userLocale(ctx.tx, ownerUserId);
    const task = await createTask(ctx.tx, ctx, {
      title: titleFrom(stage.requiredAction, locale),
      kind: "follow_up",
      ownerUserId,
      dueAt: new Date(e.occurredAt.getTime() + stage.deadlineDays * DAY_MS),
      personId: e.personId,
      source: "system",
      ref: { type: "playbook_stage", id: stage.id },
      dedupeKey: btocTaskKey(e.personId, stage.stageKey, String(e.id)),
    });
    if (!task.created) continue;
    created++;
    const slug = stage.automatedCommunication.automation_slug?.trim();
    if (slug) {
      const result = await enrolPersonBySlug(ctx.tx, { slug, personId: e.personId });
      if (result.status === "enrolled") enrolled++;
    }
  }
  return { created, enrolled, escalated: await escalateBtocTasks(ctx, stages) };
}

/** B2C playbook tasks still open longer than their stage's `escalation.after_days`. */
async function escalateBtocTasks(ctx: JobCtx, stages: ReadonlyMap<string, PlaybookStageRecord>): Promise<number> {
  const open = await ctx.tx
    .select({ id: tasks.id, personId: tasks.personId, ownerUserId: tasks.ownerUserId, dedupeKey: tasks.dedupeKey, createdAt: tasks.createdAt })
    .from(tasks)
    .where(and(eq(tasks.status, "open"), sql`${tasks.dedupeKey} like 'playbook:b2c:%'`, lt(tasks.createdAt, ctx.now)))
    .orderBy(tasks.createdAt, tasks.id);
  let escalated = 0;
  for (const t of open) {
    const stageKey = t.dedupeKey?.split(":")[3];
    const stage = stageKey ? stages.get(stageKey) : undefined;
    const days = stage ? afterDays(stage) : null;
    if (!stage || days === null || ctx.now.getTime() <= t.createdAt.getTime() + days * DAY_MS) continue;
    const role = asRoleKey(stage.escalation.notify_role);
    const titleUser = (role ? await ownerFor(ctx.tx, role) : null) ?? t.ownerUserId;
    const done = await escalate(ctx, stage, {
      key: `escalate:b2c:${t.id}`,
      title: await escalationTitle(ctx.tx, stage, titleUser, ESCALATED),
      fallbackOwnerUserId: t.ownerUserId,
      ...(t.personId ? { personId: t.personId } : {}),
      ref: { type: "task", id: t.id },
      fingerprint: `playbook:b2c:${t.id}:escalated`,
      slackText: `A B2C playbook task for stage ${stage.stageKey} has been open for more than ${days} days.`,
    });
    if (done) escalated++;
  }
  return escalated;
}
