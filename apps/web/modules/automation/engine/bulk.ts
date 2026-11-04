/**
 * The bulk jobs (section 4.4): 500 enrolments (or segment members) per job in id order, each
 * enqueueing its continuation with `after` = the last id it handled.
 *
 * - `resumeEnrolments` (A-29): after a resume, a due time-sensitive step more than 24 hours
 *   before the resume time is `skipped_paused` and the enrolment advances; every other due step
 *   is enqueued with the `:resume:` key (A-26a). Steps due later run through the evaluator.
 * - `migrateEnrolments` (A-40): each active enrolment of an older version exits `migrated` and
 *   a new enrolment of the target version enters with the same anchor, subject, context and
 *   `entered_at`; steps already executed are `done` without a run, other steps due before now
 *   are `skipped_late_entry` (reason `migrated`). Exclusivity is not re-judged.
 * - `endEnrolments` (A-5): archiving ends every active enrolment with `archived`.
 * - `enrolSegment`: enrols `segment_members` in person-id order, source `segment`, all entry rules.
 */
import { randomUUID } from "node:crypto";
import type { Tx } from "@beam/db";
import { automationEnrolments, automations, automationVersions, segmentMembers } from "@beam/db/schema";
import { OVERDUE_LIMIT_MS, planSteps, startPlan, TIME_SENSITIVE_STEP_TYPES, utcMinuteBucket, type PlannedStep } from "@beam/core/automation";
import { and, asc, eq, gt, lte, ne, type Ctx, type JobKind } from "@/lib/ctx";
import { lockEnrolment, lockEnrolmentPerson, skipStep } from "./advance";
import { enrol, loadAutomations } from "./enrol";
import { endEnrolment, endEnrolmentWith, versionDefinition } from "./exits";
import { runDedupeKey, writeRun } from "./runs";
import { stepJobKey, stepJobPriority } from "./step";

export const BULK_CHUNK = 500;

/** `chunk` overrides the 500 rows per job (tests). */
export type BulkOptions = { chunk?: number };

export type BulkResult = { handled: number; continued: boolean; after: string | null };

const startOrAfter = (after: string | undefined) => after ?? "start";

/** Enqueues the continuation of a bulk job when the chunk was full. */
async function continueWith(ctx: Ctx, kind: JobKind, payload: Record<string, unknown>, key: string, full: boolean): Promise<boolean> {
  if (!full) return false;
  await ctx.enqueue({ kind, payload, key, lane: "bulk" });
  return true;
}

// ---------------------------------------------------------------------------
// automation.resume_enrolments (A-29)
// ---------------------------------------------------------------------------

export type ResumeInput = { automationId: string; resumedAt: string; after?: string };

export const resumeJobKey = (i: ResumeInput): string =>
  `automation_resume:${i.automationId}:${utcMinuteBucket(new Date(i.resumedAt))}:${startOrAfter(i.after)}`;

export async function resumeEnrolments(tx: Tx, ctx: Ctx, input: ResumeInput, opts: BulkOptions = {}): Promise<BulkResult & { skipped: number; enqueued: number }> {
  const resumedAt = new Date(input.resumedAt);
  const [a] = await tx.select({ status: automations.status, isMarketing: automations.isMarketing }).from(automations).where(eq(automations.id, input.automationId));
  if (!a || a.status !== "active") return { handled: 0, continued: false, after: null, skipped: 0, enqueued: 0 };
  const rows = await tx
    .select({ id: automationEnrolments.id })
    .from(automationEnrolments)
    .where(
      and(
        eq(automationEnrolments.automationId, input.automationId),
        eq(automationEnrolments.status, "active"),
        lte(automationEnrolments.nextStepAt, resumedAt),
        input.after ? gt(automationEnrolments.id, input.after) : undefined,
      ),
    )
    .orderBy(asc(automationEnrolments.id))
    .limit(opts.chunk ?? BULK_CHUNK);
  let skipped = 0;
  let enqueued = 0;
  for (const { id } of rows) {
    const e = await lockEnrolment(tx, id);
    if (!e || e.status !== "active" || !e.nextStepKey || !e.nextStepAt) continue;
    const type = e.plan.find((p) => p.key === e.nextStepKey)?.type;
    const late = resumedAt.getTime() - e.nextStepAt.getTime() > OVERDUE_LIMIT_MS;
    if (type && late && TIME_SENSITIVE_STEP_TYPES.includes(type)) {
      await skipStep(tx, e, e.nextStepKey, "skipped_paused", `due ${e.nextStepAt.toISOString()} before resume`, {
        actor: ctx.actor,
        now: ctx.now,
        data: { due_at: e.nextStepAt.toISOString() },
      });
      skipped++;
      continue;
    }
    const res = await ctx.enqueue({
      kind: "automation.step",
      payload: { enrolmentId: e.id, stepKey: e.nextStepKey },
      key: stepJobKey(e.id, e.nextStepKey, { kind: "resume", at: resumedAt }),
      lane: "fast",
      priority: stepJobPriority(a.isMarketing),
    });
    if (res.inserted) enqueued++;
  }
  const after = rows.at(-1)?.id ?? null;
  const next = { ...input, after: after ?? undefined };
  const continued = await continueWith(ctx, "automation.resume_enrolments", next, resumeJobKey(next), rows.length === (opts.chunk ?? BULK_CHUNK));
  return { handled: rows.length, continued, after, skipped, enqueued };
}

// ---------------------------------------------------------------------------
// automation.migrate_enrolments (A-40)
// ---------------------------------------------------------------------------

export type MigrateInput = { automationId: string; toVersionId: string; after?: string };

export const migrateJobKey = (i: MigrateInput): string => `automation_migrate:${i.toVersionId}:${startOrAfter(i.after)}`;

/** The plan of the migrated enrolment: executed keys `done`, past steps `skipped` (`migrated`). */
export function migratedPlan(fresh: PlannedStep[], old: PlannedStep[], now: Date): PlannedStep[] {
  const done = new Set(old.filter((p) => p.state === "done").map((p) => p.key));
  return fresh.map((p) => {
    if (done.has(p.key)) return { ...p, state: "done" as const };
    if (p.state === "pending" && new Date(p.due_at).getTime() < now.getTime()) return { ...p, state: "skipped" as const, reason: "migrated" };
    return p;
  });
}

export async function migrateEnrolments(tx: Tx, ctx: Ctx, input: MigrateInput, opts: BulkOptions = {}): Promise<BulkResult & { migrated: number }> {
  const [v] = await tx
    .select({ id: automationVersions.id, definition: automationVersions.definition, automationId: automationVersions.automationId })
    .from(automationVersions)
    .where(eq(automationVersions.id, input.toVersionId));
  const def = v && v.automationId === input.automationId ? versionDefinition(v.id, v.definition) : null;
  if (!def) return { handled: 0, continued: false, after: null, migrated: 0 };
  const rows = await tx
    .select({ id: automationEnrolments.id })
    .from(automationEnrolments)
    .where(
      and(
        eq(automationEnrolments.automationId, input.automationId),
        eq(automationEnrolments.status, "active"),
        ne(automationEnrolments.automationVersionId, input.toVersionId),
        input.after ? gt(automationEnrolments.id, input.after) : undefined,
      ),
    )
    .orderBy(asc(automationEnrolments.id))
    .limit(opts.chunk ?? BULK_CHUNK);
  let migrated = 0;
  for (const { id } of rows) {
    await tx.transaction(async (sp) => {
      // Person first, then the enrolment (advance.ts header).
      if (!(await lockEnrolmentPerson(sp, id))) return;
      const [old] = await sp.select().from(automationEnrolments).where(eq(automationEnrolments.id, id)).for("update");
      if (!old || old.status !== "active") return;
      if (def.anchor !== "enrolment" && !old.anchorAt) return;
      const newId = randomUUID();
      if (!(await endEnrolmentWith(sp, old.id, "exited", "migrated", ctx.actor, { migrated_to: newId }))) return;
      const fresh = planSteps(def, { enteredAt: old.enteredAt, anchorAt: def.anchor === "enrolment" ? null : old.anchorAt });
      const { plan, next } = startPlan(migratedPlan(fresh, old.plan, ctx.now));
      await sp.insert(automationEnrolments).values({
        id: newId,
        automationId: old.automationId,
        automationVersionId: input.toVersionId,
        personId: old.personId,
        subjectKey: old.subjectKey,
        groupId: old.groupId,
        exclusiveDomain: old.exclusiveDomain,
        source: "migration",
        triggerEventId: null,
        anchorAt: old.anchorAt,
        status: next ? "active" : "completed",
        nextStepKey: next?.key ?? null,
        nextStepAt: next ? new Date(next.due_at) : null,
        enteredAt: old.enteredAt,
        endedAt: next ? null : ctx.now,
        endReason: next ? null : "completed",
        plan,
        context: old.context,
        enteredByUserId: old.enteredByUserId,
        migratedFromEnrolmentId: old.id,
      });
      const run = { enrolmentId: newId, personId: old.personId, automationId: old.automationId, automationVersionId: input.toVersionId, actor: ctx.actor };
      await writeRun(sp, { ...run, outcome: "entered", reason: "migration", data: { migrated_from: old.id }, dedupeKey: runDedupeKey(newId, null, "entered") });
      for (const p of plan) {
        if (p.state !== "skipped" || p.reason !== "migrated") continue;
        await writeRun(sp, { ...run, stepKey: p.key, outcome: "skipped_late_entry", reason: "migrated", data: { due_at: p.due_at }, dedupeKey: runDedupeKey(newId, p.key, "skipped_late_entry") });
      }
      if (next) await writeRun(sp, { ...run, stepKey: next.key, outcome: "scheduled", data: { due_at: next.due_at }, dedupeKey: runDedupeKey(newId, next.key, "scheduled") });
      else await writeRun(sp, { ...run, outcome: "completed", reason: "completed", dedupeKey: runDedupeKey(newId, null, "completed") });
      migrated++;
    });
  }
  const after = rows.at(-1)?.id ?? null;
  const next = { ...input, after: after ?? undefined };
  const continued = await continueWith(ctx, "automation.migrate_enrolments", next, migrateJobKey(next), rows.length === (opts.chunk ?? BULK_CHUNK));
  return { handled: rows.length, continued, after, migrated };
}

// ---------------------------------------------------------------------------
// automation.end_enrolments (A-5)
// ---------------------------------------------------------------------------

export type EndInput = { automationId: string; reason: "archived"; after?: string };

export const endJobKey = (i: EndInput): string => `automation_end:${i.automationId}:${i.reason}:${startOrAfter(i.after)}`;

export async function endEnrolments(tx: Tx, ctx: Ctx, input: EndInput, opts: BulkOptions = {}): Promise<BulkResult & { ended: number }> {
  const rows = await tx
    .select({ id: automationEnrolments.id })
    .from(automationEnrolments)
    .where(
      and(
        eq(automationEnrolments.automationId, input.automationId),
        eq(automationEnrolments.status, "active"),
        input.after ? gt(automationEnrolments.id, input.after) : undefined,
      ),
    )
    .orderBy(asc(automationEnrolments.id))
    .limit(opts.chunk ?? BULK_CHUNK);
  let ended = 0;
  for (const { id } of rows) if (await endEnrolment(tx, id, "exited", input.reason, ctx.actor)) ended++;
  const after = rows.at(-1)?.id ?? null;
  const next = { ...input, after: after ?? undefined };
  const continued = await continueWith(ctx, "automation.end_enrolments", next, endJobKey(next), rows.length === (opts.chunk ?? BULK_CHUNK));
  return { handled: rows.length, continued, after, ended };
}

// ---------------------------------------------------------------------------
// automation.enrol_segment
// ---------------------------------------------------------------------------

export type EnrolSegmentInput = { automationId: string; segmentId: string; requestId: string; after?: string };

export const enrolSegmentJobKey = (i: EnrolSegmentInput): string =>
  `automation_enrol_segment:${i.automationId}:${i.segmentId}:${i.requestId}:${startOrAfter(i.after)}`;

export async function enrolSegment(tx: Tx, ctx: Ctx, input: EnrolSegmentInput, opts: BulkOptions = {}): Promise<BulkResult & { enrolled: number }> {
  const [automation] = await loadAutomations(tx, { ids: [input.automationId] });
  if (!automation || automation.status !== "active") return { handled: 0, continued: false, after: null, enrolled: 0 };
  const rows = await tx
    .select({ personId: segmentMembers.personId })
    .from(segmentMembers)
    .where(and(eq(segmentMembers.segmentId, input.segmentId), input.after ? gt(segmentMembers.personId, input.after) : undefined))
    .orderBy(asc(segmentMembers.personId))
    .limit(opts.chunk ?? BULK_CHUNK);
  let enrolled = 0;
  for (const { personId } of rows) {
    const res = await tx.transaction((sp) => enrol(sp, { automation, personId, source: "segment", actor: ctx.actor, now: ctx.now }));
    if (res.status === "enrolled") enrolled++;
  }
  const after = rows.at(-1)?.personId ?? null;
  const next = { ...input, after: after ?? undefined };
  const continued = await continueWith(ctx, "automation.enrol_segment", next, enrolSegmentJobKey(next), rows.length === (opts.chunk ?? BULK_CHUNK));
  return { handled: rows.length, continued, after, enrolled };
}
