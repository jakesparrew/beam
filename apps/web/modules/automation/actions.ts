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
 * commit.
 *
 * The person controls (automation-P6, A-36 to A-38; `automations.move_person`): `exitEnrolment`
 * ends one active enrolment with `manual`; `enrolPerson` enrols with the staff override of A-37
 * (re-entry, audience and exclusivity priority overridden, a blocking journey in the exclusive
 * domain exits `moved`; consent, suppression and restriction are never overridden: marketing
 * steps are still checked when they run); `movePerson` exits one enrolment `moved` and enrols
 * into another in one transaction, refused as a whole when the target refuses the entry. Each
 * writes one audit row with `person_id` (entity type `automation_enrolment`), and a first step
 * already due is enqueued so it runs in the wrapper's after-commit kick.
 *
 * The conflict rules (automation-P7, R2; `automations.publish`): `upsertGroup` creates or edits
 * an automation group (exclusive, lane, priority; audit `automation.group_update`, entity type
 * `automation_group`), and `updateAutomationRules` writes `settings.automation_rules` (frequency
 * caps, quiet hours, webhook hosts) through platform's versioned setter (a stale version is
 * `conflict`; platform writes `settings.update`, this action `automation.rules_update`). A change
 * of the webhook host allow-list also needs `settings.write` (a data-export decision).
 *
 * The visual builder (automation-P10, R4; `automations.write`): `saveBuilderGraph` converts the
 * builder's flow with `graphToDefinition` and then takes the path of `saveDraft`.
 *
 * Decisions (automation-P7):
 * - A group key is fixed once created (seeds and `createAutomation` refer to groups by key): an
 *   edit with another key is `conflict` `group_key_immutable`; a new group with a taken key is
 *   `conflict` `group_key_taken`.
 * - Group changes apply to new enrolments: an active enrolment keeps the `exclusive_domain` it
 *   copied at entry, so `uq_enrolment_domain` never fails on existing rows.
 * - A group cannot become exclusive while one of its non-archived automations sets `subject`
 *   in its draft or current version (A-1): `conflict` `exclusive_subject:<slug>`.
 * - Webhook hosts are trimmed, lower-cased and de-duplicated before they are compared and stored;
 *   a day cap above the week cap is `validation` (`day_cap_above_week_cap`).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { automationEnrolments, automationGroups, automations, automationVersions, persons, segments } from "@beam/db/schema";
import {
  AUTOMATION_PURPOSES,
  BuilderGraphSchema,
  graphToDefinition,
  isPublishable,
  SLUG_RE,
  type BuilderGraph,
  type Definition,
  type DefinitionIssue,
  type EnrolResult,
} from "@beam/core/automation";
import type { DpiaKey } from "@beam/core/ops";
import { action } from "@/lib/action";
import { and, ConflictError, eq, ne, NotFoundError, sql, ValidationError, type Ctx, type Tx } from "@/lib/ctx";
import { getSettingWithVersion, setSetting } from "@/lib/settings";
import { isDpiaApproved } from "@/modules/ops/api";
import { endJobKey, enrolSegmentJobKey, migrateJobKey, resumeJobKey } from "./engine/bulk";
import { enrol, loadAutomations, PERSON_LOCK, type EngineAutomation } from "./engine/enrol";
import { endEnrolmentWith } from "./engine/exits";
import { stepJobKey, stepJobPriority } from "./engine/step";
import type { AutomationRulesValue } from "./config";
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

type DraftWrite = Omit<z.infer<typeof SaveDraftInput>, "definition"> & { definition: unknown };

/** The shared path of `saveDraft` and `saveBuilderGraph`: lock, write the working copy, collect its issues, audit. */
async function writeDraft(ctx: Ctx, input: DraftWrite): Promise<{ issues: DefinitionIssue[] }> {
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
}

/** Saves the working copy (even with issues) and returns every issue of it (A-1, A-3, A-4). */
export const saveDraft = action(
  { name: "automation.save_draft", audience: "staff", permission: "automations.write", input: SaveDraftInput, audit: false },
  async (ctx, input) => writeDraft(ctx, input),
);

const SaveBuilderGraphInput = z.object({ automationId: z.uuid(), graph: BuilderGraphSchema });

/**
 * Saves the visual builder's flow (R4, automation-P10): `graphToDefinition`, then the path of
 * `saveDraft` (saved even with field issues, audit `automation.update_draft`). A flow with
 * structural issues (no blocks, a malformed block, a step key used twice, a jump to an unknown or
 * earlier step) has no step list to save: the draft stays as it was and the issues come back with
 * `saved: false`.
 */
export const saveBuilderGraph = action(
  { name: "automation.save_builder", audience: "staff", permission: "automations.write", input: SaveBuilderGraphInput, audit: false },
  async (ctx, input): Promise<{ issues: DefinitionIssue[]; saved: boolean }> => {
    const converted = graphToDefinition(input.graph as unknown as BuilderGraph);
    if (!converted.ok) {
      const a = await lockAutomation(ctx.tx, input.automationId);
      if (a.status === "archived") throw new ConflictError("automation_archived");
      return { issues: converted.issues, saved: false };
    }
    const { issues } = await writeDraft(ctx, { automationId: input.automationId, definition: converted.value });
    return { issues, saved: true };
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

// ---------------------------------------------------------------------------
// Person controls (A-36 to A-38)
// ---------------------------------------------------------------------------

/** The enrolment a person control acts on, with its automation slug. */
async function enrolmentOf(tx: Tx, enrolmentId: string) {
  const [row] = await tx
    .select({
      id: automationEnrolments.id,
      personId: automationEnrolments.personId,
      automationId: automationEnrolments.automationId,
      status: automationEnrolments.status,
      slug: automations.slug,
    })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .where(eq(automationEnrolments.id, enrolmentId));
  if (!row) throw new NotFoundError("enrolment_not_found");
  return row;
}

/** The person row lock first (the engine's lock order: person, then enrolment). */
async function lockPerson(tx: Tx, personId: string): Promise<void> {
  const [p] = await tx.select({ id: persons.id }).from(persons).where(eq(persons.id, personId)).for(PERSON_LOCK);
  if (!p) throw new NotFoundError("person_not_found");
}

/** The target of a staff enrolment: active, published, and given its anchor when it has a data anchor (A-37). */
async function staffTarget(tx: Tx, automationId: string, anchorAt: Date | null): Promise<EngineAutomation> {
  const [a] = await loadAutomations(tx, { ids: [automationId] });
  if (!a) throw new NotFoundError("automation_not_found");
  if (a.status !== "active" || !a.definition) throw new ConflictError(`automation_not_active:${a.status}`);
  if (a.definition.anchor !== "enrolment" && !anchorAt) throw new ValidationError("anchor_required", { anchorAt: "anchor_required" });
  return a;
}

/** Enqueues the first step of a new enrolment when it is already due (A-20's job and key). */
async function enqueueIfDue(ctx: Ctx, a: EngineAutomation, res: EnrolResult): Promise<void> {
  if (res.status !== "enrolled") return;
  const [e] = await ctx.tx
    .select({ stepKey: automationEnrolments.nextStepKey, at: automationEnrolments.nextStepAt, status: automationEnrolments.status })
    .from(automationEnrolments)
    .where(eq(automationEnrolments.id, res.enrolmentId));
  if (!e || e.status !== "active" || !e.stepKey || !e.at || e.at.getTime() > ctx.now.getTime()) return;
  await ctx.enqueue({
    kind: "automation.step",
    payload: { enrolmentId: res.enrolmentId, stepKey: e.stepKey },
    key: stepJobKey(res.enrolmentId, e.stepKey),
    lane: "fast",
    priority: stepJobPriority(a.isMarketing),
  });
}

const staffUserId = (ctx: Ctx) => (ctx.actor.kind === "staff" ? ctx.actor.userId : null);
const Note = z.string().trim().max(500);
const AnchorAt = z.iso.datetime({ offset: true });
const SubjectKey = z.string().trim().max(200).regex(/^([a-z_]+:[A-Za-z0-9_-]+)?$/, "subject_key");

const ExitEnrolmentInput = z.object({ enrolmentId: z.uuid(), note: Note.optional() });

/** A-36: ends one active enrolment with `manual`; one audit row `automation.person_exit`. */
export const exitEnrolment = action(
  { name: "automation.person_exit", audience: "staff", permission: "automations.move_person", input: ExitEnrolmentInput, audit: false },
  async (ctx, input): Promise<{ ok: true }> => {
    const tx = ctx.tx;
    const before = await enrolmentOf(tx, input.enrolmentId);
    await lockPerson(tx, before.personId);
    const note = input.note || null;
    const ended = await endEnrolmentWith(tx, before.id, "exited", "manual", ctx.actor, note ? { note } : {});
    if (!ended) throw new ConflictError("enrolment_not_active");
    await ctx.audit({
      action: "automation.person_exit",
      entityType: "automation_enrolment",
      entityId: before.id,
      personId: before.personId,
      oldValue: { status: "active", automation: before.slug },
      newValue: { status: "exited", endReason: "manual", automation: before.slug, note },
    });
    return { ok: true };
  },
);

const EnrolPersonInput = z.object({ personId: z.uuid(), automationId: z.uuid(), anchorAt: AnchorAt.optional(), subjectKey: SubjectKey.optional() });

/** A-37: staff enrolment (source `staff`) with the staff override; one audit row `automation.person_enrol`. */
export const enrolPerson = action(
  { name: "automation.person_enrol", audience: "staff", permission: "automations.move_person", input: EnrolPersonInput, audit: false },
  async (ctx, input): Promise<EnrolResult> => {
    const tx = ctx.tx;
    const anchorAt = input.anchorAt ? new Date(input.anchorAt) : null;
    await lockPerson(tx, input.personId);
    const target = await staffTarget(tx, input.automationId, anchorAt);
    const res = await enrol(tx, {
      automation: target,
      personId: input.personId,
      source: "staff",
      actor: ctx.actor,
      now: ctx.now,
      anchorAt,
      ...(input.subjectKey ? { subjectKey: input.subjectKey } : {}),
      enteredByUserId: staffUserId(ctx),
      override: true,
    });
    await enqueueIfDue(ctx, target, res);
    await ctx.audit({
      action: "automation.person_enrol",
      entityType: "automation_enrolment",
      entityId: res.status === "enrolled" ? res.enrolmentId : null,
      personId: input.personId,
      oldValue: null,
      newValue: { automation: target.slug, result: res.status === "enrolled" ? "enrolled" : res.outcome, anchorAt: input.anchorAt ?? null, subjectKey: input.subjectKey ?? null },
    });
    return res;
  },
);

const MovePersonInput = z.object({ personId: z.uuid(), fromEnrolmentId: z.uuid(), toAutomationId: z.uuid(), anchorAt: AnchorAt.optional() });

/** A-38: exit `moved` and enrol (source `staff_move`) in one transaction; one audit row `automation.person_move`. */
export const movePerson = action(
  { name: "automation.person_move", audience: "staff", permission: "automations.move_person", input: MovePersonInput, audit: false },
  async (ctx, input): Promise<{ exitedEnrolmentId: string; enrolment: EnrolResult }> => {
    const tx = ctx.tx;
    const from = await enrolmentOf(tx, input.fromEnrolmentId);
    if (from.personId !== input.personId) throw new NotFoundError("enrolment_not_found");
    await lockPerson(tx, from.personId);
    if (from.automationId === input.toAutomationId) throw new ConflictError("move_same_automation");
    const anchorAt = input.anchorAt ? new Date(input.anchorAt) : null;
    const target = await staffTarget(tx, input.toAutomationId, anchorAt);
    const ended = await endEnrolmentWith(tx, from.id, "exited", "moved", ctx.actor, { moved_to: target.slug });
    if (!ended) throw new ConflictError("enrolment_not_active");
    const res = await enrol(tx, {
      automation: target,
      personId: from.personId,
      source: "staff_move",
      actor: ctx.actor,
      now: ctx.now,
      anchorAt,
      enteredByUserId: staffUserId(ctx),
      override: true,
    });
    // One transaction: a refused entry leaves the person where they were.
    if (res.status !== "enrolled") throw new ConflictError(`move_refused:${res.outcome}`);
    await enqueueIfDue(ctx, target, res);
    await ctx.audit({
      action: "automation.person_move",
      entityType: "automation_enrolment",
      entityId: res.enrolmentId,
      personId: from.personId,
      oldValue: { enrolmentId: from.id, automation: from.slug },
      newValue: { enrolmentId: res.enrolmentId, automation: target.slug, anchorAt: input.anchorAt ?? null },
    });
    return { exitedEnrolmentId: from.id, enrolment: res };
  },
);

// ---------------------------------------------------------------------------
// Conflict rules (automation-P7, R2): groups and settings.automation_rules
// ---------------------------------------------------------------------------

const KeyRe = /^[a-z][a-z0-9_]*$/;
const GroupKeyInput = z.string().trim().min(2).max(60).regex(KeyRe, "group_key");
const LaneInput = z.string().trim().min(2).max(60).regex(KeyRe, "lane");

const UpsertGroupInput = z.object({
  id: z.uuid().optional(),
  key: GroupKeyInput,
  name: Name,
  description: Description.optional(),
  isExclusive: z.boolean(),
  lane: LaneInput.nullable().optional(),
  priority: Priority,
});

type GroupRow = typeof automationGroups.$inferSelect;
const groupAudit = (g: Pick<GroupRow, "key" | "name" | "description" | "isExclusive" | "lane" | "priority">) => ({
  key: g.key,
  name: g.name,
  description: g.description,
  isExclusive: g.isExclusive,
  lane: g.lane,
  priority: g.priority,
});

/** A-1: the first non-archived automation of the group whose draft or current version sets `subject`. */
async function subjectAutomationIn(tx: Tx, groupId: string): Promise<string | null> {
  const [row] = await tx
    .select({ slug: automations.slug })
    .from(automations)
    .leftJoin(automationVersions, eq(automationVersions.id, automations.currentVersionId))
    .where(
      and(
        eq(automations.groupId, groupId),
        ne(automations.status, "archived"),
        sql`(${automations.draftDefinition} ->> 'subject' is not null or ${automationVersions.definition} ->> 'subject' is not null)`,
      ),
    )
    .orderBy(automations.slug)
    .limit(1);
  return row?.slug ?? null;
}

/** Creates or edits an automation group (exclusive, lane, priority); one `automation.group_update` audit row. */
export const upsertGroup = action(
  { name: "automation.group_upsert", audience: "staff", permission: "automations.publish", input: UpsertGroupInput, audit: false },
  async (ctx, input): Promise<{ id: string }> => {
    const tx = ctx.tx;
    const values = {
      key: input.key,
      name: input.name,
      description: input.description || null,
      isExclusive: input.isExclusive,
      lane: input.lane || null,
      priority: input.priority,
    };
    if (!input.id) {
      const [row] = await tx.insert(automationGroups).values(values).onConflictDoNothing({ target: automationGroups.key }).returning();
      if (!row) throw new ConflictError("group_key_taken");
      await ctx.audit({ action: "automation.group_update", entityType: "automation_group", entityId: row.id, oldValue: null, newValue: groupAudit(row) });
      return { id: row.id };
    }
    const [before] = await tx.select().from(automationGroups).where(eq(automationGroups.id, input.id)).for("update");
    if (!before) throw new NotFoundError("group_not_found");
    if (before.key !== input.key) throw new ConflictError("group_key_immutable");
    if (input.isExclusive && !before.isExclusive) {
      const slug = await subjectAutomationIn(tx, before.id);
      if (slug) throw new ConflictError(`exclusive_subject:${slug}`);
    }
    const [after] = await tx
      .update(automationGroups)
      .set({ ...values, key: before.key, updatedAt: ctx.now })
      .where(eq(automationGroups.id, before.id))
      .returning();
    await ctx.audit({ action: "automation.group_update", entityType: "automation_group", entityId: before.id, oldValue: groupAudit(before), newValue: groupAudit(after!) });
    return { id: before.id };
  },
);

const HHMM = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "time");
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const WebhookHost = z.string().trim().toLowerCase().regex(HOST_RE, "webhook_host");

const UpdateRulesInput = z
  .object({
    expectedVersion: z.number().int().min(0),
    maxMarketingPerDay: z.number().int().min(0).max(10),
    maxMarketingPerWeek: z.number().int().min(0).max(30),
    quietStart: HHMM,
    quietEnd: HHMM,
    webhookHosts: z.array(WebhookHost).max(50),
  })
  .refine((i) => i.maxMarketingPerDay <= i.maxMarketingPerWeek, { path: ["maxMarketingPerDay"], message: "day_cap_above_week_cap" });

const normalHosts = (hosts: readonly string[]): string[] => [...new Set(hosts.map((h) => h.trim().toLowerCase()).filter(Boolean))].sort();

/**
 * Writes `settings.automation_rules` (A-32 caps and quiet hours, the webhook host allow-list)
 * through platform's versioned setter; a host change additionally requires `settings.write`.
 */
export const updateAutomationRules = action(
  { name: "automation.rules_update", audience: "staff", permission: "automations.publish", input: UpdateRulesInput, audit: false },
  async (ctx, input): Promise<{ ok: true; version: number }> => {
    const current = await getSettingWithVersion(ctx.tx, "automation_rules");
    const before: AutomationRulesValue = current.value;
    const hosts = normalHosts(input.webhookHosts);
    const hostsChanged = hosts.join(",") !== normalHosts(before.webhook_hosts).join(",");
    if (hostsChanged) ctx.require("settings.write");
    const next: AutomationRulesValue = {
      max_marketing_per_day: input.maxMarketingPerDay,
      max_marketing_per_week: input.maxMarketingPerWeek,
      quiet_start: input.quietStart,
      quiet_end: input.quietEnd,
      // An unchanged list keeps its stored order.
      webhook_hosts: hostsChanged ? hosts : [...before.webhook_hosts],
    };
    const { version } = await setSetting(ctx, "automation_rules", next as never, input.expectedVersion);
    await ctx.audit({
      action: "automation.rules_update",
      entityType: "settings",
      entityId: "automation_rules",
      oldValue: { ...before, version: current.version },
      newValue: { ...next, version, webhookHostsChanged: hostsChanged },
    });
    return { ok: true, version };
  },
);
