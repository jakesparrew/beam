"use server";
/**
 * automation Server Actions (automation spec 4.1, automation-P5; all `audience: 'staff'` through
 * `action()`). The definition and status actions of the admin screens: create, save draft,
 * publish (A-2, A-3, A-40), activate, pause, resume (A-5, A-5a, A-29), archive (A-5) and segment
 * enrolment. Every handler writes its own audit row with the spec's audit name (section 7), so
 * the wrapper's automatic row is off (`audit: false`); definitions are audited as their
 * `definition_hash` plus version numbers, never the whole JSON.
 *
 * Each status action locks the `automations` row `FOR UPDATE` (A-5), so a double click or two
 * staff members cannot interleave a pause and an archive. Bulk side effects are jobs enqueued in
 * the same transaction (resume, end, migrate, segment enrolment); `action()` runs them after the
 * commit. The person controls (`exitEnrolment`, `enrolPerson`, `movePerson`) come with
 * automation-P6.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { automationEnrolments, automationGroups, automations, automationVersions, segments } from "@beam/db/schema";
import { AUTOMATION_PURPOSES, isPublishable, SLUG_RE, type Definition } from "@beam/core/automation";
import type { DpiaKey } from "@beam/core/ops";
import { action } from "@/lib/action";
import { and, ConflictError, eq, NotFoundError, sql, ValidationError, type Ctx, type Tx } from "@/lib/ctx";
import { isDpiaApproved } from "@/modules/ops/api";
import { endJobKey, enrolSegmentJobKey, migrateJobKey, resumeJobKey } from "./engine/bulk";
import { definitionHash, draftIssues } from "./queries";

const Purpose = z.enum(AUTOMATION_PURPOSES);
const Slug = z.string().trim().min(2).max(80).regex(SLUG_RE, "slug");
const Name = z.string().trim().min(1).max(160);
const Description = z.string().trim().max(2000);
const GroupKey = z.string().trim().min(1).max(60);
const Priority = z.number().int().min(0).max(1000);

type AutomationRow = typeof automations.$inferSelect;

/** The working copy a new automation starts with: a manual trigger and one email step at +0 (spec 5). */
function starterDefinition(): Record<string, unknown> {
  return {
    schema_version: 1,
    trigger: { manual: true },
    anchor: "enrolment",
    re_entry: "never",
    exit_on: [],
    steps: [{ key: "email_1", type: "email", template: "", at: { from: "enrolment", minutes: 0 } }],
  };
}

async function lockAutomation(tx: Tx, id: string): Promise<AutomationRow> {
  const [row] = await tx.select().from(automations).where(eq(automations.id, id)).for("update");
  if (!row) throw new NotFoundError("automation_not_found");
  return row;
}

async function groupByKey(tx: Tx, key: string): Promise<typeof automationGroups.$inferSelect> {
  const [g] = await tx.select().from(automationGroups).where(eq(automationGroups.key, key));
  if (!g) throw new ValidationError("group_unknown", { groupKey: "group_unknown" });
  return g;
}

const hashOrNull = (def: unknown) => (def === null || def === undefined ? null : definitionHash(def));

/** One audit row per staff action, entity type `automation` (spec 7). */
async function auditAutomation(ctx: Ctx, actionName: string, id: string, oldValue: unknown, newValue: unknown): Promise<void> {
  await ctx.audit({ action: actionName, entityType: "automation", entityId: id, oldValue, newValue });
}

/** A-5a: `conflict` with `dpia_not_approved:<key>` while the DPIA gate of the automation is closed. */
async function assertDpiaGate(tx: Tx, a: AutomationRow): Promise<void> {
  if (!a.requiresDpia) return;
  if (!(await isDpiaApproved(tx, a.requiresDpia as DpiaKey))) throw new ConflictError(`dpia_not_approved:${a.requiresDpia}`);
}

/** The `fields` map of a validation failure: dotted definition path -> issue code (first per path). */
function issueFields(issues: readonly { path: string; code: string; severity: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) if (i.severity === "error") out[i.path || "definition"] ??= i.code;
  return out;
}

// ---------------------------------------------------------------------------
// createAutomation, saveDraft
// ---------------------------------------------------------------------------

const CreateAutomationInput = z
  .object({
    slug: Slug,
    name: Name,
    description: Description.optional(),
    groupKey: GroupKey,
    isMarketing: z.boolean(),
    purpose: Purpose.optional(),
    priority: Priority.optional(),
    duplicateOfId: z.uuid().optional(),
  })
  .refine((i) => !i.isMarketing || i.purpose !== undefined, { path: ["purpose"], message: "purpose_required" });

export const createAutomation = action(
  { name: "automation.create", audience: "staff", permission: "automations.write", input: CreateAutomationInput, audit: false },
  async (ctx, input): Promise<{ id: string }> => {
    const tx = ctx.tx;
    const group = await groupByKey(tx, input.groupKey);
    let draft: unknown = starterDefinition();
    let gates: { requiresDpia: string | null; requiresFlag: string | null } = { requiresDpia: null, requiresFlag: null };
    if (input.duplicateOfId) {
      const [src] = await tx
        .select({ draft: automations.draftDefinition, current: automationVersions.definition, requiresDpia: automations.requiresDpia, requiresFlag: automations.requiresFlag })
        .from(automations)
        .leftJoin(automationVersions, eq(automationVersions.id, automations.currentVersionId))
        .where(eq(automations.id, input.duplicateOfId));
      if (!src) throw new NotFoundError("automation_not_found");
      draft = src.draft ?? src.current ?? draft;
      // A-5: the duplicate copies the seed-only gates, so duplicating never removes a DPIA or flag gate.
      gates = { requiresDpia: src.requiresDpia, requiresFlag: src.requiresFlag };
    }
    const userId = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
    const [row] = await tx
      .insert(automations)
      .values({
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        groupId: group.id,
        priority: input.priority ?? 100,
        status: "draft",
        isMarketing: input.isMarketing,
        purpose: input.purpose ?? null,
        draftDefinition: draft,
        draftUpdatedAt: ctx.now,
        draftUpdatedByUserId: userId,
        requiresDpia: gates.requiresDpia,
        requiresFlag: gates.requiresFlag,
        createdByUserId: userId,
      })
      .onConflictDoNothing({ target: automations.slug })
      .returning({ id: automations.id });
    if (!row) throw new ConflictError("slug_taken");
    await auditAutomation(ctx, "automation.create", row.id, null, {
      slug: input.slug,
      group: input.groupKey,
      isMarketing: input.isMarketing,
      purpose: input.purpose ?? null,
      duplicateOfId: input.duplicateOfId ?? null,
      draftHash: hashOrNull(draft),
    });
    return { id: row.id };
  },
);

const SaveDraftInput = z.object({
  automationId: z.uuid(),
  definition: z.unknown(),
  name: Name.optional(),
  description: Description.nullable().optional(),
  groupKey: GroupKey.optional(),
  priority: Priority.optional(),
  isMarketing: z.boolean().optional(),
  purpose: Purpose.nullable().optional(),
});

/** Saves the working copy (even with issues) and returns every issue of it (A-1, A-3, A-4). */
export const saveDraft = action(
  { name: "automation.save_draft", audience: "staff", permission: "automations.write", input: SaveDraftInput, audit: false },
  async (ctx, input) => {
    const tx = ctx.tx;
    const a = await lockAutomation(tx, input.automationId);
    if (a.status === "archived") throw new ConflictError("automation_archived");
    const group = input.groupKey ? await groupByKey(tx, input.groupKey) : null;
    const isMarketing = input.isMarketing ?? a.isMarketing;
    const purpose = input.purpose === undefined ? a.purpose : input.purpose;
    if (isMarketing && purpose === null) throw new ValidationError("purpose_required", { purpose: "purpose_required" });
    const definition = input.definition === undefined ? a.draftDefinition : input.definition;
    const patch = {
      name: input.name ?? a.name,
      description: input.description === undefined ? a.description : input.description,
      groupId: group?.id ?? a.groupId,
      priority: input.priority ?? a.priority,
      isMarketing,
      purpose,
      draftDefinition: definition ?? null,
      draftUpdatedAt: ctx.now,
      draftUpdatedByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
      updatedAt: ctx.now,
    };
    await tx.update(automations).set(patch).where(eq(automations.id, a.id));
    const { issues } = await draftIssues(tx, { id: a.id, slug: a.slug, isMarketing, purpose, groupId: patch.groupId }, definition);
    await auditAutomation(
      ctx,
      "automation.update_draft",
      a.id,
      { name: a.name, groupId: a.groupId, priority: a.priority, isMarketing: a.isMarketing, purpose: a.purpose, draftHash: hashOrNull(a.draftDefinition) },
      { name: patch.name, groupId: patch.groupId, priority: patch.priority, isMarketing, purpose, draftHash: hashOrNull(definition), issues: issues.length },
    );
    return { issues };
  },
);

// ---------------------------------------------------------------------------
// publishVersion (A-2, A-3, A-6, A-40)
// ---------------------------------------------------------------------------

const PublishVersionInput = z.object({
  automationId: z.uuid(),
  changeNote: z.string().trim().max(500).optional(),
  migrateActive: z.boolean(),
});

export const publishVersion = action(
  { name: "automation.publish", audience: "staff", permission: "automations.publish", input: PublishVersionInput, audit: false },
  async (ctx, input): Promise<{ versionId: string; version: number; migrationJobId?: string }> => {
    const tx = ctx.tx;
    const a = await lockAutomation(tx, input.automationId);
    if (a.status === "archived") throw new ConflictError("automation_archived");
    const { definition, issues } = await draftIssues(tx, { id: a.id, slug: a.slug, isMarketing: a.isMarketing, purpose: a.purpose, groupId: a.groupId }, a.draftDefinition);
    if (!definition || !isPublishable(issues)) {
      // A-3: a missing translation names its templates and locales in the message.
      const missing = issues.filter((i) => i.code === "translation_missing").map((i) => `${String(i.params?.template)}:${([] as string[]).concat((i.params?.locales as string[] | undefined) ?? []).join("+")}`);
      throw new ValidationError(missing.length ? `translation_missing:${missing.join(",")}` : "definition_invalid", issueFields(issues));
    }
    const hash = definitionHash(definition);
    const [current] = a.currentVersionId
      ? await tx.select({ version: automationVersions.version, hash: automationVersions.definitionHash }).from(automationVersions).where(eq(automationVersions.id, a.currentVersionId))
      : [];
    if (current && current.hash === hash) throw new ConflictError("definition_unchanged");
    const [max] = await tx
      .select({ v: sql<number>`coalesce(max(${automationVersions.version}), 0)`.mapWith(Number) })
      .from(automationVersions)
      .where(eq(automationVersions.automationId, a.id));
    const version = (max?.v ?? 0) + 1;
    const userId = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
    // The version row first, then current_version_id (spec 2.4).
    const [v] = await tx
      .insert(automationVersions)
      .values({ automationId: a.id, version, definition: definition satisfies Definition, definitionHash: hash, changeNote: input.changeNote || null, publishedAt: ctx.now, createdByUserId: userId })
      .returning({ id: automationVersions.id });
    await tx.update(automations).set({ currentVersionId: v!.id, updatedAt: ctx.now }).where(eq(automations.id, a.id));
    await auditAutomation(ctx, "automation.publish", a.id, { version: current?.version ?? null, hash: current?.hash ?? null }, { version, hash, changeNote: input.changeNote ?? null });

    let migrationJobId: string | undefined;
    if (input.migrateActive) {
      const [active] = await tx
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(automationEnrolments)
        .where(and(eq(automationEnrolments.automationId, a.id), eq(automationEnrolments.status, "active")));
      const payload = { automationId: a.id, toVersionId: v!.id };
      const job = await ctx.enqueue({ kind: "automation.migrate_enrolments", payload, key: migrateJobKey(payload), lane: "bulk" });
      migrationJobId = job.id;
      await auditAutomation(ctx, "automation.migrate_enrolments", a.id, { version: current?.version ?? null }, { version, activeEnrolments: active?.n ?? 0, jobId: job.id });
    }
    return migrationJobId ? { versionId: v!.id, version, migrationJobId } : { versionId: v!.id, version };
  },
);

// ---------------------------------------------------------------------------
// Status moves (A-5, A-5a)
// ---------------------------------------------------------------------------

const AutomationIdInput = z.object({ automationId: z.uuid() });

/** `draft -> active`; needs a published version and an open DPIA gate. */
export const activateAutomation = action(
  { name: "automation.activate", audience: "staff", permission: "automations.publish", input: AutomationIdInput, audit: false },
  async (ctx, input): Promise<{ status: "active" }> => {
    const a = await lockAutomation(ctx.tx, input.automationId);
    if (a.status !== "draft") throw new ConflictError(`status_move:${a.status}->active`);
    if (!a.currentVersionId) throw new ConflictError("not_published");
    await assertDpiaGate(ctx.tx, a);
    await ctx.tx
      .update(automations)
      .set({ status: "active", activatedAt: a.activatedAt ?? ctx.now, updatedAt: ctx.now })
      .where(eq(automations.id, a.id));
    await auditAutomation(ctx, "automation.activate", a.id, { status: a.status }, { status: "active" });
    return { status: "active" };
  },
);

/** `active -> paused`: no step runs and no one enrols until resume; exits still apply. */
export const pauseAutomation = action(
  { name: "automation.pause", audience: "staff", permission: "automations.publish", input: AutomationIdInput, audit: false },
  async (ctx, input): Promise<{ status: "paused" }> => {
    const a = await lockAutomation(ctx.tx, input.automationId);
    if (a.status !== "active") throw new ConflictError(`status_move:${a.status}->paused`);
    await ctx.tx.update(automations).set({ status: "paused", pausedAt: ctx.now, updatedAt: ctx.now }).where(eq(automations.id, a.id));
    await auditAutomation(ctx, "automation.pause", a.id, { status: a.status }, { status: "paused" });
    return { status: "paused" };
  },
);

/** `paused -> active` behind the DPIA gate; enqueues `automation.resume_enrolments` (A-29). */
export const resumeAutomation = action(
  { name: "automation.resume", audience: "staff", permission: "automations.publish", input: AutomationIdInput, audit: false },
  async (ctx, input): Promise<{ status: "active"; jobId: string }> => {
    const a = await lockAutomation(ctx.tx, input.automationId);
    if (a.status !== "paused") throw new ConflictError(`status_move:${a.status}->active`);
    await assertDpiaGate(ctx.tx, a);
    await ctx.tx.update(automations).set({ status: "active", pausedAt: null, lastResumedAt: ctx.now, updatedAt: ctx.now }).where(eq(automations.id, a.id));
    const payload = { automationId: a.id, resumedAt: ctx.now.toISOString() };
    const job = await ctx.enqueue({ kind: "automation.resume_enrolments", payload, key: resumeJobKey(payload), lane: "bulk" });
    await auditAutomation(ctx, "automation.resume", a.id, { status: a.status, pausedAt: a.pausedAt?.toISOString() ?? null }, { status: "active", jobId: job.id });
    return { status: "active", jobId: job.id };
  },
);

const ArchiveAutomationInput = z.object({ automationId: z.uuid(), confirmSlug: z.string().trim().min(1).max(80) });

/** `draft|active|paused -> archived` (typed slug to confirm); enqueues `automation.end_enrolments`. */
export const archiveAutomation = action(
  { name: "automation.archive", audience: "staff", permission: "automations.publish", input: ArchiveAutomationInput, audit: false },
  async (ctx, input): Promise<{ jobId: string }> => {
    const a = await lockAutomation(ctx.tx, input.automationId);
    if (input.confirmSlug !== a.slug) throw new ValidationError("confirm_slug_mismatch", { confirmSlug: "confirm_slug_mismatch" });
    if (a.status === "archived") throw new ConflictError("status_move:archived->archived");
    await ctx.tx.update(automations).set({ status: "archived", pausedAt: null, updatedAt: ctx.now }).where(eq(automations.id, a.id));
    const payload = { automationId: a.id, reason: "archived" as const };
    const job = await ctx.enqueue({ kind: "automation.end_enrolments", payload, key: endJobKey(payload), lane: "bulk" });
    await auditAutomation(ctx, "automation.archive", a.id, { status: a.status }, { status: "archived", jobId: job.id });
    return { jobId: job.id };
  },
);

// ---------------------------------------------------------------------------
// enrolSegment
// ---------------------------------------------------------------------------

const EnrolSegmentInput = z.object({ automationId: z.uuid(), segmentId: z.uuid() });

/** Enrols a segment's members into an active automation through `automation.enrol_segment` (every entry rule applies). */
export const enrolSegment = action(
  { name: "automation.enrol_segment", audience: "staff", permission: "automations.publish", input: EnrolSegmentInput, audit: false },
  async (ctx, input): Promise<{ jobId: string; estimatedCount: number }> => {
    const a = await lockAutomation(ctx.tx, input.automationId);
    if (a.status !== "active") throw new ConflictError(`automation_not_active:${a.status}`);
    const [segment] = await ctx.tx
      .select({ id: segments.id, isArchived: segments.isArchived, count: sql<number>`(select count(*) from segment_members sm where sm.segment_id = "segments"."id")`.mapWith(Number) })
      .from(segments)
      .where(eq(segments.id, input.segmentId));
    if (!segment) throw new NotFoundError("segment_not_found");
    if (segment.isArchived) throw new ConflictError("segment_archived");
    const payload = { automationId: a.id, segmentId: segment.id, requestId: randomUUID() };
    const job = await ctx.enqueue({ kind: "automation.enrol_segment", payload, key: enrolSegmentJobKey(payload), lane: "bulk" });
    await auditAutomation(ctx, "automation.enrol_segment", a.id, null, { segmentId: segment.id, estimatedCount: segment.count, jobId: job.id });
    return { jobId: job.id, estimatedCount: segment.count };
  },
);
