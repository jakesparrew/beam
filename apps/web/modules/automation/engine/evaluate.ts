/**
 * The evaluator (`automation.evaluate`, A-5a, A-7 to A-10, A-11a, A-20, A-46).
 *
 * One run is one transaction: it locks the cursor (`FOR UPDATE SKIP LOCKED`; a second evaluator
 * returns at once), re-reads the live gap ids, then reads new `activity_events` in id order in
 * pages of 250, at most 1,000 events and 30 seconds per run. Each event runs in a savepoint:
 * (1) built-in exits, (2) `exit_on`, (3) trigger matches of active automations in group
 * priority, automation priority, slug order (A-9), each trigger in its own nested savepoint so
 * a throwing definition rolls back alone and writes a `failed` run (A-46). Then the cursor is
 * written, due steps are enqueued (A-20, at most 500, oldest first) and, when events remain, a
 * continuation `automation.evaluate` keyed `automation_evaluate:<last_event_id>`.
 *
 * Decisions:
 * - An `isDpiaApproved` call that throws (the ops implementation missing or failing) neither
 *   pauses nor triggers the gated automations in that run; only a `false` answer pauses them.
 * - A due step is enqueued through the job registry once `automation.step` is registered there
 *   (automation-P3); before that the row is inserted directly with the definition's lane and
 *   priority (fast, 2 transactional / 5 marketing) so no due step is lost.
 * - A-46 for an event whose exit phase throws: the event savepoint rolls back, the error is
 *   reported and the cursor moves on (no automation is being matched, so no run is written).
 */
import { enqueue as dbEnqueue, type Tx } from "@beam/db";
import { activityEvents, automationEnrolments, automations } from "@beam/db/schema";
import { compareTriggerOrder, eventEligibility, isSegmentTrigger, matchesTrigger, type EventView } from "@beam/core/automation";
import type { DpiaKey } from "@beam/core/ops";
import { and, asc, createCtx, eq, gt, inArray, loadJobRegistry, lte, sql, type Ctx, type JobKind } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { reportError } from "@/lib/logger";
import { isDpiaApproved } from "@/modules/ops/api";
import { notifySlack } from "@/modules/platform/api";
import { CursorState, lockCursor, saveCursor } from "./cursor";
import { enrol, loadAutomations, type EngineAutomation } from "./enrol";
import { applyEventExits } from "./exits";
import { entryDedupeKey, writeRun } from "./runs";

export const MAX_EVENTS_PER_RUN = 1_000;
export const EVENT_PAGE_SIZE = 250;
export const RUN_BUDGET_MS = 30_000;
export const MAX_DUE_PER_RUN = 500;
export const STEP_JOB_KIND = "automation.step";

export type EvaluateResult = {
  processed: number;
  enrolled: number;
  exited: number;
  dueEnqueued: number;
  /** Another evaluator held the cursor; nothing was done. */
  locked: boolean;
  /** A continuation was enqueued (events remain). */
  continued: boolean;
  lastEventId: string;
};

export type EvaluateOptions = {
  /** The job context (actor, enqueue, audit); a system context on `tx` otherwise. */
  ctx?: Ctx;
  maxEvents?: number;
  pageSize?: number;
};

type EventRow = {
  id: bigint;
  personId: string | null;
  kind: string;
  occurredAt: Date;
  mode: string | null;
  isSensitive: boolean;
  refType: string | null;
  refId: string | null;
  data: unknown;
};

const eventColumns = {
  id: activityEvents.id,
  personId: activityEvents.personId,
  kind: activityEvents.kind,
  occurredAt: activityEvents.occurredAt,
  mode: activityEvents.mode,
  isSensitive: activityEvents.isSensitive,
  refType: activityEvents.refType,
  refId: activityEvents.refId,
  data: activityEvents.data,
};

const toView = (r: EventRow): EventView => ({
  id: r.id,
  kind: r.kind,
  personId: r.personId,
  occurredAt: r.occurredAt,
  mode: r.mode,
  refType: r.refType,
  refId: r.refId,
  isSensitive: r.isSensitive,
  data: r.data && typeof r.data === "object" && !Array.isArray(r.data) ? (r.data as Record<string, unknown>) : {},
});

/** A-5a: pauses active automations whose DPIA decision is no longer approved; returns the ones that may trigger. */
async function applyDpiaGate(tx: Tx, ctx: Ctx, list: EngineAutomation[]): Promise<EngineAutomation[]> {
  const keys = [...new Set(list.map((a) => a.requiresDpia).filter((k): k is string => !!k))];
  const blocked = new Set<string>();
  for (const key of keys) {
    let approved: boolean | null;
    try {
      approved = await isDpiaApproved(tx, key as DpiaKey);
    } catch (error) {
      reportError(error, { tags: { area: "automation.evaluate", dpia: key } });
      approved = null;
    }
    if (approved === true) continue;
    blocked.add(key);
    if (approved === null) continue;
    const gated = list.filter((a) => a.requiresDpia === key);
    for (const a of gated) {
      const paused = await tx
        .update(automations)
        .set({ status: "paused", pausedAt: ctx.now, updatedAt: sql`now()` })
        .where(and(eq(automations.id, a.id), eq(automations.status, "active")))
        .returning({ id: automations.id });
      if (!paused.length) continue;
      await ctx.audit({
        action: "automation.pause",
        entityType: "automation",
        entityId: a.id,
        oldValue: { status: "active" },
        newValue: { status: "paused", reason: `dpia_not_approved:${key}` },
      });
    }
    await notifySlack(ctx, {
      fingerprint: `automation-dpia:${key}`,
      severity: "normal",
      text: `Automations paused: the DPIA decision ${key} is no longer approved (${gated.map((a) => a.slug).join(", ")}).`,
    });
  }
  return list.filter((a) => !a.requiresDpia || !blocked.has(a.requiresDpia));
}

/** A-11a: automations whose `requires_flag` is off enrol nobody (no run row). */
async function applyFlagGate(ctx: Ctx, list: EngineAutomation[]): Promise<EngineAutomation[]> {
  const keys = [...new Set(list.map((a) => a.requiresFlag).filter((k): k is string => !!k))];
  const on = new Map<string, boolean>();
  for (const key of keys) on.set(key, await flag(key as Parameters<typeof flag>[0], ctx.actor));
  return list.filter((a) => !a.requiresFlag || on.get(a.requiresFlag) === true);
}

/** A-20: enqueues `automation.step` for due enrolments of active automations (oldest first). */
export async function enqueueDueSteps(tx: Tx, ctx: Ctx, now: Date, limit = MAX_DUE_PER_RUN): Promise<number> {
  const due = await tx
    .select({ id: automationEnrolments.id, stepKey: automationEnrolments.nextStepKey, isMarketing: automations.isMarketing })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .where(and(eq(automationEnrolments.status, "active"), eq(automations.status, "active"), lte(automationEnrolments.nextStepAt, now)))
    .orderBy(asc(automationEnrolments.nextStepAt), asc(automationEnrolments.id))
    .limit(limit);
  if (!due.length) return 0;
  const registered = !!(await loadJobRegistry())[STEP_JOB_KIND];
  let count = 0;
  for (const d of due) {
    if (!d.stepKey) continue;
    const job = {
      kind: STEP_JOB_KIND as JobKind,
      payload: { enrolmentId: d.id, stepKey: d.stepKey },
      key: `automation:${d.id}:${d.stepKey}`,
      lane: "fast" as const,
      priority: d.isMarketing ? 5 : 2,
    };
    const res = registered ? await ctx.enqueue(job) : await dbEnqueue(tx, { ...job, maxAttempts: 6, requestId: ctx.requestId });
    if (res.inserted) count++;
  }
  return count;
}

/** One evaluator pass; see the file header. */
export async function evaluateBatch(tx: Tx, now: Date, opts: EvaluateOptions = {}): Promise<EvaluateResult> {
  const ctx = opts.ctx ?? createCtx({ tx, actor: { kind: "system", jobId: "" }, now });
  const maxEvents = opts.maxEvents ?? MAX_EVENTS_PER_RUN;
  const pageSize = opts.pageSize ?? EVENT_PAGE_SIZE;
  const result: EvaluateResult = { processed: 0, enrolled: 0, exited: 0, dueEnqueued: 0, locked: false, continued: false, lastEventId: "0" };

  const stored = await lockCursor(tx);
  if (!stored) return { ...result, locked: true };
  const cursor = new CursorState(stored, now);

  const active = await loadAutomations(tx, { statuses: ["active"] });
  const gated = await applyFlagGate(ctx, await applyDpiaGate(tx, ctx, active));
  const candidates = gated
    .filter((a) => a.definition)
    .sort((x, y) => compareTriggerOrder({ groupPriority: x.groupPriority, automationPriority: x.priority, slug: x.slug }, { groupPriority: y.groupPriority, automationPriority: y.priority, slug: y.slug }));

  const started = Date.now();
  const processEvent = async (row: EventRow) => {
    result.processed++;
    const ev = toView(row);
    const eligibility = eventEligibility(ev, now);
    if (!eligibility.exit || !ev.personId) return;
    const personId = ev.personId;
    try {
      await tx.transaction(async (sp) => {
        result.exited += await applyEventExits(sp, ev, ctx.actor);
        if (!eligibility.trigger) return;
        for (const a of candidates) {
          if (!matchesTrigger(a.definition!.trigger, ev)) continue;
          try {
            const r = await sp.transaction((inner) =>
              enrol(inner, { automation: a, personId, source: isSegmentTrigger(a.definition!.trigger) ? "segment" : "trigger", actor: ctx.actor, now, event: ev }),
            );
            if (r.status === "enrolled") result.enrolled++;
          } catch (error) {
            reportError(error, { tags: { area: "automation.evaluate", automation: a.slug } });
            const message = error instanceof Error ? error.message : String(error);
            await writeRun(sp, {
              enrolmentId: null,
              personId,
              automationId: a.id,
              automationVersionId: a.versionId,
              outcome: "failed",
              reason: `evaluate:${message}`.slice(0, 500),
              data: { event_id: ev.id.toString() },
              actor: ctx.actor,
              dedupeKey: entryDedupeKey(a.id, ev.id),
            });
          }
        }
      });
    } catch (error) {
      reportError(error, { tags: { area: "automation.evaluate", event: ev.id.toString() } });
    }
  };

  const gaps = cursor.liveGaps();
  if (gaps.length) {
    const rows = await tx
      .select(eventColumns)
      .from(activityEvents)
      .where(inArray(activityEvents.id, gaps))
      .orderBy(asc(activityEvents.id));
    for (const row of rows) {
      await processEvent(row);
      cursor.gapSeen(row.id);
    }
  }

  let more = false;
  for (;;) {
    const budget = maxEvents - result.processed;
    if (budget <= 0 || Date.now() - started > RUN_BUDGET_MS) {
      more = true;
      break;
    }
    const limit = Math.min(pageSize, budget);
    const page = await tx
      .select(eventColumns)
      .from(activityEvents)
      .where(gt(activityEvents.id, cursor.last))
      .orderBy(asc(activityEvents.id))
      .limit(limit);
    for (const row of page) {
      await processEvent(row);
      cursor.processed(row.id);
    }
    if (page.length < limit) break;
  }
  if (more) {
    const [next] = await tx.select({ id: activityEvents.id }).from(activityEvents).where(gt(activityEvents.id, cursor.last)).limit(1);
    more = !!next;
  }

  await saveCursor(tx, cursor.value());
  result.lastEventId = cursor.last.toString();
  result.dueEnqueued = await enqueueDueSteps(tx, ctx, now);
  if (more) {
    await ctx.enqueue({ kind: "automation.evaluate", payload: { continuation: true }, key: `automation_evaluate:${result.lastEventId}`, lane: "fast" });
    result.continued = true;
  }
  return result;
}
