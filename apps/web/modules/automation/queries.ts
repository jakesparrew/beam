/**
 * automation staff queries (automation spec 4.2, automation-P5). Every function takes the caller's
 * `db`/`tx` first and reads through it (OD-15); the page checks the permission before calling
 * (`automations.write` or `reports.read`; person data additionally `persons.read`, see
 * `canViewAutomations`). Nothing here writes.
 *
 * Also the shared server helpers of `actions.ts` (a `"use server"` file exports only actions):
 * `definitionHash` (sha256 of the canonical JSON, A-2), `loadValidationRefs` and
 * `draftIssues` (A-1, A-3, A-4: parse plus `validateDefinition` against the database).
 * The person page reads (automation-P6): `getPersonAutomations`, `previewEnrolment` (A-39,
 * through `engine/preview.ts`) and `listEnrolOptions` (the enrol dialog's choices and warnings).
 * The conflict rules (automation-P7, R2; `automations.publish`): `getConflictReport` (which
 * journeys block or supersede which) and `getAutomationRules` (the rules page's values).
 */
import { createHash } from "node:crypto";
import type { DbOrTx, Tx } from "@beam/db";
import {
  automationEnrolments,
  automationGroups,
  automations,
  automationVersions,
  persons,
  roles,
  segmentMembers,
  segments,
  tags,
  users,
  vAutomationStats,
  vPersonAutomationTimeline,
  vPersonStatus,
} from "@beam/db/schema";
import {
  canonicalJson,
  diffDefinitions,
  enrolTargets,
  exclusiveDomain,
  parseDefinition,
  referencedTemplates,
  validateDefinition,
  type AutomationPurpose,
  type AutomationRunOutcome,
  type AutomationTimelineItem,
  type Definition,
  type DefinitionChange,
  type DefinitionIssue,
  type PersonEnrolmentSummary,
  type PlannedStep,
  type ReEntry,
  type TemplateRef,
  type ValidationRefs,
} from "@beam/core/automation";
import { messagesFor, type Locale } from "@beam/core/i18n";
import { and, asc, desc, eq, gte, inArray, lt, lte, ne, or, sql, type Actor, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { getSetting, getSettingWithVersion } from "@/lib/settings";
import { EVENTS } from "@/registry/events.generated";
import { getPublishedTemplateInfo, getReachability, listPublishedTemplates } from "@/modules/email/api";
import { loadAutomations } from "./engine/enrol";
import { previewSteps, type PreviewStep } from "./engine/preview";

export type { PreviewOutcome, PreviewStep } from "./engine/preview";

export type AutomationStatus = "draft" | "active" | "paused" | "archived";
export type EnrolmentStatus = "active" | "completed" | "exited";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** Read access to the automation screens: `automations.write` or `reports.read` (spec 7). */
export function canViewAutomations(actor: Actor): boolean {
  if (actor.kind !== "staff") return false;
  const p = actor.permissions as ReadonlySet<string>;
  return p.has("*") || p.has("automations.write") || p.has("reports.read");
}

// ---------------------------------------------------------------------------
// Definitions: hash and validation
// ---------------------------------------------------------------------------

/** sha256 of the canonical JSON of a definition (`automation_versions.definition_hash`, A-2). */
export function definitionHash(def: unknown): string {
  return createHash("sha256").update(canonicalJson(def)).digest("hex");
}

/** Known `data` keys per registered event kind (edge case 22). */
export function eventDataPaths(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [kind, def] of Object.entries(EVENTS as Record<string, { data?: { shape?: Record<string, unknown> } }>)) {
    out[kind] = def.data?.shape ? Object.keys(def.data.shape) : [];
  }
  return out;
}

/** Every registered event kind, sorted (the trigger and exit pickers of the editor). */
export function eventKindOptions(): string[] {
  return Object.keys(EVENTS).sort();
}

/** The definition an automation would publish or run: draft first, else the current version. */
function parsedOrNull(json: unknown): Definition | null {
  const parsed = parseDefinition(json);
  return parsed.ok ? parsed.value : null;
}

type ValidationSubject = { id: string | null; slug: string; isMarketing: boolean; purpose: AutomationPurpose | null; groupId: string };

/** Loads the references `validateDefinition` checks against (templates, automations, tags, roles, webhook hosts). */
export async function loadValidationRefs(db: DbOrTx, subject: ValidationSubject, def: Definition): Promise<ValidationRefs> {
  const templateSlugs = referencedTemplates(def);
  const [group] = await db.select({ isExclusive: automationGroups.isExclusive }).from(automationGroups).where(eq(automationGroups.id, subject.groupId));
  const info = templateSlugs.length ? await getPublishedTemplateInfo(db, templateSlugs) : new Map<string, never>();
  const templates: Record<string, TemplateRef> = {};
  for (const [slug, t] of info) templates[slug] = { kind: t.kind, purpose: t.purpose ?? null, locales: t.locales };

  const others = await db
    .select({ slug: automations.slug, draft: automations.draftDefinition, current: automationVersions.definition })
    .from(automations)
    .leftJoin(automationVersions, eq(automationVersions.id, automations.currentVersionId));
  const automationRefs: Record<string, { reEntry: ReEntry; enrolTargets: readonly string[] }> = {};
  for (const o of others) {
    if (o.slug === subject.slug) continue;
    const d = parsedOrNull(o.current) ?? parsedOrNull(o.draft);
    automationRefs[o.slug] = d ? { reEntry: d.re_entry, enrolTargets: enrolTargets(d) } : { reEntry: "never", enrolTargets: [] };
  }
  const [tagRows, roleRows, rules] = await Promise.all([
    db.select({ key: tags.key }).from(tags),
    db.select({ key: roles.key }).from(roles),
    getSetting(db, "automation_rules"),
  ]);
  return {
    automation: { slug: subject.slug, isMarketing: subject.isMarketing, purpose: subject.purpose, isExclusiveGroup: group?.isExclusive ?? false },
    templates,
    automations: automationRefs,
    tags: tagRows.map((t) => t.key),
    roles: roleRows.map((r) => r.key),
    webhookHosts: rules.webhook_hosts,
    eventDataPaths: eventDataPaths(),
  };
}

/** Parse issues, or every `validateDefinition` finding (errors and warnings) of a draft. */
export async function draftIssues(db: DbOrTx, subject: ValidationSubject, draft: unknown): Promise<{ definition: Definition | null; issues: DefinitionIssue[] }> {
  if (draft === null || draft === undefined) return { definition: null, issues: [{ code: "invalid_definition", path: "", message: "no draft", severity: "error" }] };
  const parsed = parseDefinition(draft);
  if (!parsed.ok) return { definition: null, issues: parsed.issues };
  return { definition: parsed.value, issues: validateDefinition(parsed.value, await loadValidationRefs(db, subject, parsed.value)) };
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

const statsColumns = {
  activeCount: sql<number>`coalesce(${vAutomationStats.activeCount}, 0)`.mapWith(Number),
  completedCount: sql<number>`coalesce(${vAutomationStats.completedCount}, 0)`.mapWith(Number),
  exitedCount: sql<number>`coalesce(${vAutomationStats.exitedCount}, 0)`.mapWith(Number),
  entered7d: sql<number>`coalesce(${vAutomationStats.entered7d}, 0)`.mapWith(Number),
  sent7d: sql<number>`coalesce(${vAutomationStats.sent7d}, 0)`.mapWith(Number),
  skipped7d: sql<number>`coalesce(${vAutomationStats.skipped7d}, 0)`.mapWith(Number),
  failed7d: sql<number>`coalesce(${vAutomationStats.failed7d}, 0)`.mapWith(Number),
  lastRunAt: vAutomationStats.lastRunAt,
};

export type AutomationStats = {
  activeCount: number;
  completedCount: number;
  exitedCount: number;
  entered7d: number;
  sent7d: number;
  skipped7d: number;
  failed7d: number;
  lastRunAt: Date | null;
};

export type AutomationListRow = {
  id: string;
  slug: string;
  name: string;
  status: AutomationStatus;
  isMarketing: boolean;
  purpose: AutomationPurpose | null;
  priority: number;
  groupKey: string;
  groupName: string;
  groupIsExclusive: boolean;
  currentVersion: number | null;
} & AutomationStats;

/** The list screen: automations with group and `v_automation_stats`, by group priority, priority and slug. */
export async function listAutomations(db: DbOrTx, input: { status?: AutomationStatus; groupKey?: string; q?: string } = {}): Promise<AutomationListRow[]> {
  const term = input.q?.trim();
  return db
    .select({
      id: automations.id,
      slug: automations.slug,
      name: automations.name,
      status: automations.status,
      isMarketing: automations.isMarketing,
      purpose: automations.purpose,
      priority: automations.priority,
      groupKey: automationGroups.key,
      groupName: automationGroups.name,
      groupIsExclusive: automationGroups.isExclusive,
      currentVersion: automationVersions.version,
      ...statsColumns,
    })
    .from(automations)
    .innerJoin(automationGroups, eq(automationGroups.id, automations.groupId))
    .leftJoin(automationVersions, eq(automationVersions.id, automations.currentVersionId))
    .leftJoin(vAutomationStats, eq(vAutomationStats.automationId, automations.id))
    .where(
      and(
        input.status ? eq(automations.status, input.status) : undefined,
        input.groupKey ? eq(automationGroups.key, input.groupKey) : undefined,
        term ? or(sql`${automations.name} ilike ${`%${term}%`}`, sql`${automations.slug} ilike ${`%${term}%`}`) : undefined,
      ),
    )
    .orderBy(asc(automationGroups.priority), asc(automations.priority), asc(automations.slug));
}

export type AutomationDetail = {
  automation: typeof automations.$inferSelect;
  group: typeof automationGroups.$inferSelect;
  currentVersion: { id: string; version: number; definition: Definition | null; definitionHash: string; publishedAt: Date; changeNote: string | null } | null;
  draft: unknown;
  draftDefinition: Definition | null;
  draftIssues: DefinitionIssue[];
  /** True when the draft's canonical JSON differs from the published version's. */
  draftDiffers: boolean;
  stats: AutomationStats;
};

/** The detail and editor screens: automation, group, current version, draft with its issues, stats. Null when absent. */
export async function getAutomation(db: DbOrTx, input: { id: string }): Promise<AutomationDetail | null> {
  if (!isUuid(input.id)) return null;
  const [row] = await db
    .select({ automation: automations, group: automationGroups })
    .from(automations)
    .innerJoin(automationGroups, eq(automationGroups.id, automations.groupId))
    .where(eq(automations.id, input.id));
  if (!row) return null;
  const a = row.automation;
  const [version] = a.currentVersionId ? await db.select().from(automationVersions).where(eq(automationVersions.id, a.currentVersionId)) : [];
  const [stats] = await db.select(statsColumns).from(vAutomationStats).where(eq(vAutomationStats.automationId, a.id));
  const subject = { id: a.id, slug: a.slug, isMarketing: a.isMarketing, purpose: a.purpose, groupId: a.groupId };
  const { definition, issues } = a.draftDefinition === null ? { definition: null, issues: [] } : await draftIssues(db, subject, a.draftDefinition);
  return {
    automation: a,
    group: row.group,
    currentVersion: version
      ? { id: version.id, version: version.version, definition: parsedOrNull(version.definition), definitionHash: version.definitionHash, publishedAt: version.publishedAt, changeNote: version.changeNote }
      : null,
    draft: a.draftDefinition,
    draftDefinition: definition,
    draftIssues: issues,
    draftDiffers: a.draftDefinition !== null && (!version || definitionHash(a.draftDefinition) !== version.definitionHash),
    stats: stats ?? { activeCount: 0, completedCount: 0, exitedCount: 0, entered7d: 0, sent7d: 0, skipped7d: 0, failed7d: 0, lastRunAt: null },
  };
}

/** The "duplicate from" picker of the new-automation form. */
export async function listAutomationOptions(db: DbOrTx): Promise<{ id: string; slug: string; name: string; status: AutomationStatus }[]> {
  return db.select({ id: automations.id, slug: automations.slug, name: automations.name, status: automations.status }).from(automations).orderBy(asc(automations.slug));
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const authorName = sql<string | null>`nullif(btrim(coalesce(${users.name}, '')), '')`;

export type VersionRow = {
  id: string;
  version: number;
  publishedAt: Date;
  changeNote: string | null;
  definitionHash: string;
  authorName: string | null;
};

/** Every published version of an automation, newest first, with author, change note and definition ("Restore into draft"). */
export async function listVersions(db: DbOrTx, input: { automationId: string }): Promise<(VersionRow & { definition: unknown })[]> {
  if (!isUuid(input.automationId)) return [];
  return db
    .select({
      id: automationVersions.id,
      version: automationVersions.version,
      publishedAt: automationVersions.publishedAt,
      changeNote: automationVersions.changeNote,
      definitionHash: automationVersions.definitionHash,
      definition: automationVersions.definition,
      authorName,
    })
    .from(automationVersions)
    .leftJoin(users, eq(users.id, automationVersions.createdByUserId))
    .where(eq(automationVersions.automationId, input.automationId))
    .orderBy(desc(automationVersions.version));
}

export type VersionDetail = VersionRow & {
  automationId: string;
  definition: unknown;
  previous: { id: string; version: number } | null;
  /** `diffDefinitions(previous, this)`; every top-level field is `added` for version 1. */
  diff: DefinitionChange[];
};

/** One version with the diff from the version before it (or from `compareToId` when given). */
export async function getVersion(db: DbOrTx, input: { versionId: string; compareToId?: string }): Promise<VersionDetail | null> {
  if (!isUuid(input.versionId)) return null;
  const [v] = await db
    .select({
      id: automationVersions.id,
      automationId: automationVersions.automationId,
      version: automationVersions.version,
      publishedAt: automationVersions.publishedAt,
      changeNote: automationVersions.changeNote,
      definitionHash: automationVersions.definitionHash,
      definition: automationVersions.definition,
      authorName,
    })
    .from(automationVersions)
    .leftJoin(users, eq(users.id, automationVersions.createdByUserId))
    .where(eq(automationVersions.id, input.versionId));
  if (!v) return null;
  const [prev] = await db
    .select({ id: automationVersions.id, version: automationVersions.version, definition: automationVersions.definition })
    .from(automationVersions)
    .where(
      and(
        eq(automationVersions.automationId, v.automationId),
        isUuid(input.compareToId) ? eq(automationVersions.id, input.compareToId) : lt(automationVersions.version, v.version),
      ),
    )
    .orderBy(desc(automationVersions.version))
    .limit(1);
  const after = parsedOrNull(v.definition);
  const before = prev ? parsedOrNull(prev.definition) : null;
  let diff: DefinitionChange[] = [];
  if (after && before) diff = diffDefinitions(before, after);
  else if (after) diff = Object.entries(after).map(([path, value]) => ({ path, kind: "added" as const, after: value }));
  return { ...v, previous: prev ? { id: prev.id, version: prev.version } : null, diff };
}

// ---------------------------------------------------------------------------
// Enrolments and runs (keyset cursors: base64url of "<iso>|<id>")
// ---------------------------------------------------------------------------

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string | undefined | null): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!iso || !id || !isUuid(id) || Number.isNaN(Date.parse(iso))) return null;
  return { at: new Date(iso), id };
}

const clampLimit = (limit: number | undefined) => Math.min(Math.max(limit ?? 50, 1), 100);

export type EnrolmentRow = {
  id: string;
  personId: string;
  firstName: string | null;
  lastName: string | null;
  status: EnrolmentStatus;
  source: string;
  enteredAt: Date;
  nextStepKey: string | null;
  nextStepAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  versionNumber: number;
};

/** Enrolments of one automation, newest first, with the person's name and the next step. */
export async function listEnrolments(
  db: DbOrTx,
  input: { automationId: string; status?: EnrolmentStatus; cursor?: string; limit?: number },
): Promise<{ rows: EnrolmentRow[]; nextCursor: string | null }> {
  if (!isUuid(input.automationId)) return { rows: [], nextCursor: null };
  const limit = clampLimit(input.limit);
  const c = decodeCursor(input.cursor);
  const e = automationEnrolments;
  const rows = await db
    .select({
      id: e.id,
      personId: e.personId,
      firstName: persons.firstName,
      lastName: persons.lastName,
      status: e.status,
      source: e.source,
      enteredAt: e.enteredAt,
      nextStepKey: e.nextStepKey,
      nextStepAt: e.nextStepAt,
      endedAt: e.endedAt,
      endReason: e.endReason,
      versionNumber: automationVersions.version,
    })
    .from(e)
    .innerJoin(persons, eq(persons.id, e.personId))
    .innerJoin(automationVersions, eq(automationVersions.id, e.automationVersionId))
    .where(
      and(
        eq(e.automationId, input.automationId),
        input.status ? eq(e.status, input.status) : undefined,
        c ? or(lt(e.enteredAt, c.at), and(eq(e.enteredAt, c.at), lt(e.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(e.enteredAt), desc(e.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { rows: page, nextCursor: rows.length > limit && last ? encodeCursor(last.enteredAt, last.id) : null };
}

export type RunRow = {
  id: string;
  personId: string;
  firstName: string | null;
  lastName: string | null;
  occurredAt: Date;
  automationSlug: string;
  automationName: string;
  stepKey: string | null;
  outcome: AutomationRunOutcome;
  reason: string | null;
  endReason: string | null;
  emailMessageId: string | null;
  emailStatus: string | null;
  taskId: string | null;
};

/** The run log: `v_person_automation_timeline` rows, newest first, filtered by automation, person, outcome and period. */
export async function listRuns(
  db: DbOrTx,
  input: { automationId?: string; personId?: string; outcome?: AutomationRunOutcome; from?: Date; to?: Date; cursor?: string; limit?: number },
): Promise<{ rows: RunRow[]; nextCursor: string | null }> {
  const v = vPersonAutomationTimeline;
  const limit = clampLimit(input.limit);
  const c = decodeCursor(input.cursor);
  const where: (SQL | undefined)[] = [
    input.automationId ? (isUuid(input.automationId) ? sql`${v.automationSlug} = (select slug from automations where id = ${input.automationId})` : sql`false`) : undefined,
    input.personId ? (isUuid(input.personId) ? eq(v.personId, input.personId) : sql`false`) : undefined,
    input.outcome ? eq(v.outcome, input.outcome) : undefined,
    input.from ? gte(v.occurredAt, input.from) : undefined,
    input.to ? lte(v.occurredAt, input.to) : undefined,
    c ? or(lt(v.occurredAt, c.at), and(eq(v.occurredAt, c.at), lt(v.id, c.id))) : undefined,
  ];
  const rows = await db
    .select({
      id: v.id,
      personId: v.personId,
      firstName: persons.firstName,
      lastName: persons.lastName,
      occurredAt: v.occurredAt,
      automationSlug: v.automationSlug,
      automationName: v.automationName,
      stepKey: v.stepKey,
      outcome: v.outcome,
      reason: v.reason,
      endReason: v.endReason,
      emailMessageId: v.emailMessageId,
      emailStatus: v.emailStatus,
      taskId: v.taskId,
    })
    .from(v)
    .innerJoin(persons, eq(persons.id, v.personId))
    .where(and(...where))
    .orderBy(desc(v.occurredAt), desc(v.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { rows: page, nextCursor: rows.length > limit && last ? encodeCursor(last.occurredAt, last.id) : null };
}

// ---------------------------------------------------------------------------
// Groups, templates, segments
// ---------------------------------------------------------------------------

export type GroupRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isExclusive: boolean;
  lane: string | null;
  priority: number;
  automationCount: number;
};

/** Groups with their automation counts (archived automations excluded), by priority and key. */
export async function listGroups(db: DbOrTx): Promise<GroupRow[]> {
  return db
    .select({
      id: automationGroups.id,
      key: automationGroups.key,
      name: automationGroups.name,
      description: automationGroups.description,
      isExclusive: automationGroups.isExclusive,
      lane: automationGroups.lane,
      priority: automationGroups.priority,
      automationCount: sql<number>`(select count(*) from automations a where a.group_id = "automation_groups"."id" and a.status <> 'archived')`.mapWith(Number),
    })
    .from(automationGroups)
    .orderBy(asc(automationGroups.priority), asc(automationGroups.key));
}

export type TemplateOption = { slug: string; name: string; kind: "transactional" | "marketing"; purpose: string | null; locales: string[] };

/** Published templates for the editor's template picker (slug, kind, purpose, locales). */
export async function listTemplateOptions(db: DbOrTx, input: { q?: string } = {}): Promise<TemplateOption[]> {
  const rows = await listPublishedTemplates(db, input.q);
  return rows.map((r) => ({ slug: r.slug, name: r.name, kind: r.kind, purpose: r.purpose, locales: [...r.locales] }));
}

/** Non-archived segments with their member count, for the trigger, audience and "Enrol segment" pickers. */
export async function listSegmentOptions(db: DbOrTx): Promise<{ id: string; name: string; memberCount: number }[]> {
  return db
    .select({
      id: segments.id,
      name: segments.name,
      memberCount: sql<number>`(select count(*) from segment_members sm where sm.segment_id = "segments"."id")`.mapWith(Number),
    })
    .from(segments)
    .where(eq(segments.isArchived, false))
    .orderBy(asc(segments.name));
}

/** Tag keys for the tag picker. */
export async function listTagKeys(db: DbOrTx): Promise<string[]> {
  return (await db.select({ key: tags.key }).from(tags).orderBy(asc(tags.key))).map((t) => t.key);
}

/** Group keys and names for the group pickers. */
export async function listGroupOptions(db: DbOrTx): Promise<{ key: string; name: string; isExclusive: boolean }[]> {
  return db.select({ key: automationGroups.key, name: automationGroups.name, isExclusive: automationGroups.isExclusive }).from(automationGroups).orderBy(asc(automationGroups.priority), asc(automationGroups.key));
}

/** Active enrolments of an automation: after the next publish they all run on an older version (the publish dialog's "migrate N"). */
export async function countMigratableEnrolments(db: DbOrTx, automationId: string): Promise<number> {
  if (!isUuid(automationId)) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(automationEnrolments)
    .where(and(eq(automationEnrolments.automationId, automationId), eq(automationEnrolments.status, "active")));
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Labels for the screens
// ---------------------------------------------------------------------------

/**
 * The `automation` catalogue strings under the given prefixes (`["editor", "issue"]`), flattened
 * and keyed without `automation.` (`editor.save`), for client components that receive their
 * strings as props.
 */
export function automationLabels(locale: Locale, prefixes: readonly string[]): Record<string, string> {
  const tree = (messagesFor(locale, ["automation"]) as Record<string, unknown>).automation as Record<string, unknown> | undefined;
  const out: Record<string, string> = {};
  const walk = (node: unknown, path: string) => {
    if (typeof node === "string") out[path] = node;
    else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  };
  for (const p of prefixes) walk(tree?.[p], p);
  return out;
}

// ---------------------------------------------------------------------------
// Person page (automation-P6, A-36 to A-41)
// ---------------------------------------------------------------------------

export type PersonEnrolmentView = PersonEnrolmentSummary & {
  automationId: string;
  isMarketing: boolean;
  source: string;
  /** The pending steps of an active enrolment's plan (waits left out), in plan order. */
  remaining: PlannedStep[];
};

export type PersonAutomations = { active: PersonEnrolmentView[]; ended: PersonEnrolmentView[]; runs: AutomationTimelineItem[] };

/** `getPersonAutomations` (4.2): active enrolments with their remaining plan, the last 20 ended ones and the last 100 runs. */
export async function getPersonAutomations(db: DbOrTx, input: { personId: string }): Promise<PersonAutomations> {
  if (!isUuid(input.personId)) return { active: [], ended: [], runs: [] };
  const e = automationEnrolments;
  const select = {
    enrolmentId: e.id,
    automationId: e.automationId,
    automationSlug: automations.slug,
    automationName: automations.name,
    isMarketing: automations.isMarketing,
    status: e.status,
    source: e.source,
    enteredAt: e.enteredAt,
    endedAt: e.endedAt,
    endReason: e.endReason,
    nextStepKey: e.nextStepKey,
    nextStepAt: e.nextStepAt,
    plan: e.plan,
  };
  const [activeRows, endedRows, runs] = await Promise.all([
    db
      .select(select)
      .from(e)
      .innerJoin(automations, eq(automations.id, e.automationId))
      .where(and(eq(e.personId, input.personId), eq(e.status, "active")))
      .orderBy(desc(e.enteredAt), desc(e.id)),
    db
      .select(select)
      .from(e)
      .innerJoin(automations, eq(automations.id, e.automationId))
      .where(and(eq(e.personId, input.personId), ne(e.status, "active")))
      .orderBy(desc(e.endedAt), desc(e.id))
      .limit(20),
    personTimeline(db, input.personId, 100),
  ]);
  const view = ({ plan, ...r }: (typeof activeRows)[number]): PersonEnrolmentView => ({
    ...r,
    remaining: r.status === "active" ? plan.filter((p) => p.state === "pending" && p.type !== "wait") : [],
  });
  return { active: activeRows.map(view), ended: endedRows.map(view), runs };
}

/** The automation timeline of a person (A-41): every run row, newest first. */
async function personTimeline(db: DbOrTx, personId: string, limit: number): Promise<AutomationTimelineItem[]> {
  const v = vPersonAutomationTimeline;
  return db
    .select({
      id: v.id,
      occurredAt: v.occurredAt,
      automationSlug: v.automationSlug,
      automationName: v.automationName,
      stepKey: v.stepKey,
      outcome: v.outcome,
      reason: v.reason,
      endReason: v.endReason,
      emailMessageId: v.emailMessageId,
      emailStatus: v.emailStatus,
      taskId: v.taskId,
    })
    .from(v)
    .where(eq(v.personId, personId))
    .orderBy(desc(v.occurredAt), desc(v.id))
    .limit(limit);
}

/** `previewEnrolment` (4.2, A-39): the predicted outcome per step, read-only. */
export function previewEnrolment(db: DbOrTx, input: { personId: string; automationId: string; anchorAt?: Date }, now: Date = new Date()): Promise<PreviewStep[]> {
  return previewSteps(db, { ...input, now });
}

/** A warning the enrol dialog shows before a staff enrolment (A-37, edge case 20); only `restricted` refuses the entry. */
export type EnrolWarning = "audience" | "unreachable" | "already_active" | "exclusive" | "restricted";

export type EnrolOption = {
  id: string;
  slug: string;
  name: string;
  isMarketing: boolean;
  /** The definition has a data anchor: the dialog asks for it (A-37). */
  needsAnchor: boolean;
  warnings: EnrolWarning[];
};

/**
 * The automations staff can enrol the person into (every `active` one with a published version),
 * each with the warnings of A-37: audience mismatch, marketing purpose not reachable (its steps
 * will be skipped; consent is never bypassed), already in it, the exclusive domain is held by
 * another journey (that one exits `moved`), processing restricted (a marketing journey refuses).
 */
export async function listEnrolOptions(db: DbOrTx, input: { personId: string }): Promise<EnrolOption[]> {
  if (!isUuid(input.personId)) return [];
  const [person] = await db.select({ locale: persons.locale, restrictedAt: persons.processingRestrictedAt }).from(persons).where(eq(persons.id, input.personId));
  if (!person) return [];
  const list = (await loadAutomations(db as Tx, { statuses: ["active"] })).filter((a) => a.definition);
  if (!list.length) return [];
  const names = new Map(
    (await db.select({ id: automations.id, name: automations.name }).from(automations).where(inArray(automations.id, list.map((a) => a.id)))).map((r) => [r.id, r.name]),
  );
  const [statusRow] = await db.select({ status: vPersonStatus.status }).from(vPersonStatus).where(eq(vPersonStatus.personId, input.personId));
  const segmentIds = new Set(
    (await db.select({ id: segmentMembers.segmentId }).from(segmentMembers).where(eq(segmentMembers.personId, input.personId))).map((r) => r.id),
  );
  const active = await db
    .select({ automationId: automationEnrolments.automationId, domain: automationEnrolments.exclusiveDomain })
    .from(automationEnrolments)
    .where(and(eq(automationEnrolments.personId, input.personId), eq(automationEnrolments.status, "active")));
  const reach = new Map<AutomationPurpose, boolean>();
  const reachable = async (purpose: AutomationPurpose) => {
    if (!reach.has(purpose)) reach.set(purpose, (await getReachability(db, input.personId, purpose)).isReachable);
    return reach.get(purpose)!;
  };
  const out: EnrolOption[] = [];
  for (const a of list) {
    const def = a.definition!;
    const warnings: EnrolWarning[] = [];
    const aud = def.audience;
    const inAudience =
      !aud ||
      ((!aud.locales?.length || (aud.locales as readonly string[]).includes(person.locale)) &&
        (!aud.status?.length || (!!statusRow && aud.status.includes(statusRow.status))) &&
        (!aud.segment_id || segmentIds.has(aud.segment_id)) &&
        !(aud.exclude_segment_ids ?? []).some((id) => segmentIds.has(id)));
    if (!inAudience) warnings.push("audience");
    if (a.isMarketing && person.restrictedAt) warnings.push("restricted");
    if (a.isMarketing && a.purpose && !(await reachable(a.purpose))) warnings.push("unreachable");
    if (active.some((r) => r.automationId === a.id)) warnings.push("already_active");
    const domain = exclusiveDomain({ key: a.groupKey, isExclusive: a.isExclusive, lane: a.lane });
    if (domain && active.some((r) => r.domain === domain && r.automationId !== a.id)) warnings.push("exclusive");
    out.push({ id: a.id, slug: a.slug, name: names.get(a.id) ?? a.slug, isMarketing: a.isMarketing, needsAnchor: def.anchor !== "enrolment", warnings });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

// ---------------------------------------------------------------------------
// Conflict report (automation-P7, R2; `automations.publish`)
// ---------------------------------------------------------------------------

export type ConflictAutomation = { id: string; slug: string; name: string; groupKey: string };

export type ConflictPair = {
  /** The journey that lost: refused at entry (`skipped_exclusive`) or ended (`superseded`). */
  blocked: ConflictAutomation;
  /** The journey that held or took the exclusive domain. */
  blocking: ConflictAutomation;
  skippedExclusive: number;
  superseded: number;
  total: number;
  lastAt: Date;
  /** Up to five persons, most recent first; empty when the caller may not see person data. */
  samplePersons: { id: string; name: string | null }[];
};

export type ConflictReport = { days: 7 | 30; since: Date; pairs: ConflictPair[]; totals: { skippedExclusive: number; superseded: number } };

export const CONFLICT_SAMPLE_SIZE = 5;

type ConflictSqlRow = {
  blocked_id: string;
  blocking_id: string;
  skipped: number | string;
  superseded: number | string;
  last_at: string | Date;
  person_ids: string[] | string | null;
};

/** Postgres text arrays arrive as arrays from node-postgres and as `{a,b}` text from some drivers. */
function textArray(v: string[] | string | null): string[] {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  return v.replace(/^\{|\}$/g, "").split(",").filter(Boolean);
}

/**
 * Which journeys block or supersede which in the last `days` days (spec 4.2, A-15): one row per
 * (blocked, blocking) pair with the count of `skipped_exclusive` entry runs (the candidate was
 * refused because the blocking journey held the domain; the holder is the enrolment in
 * `data.blocking_enrolment_id`, else the slug in the reason `blocked_by:<slug>`) and of
 * `superseded` exits (the blocked journey's enrolment ended because the blocking one entered;
 * `data.superseded_by`). Staff moves (`moved`) are not conflicts. Most conflicts first.
 */
export async function getConflictReport(db: DbOrTx, input: { days: 7 | 30; includePersons?: boolean }, now: Date = new Date()): Promise<ConflictReport> {
  const days = input.days === 30 ? 30 : 7;
  const since = new Date(now.getTime() - days * 86_400_000);
  const sinceIso = since.toISOString();
  const rows = rowsOf<ConflictSqlRow>(
    await db.execute(sql`
      with x as (
        select r.automation_id as blocked_id,
               coalesce(h.automation_id, (select a.id from automations a where a.slug = substring(r.reason from '^blocked_by:(.+)$'))) as blocking_id,
               'skipped_exclusive' as kind, r.person_id, r.occurred_at
          from automation_runs r
          left join automation_enrolments h on h.id::text = r.data ->> 'blocking_enrolment_id'
         where r.outcome = 'skipped_exclusive' and r.occurred_at >= ${sinceIso}::timestamptz
        union all
        select r.automation_id, w.automation_id, 'superseded', r.person_id, r.occurred_at
          from automation_runs r
          join automation_enrolments w on w.id::text = r.data ->> 'superseded_by'
         where r.outcome = 'exited' and r.reason = 'superseded' and r.occurred_at >= ${sinceIso}::timestamptz
      )
      select blocked_id::text as blocked_id, blocking_id::text as blocking_id,
             count(*) filter (where kind = 'skipped_exclusive') as skipped,
             count(*) filter (where kind = 'superseded') as superseded,
             max(occurred_at) as last_at,
             (array_agg(person_id::text order by occurred_at desc))[1:50] as person_ids
        from x
       where blocking_id is not null
       group by blocked_id, blocking_id`),
  );
  if (!rows.length) return { days, since, pairs: [], totals: { skippedExclusive: 0, superseded: 0 } };

  const ids = [...new Set(rows.flatMap((r) => [r.blocked_id, r.blocking_id]))];
  const autos = await db
    .select({ id: automations.id, slug: automations.slug, name: automations.name, groupKey: automationGroups.key })
    .from(automations)
    .innerJoin(automationGroups, eq(automationGroups.id, automations.groupId))
    .where(inArray(automations.id, ids));
  const byId = new Map(autos.map((a) => [a.id, a]));

  const samples = new Map<string, string[]>();
  for (const r of rows) samples.set(`${r.blocked_id}:${r.blocking_id}`, [...new Set(textArray(r.person_ids))].slice(0, CONFLICT_SAMPLE_SIZE));
  const personIds = input.includePersons ? [...new Set([...samples.values()].flat())] : [];
  const people = personIds.length
    ? await db
        .select({ id: persons.id, firstName: persons.firstName, lastName: persons.lastName, erasedAt: persons.erasedAt })
        .from(persons)
        .where(inArray(persons.id, personIds))
    : [];
  const nameOf = new Map(people.map((p) => [p.id, p.erasedAt ? null : [p.firstName, p.lastName].filter(Boolean).join(" ") || null]));

  const pairs: ConflictPair[] = [];
  for (const r of rows) {
    const blocked = byId.get(r.blocked_id);
    const blocking = byId.get(r.blocking_id);
    if (!blocked || !blocking) continue;
    const skippedExclusive = Number(r.skipped);
    const superseded = Number(r.superseded);
    pairs.push({
      blocked,
      blocking,
      skippedExclusive,
      superseded,
      total: skippedExclusive + superseded,
      lastAt: new Date(r.last_at),
      samplePersons: input.includePersons ? (samples.get(`${r.blocked_id}:${r.blocking_id}`) ?? []).map((id) => ({ id, name: nameOf.get(id) ?? null })) : [],
    });
  }
  pairs.sort((a, b) => b.total - a.total || b.lastAt.getTime() - a.lastAt.getTime() || a.blocked.slug.localeCompare(b.blocked.slug) || a.blocking.slug.localeCompare(b.blocking.slug));
  return {
    days,
    since,
    pairs,
    totals: { skippedExclusive: pairs.reduce((n, p) => n + p.skippedExclusive, 0), superseded: pairs.reduce((n, p) => n + p.superseded, 0) },
  };
}

// ---------------------------------------------------------------------------
// Rules page (automation-P7, R2)
// ---------------------------------------------------------------------------

export type AutomationRulesView = {
  version: number;
  maxMarketingPerDay: number;
  maxMarketingPerWeek: number;
  quietStart: string;
  quietEnd: string;
  webhookHosts: string[];
};

/** `settings.automation_rules` with its version, in the shape of `updateAutomationRules`. */
export async function getAutomationRules(db: DbOrTx): Promise<AutomationRulesView> {
  const { value, version } = await getSettingWithVersion(db, "automation_rules");
  const v = value;
  return {
    version,
    maxMarketingPerDay: v.max_marketing_per_day,
    maxMarketingPerWeek: v.max_marketing_per_week,
    quietStart: v.quiet_start,
    quietEnd: v.quiet_end,
    webhookHosts: [...v.webhook_hosts],
  };
}
