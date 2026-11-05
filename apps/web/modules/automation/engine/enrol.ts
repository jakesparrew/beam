/**
 * Enrolment (A-11 to A-19, A-37). `enrol` runs inside the caller's transaction and holds the
 * person row lock (`SELECT id FROM persons WHERE id = $1 FOR UPDATE`) for the whole decision.
 *
 * Order of the checks: automation active; the same trigger event already enrolled (a re-read,
 * no row); person erased or merged (A-11); processing restricted for a marketing automation
 * (`skipped_unreachable`, reason `restricted`); audience (A-12, no row); re-entry (A-13, no row);
 * marketing reachability (A-14, `skipped_unreachable`); anchor (A-16, `failed`); exclusivity
 * (A-15, `skipped_exclusive` or `superseded`); then planning (A-17, A-18) and the entry runs (A-19).
 *
 * Staff entries (`override: true`, A-37) skip audience, re-entry and the entry reachability
 * check (marketing steps are still checked at send time), and a blocking enrolment in the
 * exclusive domain exits with `moved` instead of deciding by priority.
 */
import { randomUUID } from "node:crypto";
import type { Tx } from "@beam/db";
import {
  automationEnrolments,
  automationGroups,
  automations,
  automationVersions,
  persons,
  segmentMembers,
  vPersonStatus,
  type EnrolmentContextJson,
} from "@beam/db/schema";
import {
  canReEnter,
  eventSubjectKey,
  exclusiveDomain,
  planSteps,
  readPath,
  resolveExclusivity,
  startPlan,
  type AutomationPurpose,
  type Definition,
  type EnrolResult,
  type EventView,
} from "@beam/core/automation";
import { and, desc, eq, inArray, type Actor } from "@/lib/ctx";
import { getReachability } from "@/modules/email/api";
import { endEnrolmentWith, versionDefinition } from "./exits";
import { entryDedupeKey, runDedupeKey, writeRun } from "./runs";

/**
 * The row lock the engine takes on `persons` (A-11). It conflicts with every other person lock
 * and with any `update persons`, so enrolments, merges and erasure of one person stay serial,
 * but not with the `for key share` lock of a foreign key (see `enrol`).
 */
export const PERSON_LOCK = "no key update" as const;

export type EnrolSource = "trigger" | "segment" | "staff" | "staff_move" | "enrol_step" | "migration" | "api";

/** An automation with what the engine needs (current version parsed, group rank). */
export type EngineAutomation = {
  id: string;
  slug: string;
  status: "draft" | "active" | "paused" | "archived";
  isMarketing: boolean;
  purpose: AutomationPurpose | null;
  priority: number;
  requiresDpia: string | null;
  requiresFlag: string | null;
  groupId: string;
  groupKey: string;
  groupPriority: number;
  isExclusive: boolean;
  lane: string | null;
  versionId: string | null;
  definition: Definition | null;
};

export type EnrolInput = {
  /** The automation id, or a loaded automation (the evaluator passes its run's list). */
  automation: string | EngineAutomation;
  personId: string;
  source: EnrolSource;
  actor: Actor;
  now: Date;
  /** The trigger event (`trigger` and `segment` sources): anchor, subject and context come from it. */
  event?: EventView | null;
  /** An explicit anchor (staff, `api`); overrides the event path. */
  anchorAt?: Date | null;
  /** An explicit subject key (staff, `api`) when the definition has no `subject: ref` event. */
  subjectKey?: string;
  vars?: Record<string, string | number | boolean | null>;
  enteredByUserId?: string | null;
  /** Staff override of audience, re-entry, entry reachability and exclusivity priority (A-37). */
  override?: boolean;
};

const automationColumns = {
  id: automations.id,
  slug: automations.slug,
  status: automations.status,
  isMarketing: automations.isMarketing,
  purpose: automations.purpose,
  priority: automations.priority,
  requiresDpia: automations.requiresDpia,
  requiresFlag: automations.requiresFlag,
  groupId: automations.groupId,
  groupKey: automationGroups.key,
  groupPriority: automationGroups.priority,
  isExclusive: automationGroups.isExclusive,
  lane: automationGroups.lane,
  versionId: automations.currentVersionId,
  definitionJson: automationVersions.definition,
};

type AutomationRow = { [K in keyof typeof automationColumns]: unknown } & Record<string, unknown>;

function toEngine(r: AutomationRow): EngineAutomation {
  const { definitionJson, ...rest } = r as unknown as Omit<EngineAutomation, "definition"> & { definitionJson: unknown };
  return { ...rest, definition: rest.versionId ? versionDefinition(rest.versionId, definitionJson) : null };
}

/** Loads automations (current version parsed) by id, by slug, or every one with a status. */
export async function loadAutomations(tx: Tx, where: { ids?: string[]; slugs?: string[]; statuses?: EngineAutomation["status"][] }): Promise<EngineAutomation[]> {
  const conds = [
    where.ids ? inArray(automations.id, where.ids) : undefined,
    where.slugs ? inArray(automations.slug, where.slugs) : undefined,
    where.statuses ? inArray(automations.status, where.statuses) : undefined,
  ].filter((c) => c !== undefined);
  const rows = await tx
    .select(automationColumns)
    .from(automations)
    .innerJoin(automationGroups, eq(automationGroups.id, automations.groupId))
    .leftJoin(automationVersions, eq(automationVersions.id, automations.currentVersionId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(automations.slug);
  return rows.map((r) => toEngine(r as AutomationRow));
}

const skipped = (outcome: Extract<EnrolResult, { status: "skipped" }>["outcome"]): EnrolResult => ({ status: "skipped", outcome });

function parseAnchor(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function triggerContext(ev: EventView): NonNullable<EnrolmentContextJson["trigger"]> {
  return { event_id: ev.id.toString(), kind: ev.kind, ref_type: ev.refType ?? null, ref_id: ev.refId ?? null, mode: ev.mode ?? null, data: ev.data };
}

/** A-12: status, segment, exclusions and locales; true when the person is in the audience. */
async function inAudience(tx: Tx, def: Definition, personId: string, locale: string): Promise<boolean> {
  const audience = def.audience;
  if (!audience) return true;
  if (audience.locales?.length && !audience.locales.includes(locale as never)) return false;
  if (audience.status?.length) {
    const [row] = await tx.select({ status: vPersonStatus.status }).from(vPersonStatus).where(eq(vPersonStatus.personId, personId));
    if (!row || !audience.status.includes(row.status)) return false;
  }
  const segmentIds = [...(audience.segment_id ? [audience.segment_id] : []), ...(audience.exclude_segment_ids ?? [])];
  if (!segmentIds.length) return true;
  const members = await tx
    .select({ segmentId: segmentMembers.segmentId })
    .from(segmentMembers)
    .where(and(eq(segmentMembers.personId, personId), inArray(segmentMembers.segmentId, segmentIds)));
  const inSet = new Set(members.map((m) => m.segmentId));
  if (audience.segment_id && !inSet.has(audience.segment_id)) return false;
  return !(audience.exclude_segment_ids ?? []).some((id) => inSet.has(id));
}

/** A-13 history: latest entry and any entry of this automation, and an active one for the subject. */
async function entryHistory(tx: Tx, automationId: string, personId: string, subjectKey: string) {
  const rows = await tx
    .select({ enteredAt: automationEnrolments.enteredAt, status: automationEnrolments.status, subjectKey: automationEnrolments.subjectKey })
    .from(automationEnrolments)
    .where(and(eq(automationEnrolments.automationId, automationId), eq(automationEnrolments.personId, personId)))
    .orderBy(desc(automationEnrolments.enteredAt));
  return {
    lastEnteredAt: rows[0]?.enteredAt ?? null,
    everEntered: rows.length > 0,
    hasActive: rows.some((r) => r.status === "active" && r.subjectKey === subjectKey),
  };
}

/** The active enrolment holding an exclusive domain for the person, with its rank (locked). */
async function domainHolder(tx: Tx, personId: string, domain: string) {
  const [row] = await tx
    .select({
      enrolmentId: automationEnrolments.id,
      slug: automations.slug,
      automationPriority: automations.priority,
      groupPriority: automationGroups.priority,
    })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .innerJoin(automationGroups, eq(automationGroups.id, automationEnrolments.groupId))
    .where(
      and(
        eq(automationEnrolments.personId, personId),
        eq(automationEnrolments.exclusiveDomain, domain),
        eq(automationEnrolments.status, "active"),
      ),
    )
    .for("update", { of: automationEnrolments });
  return row ?? null;
}

/** Enrols a person into an automation under every entry rule (section header). */
export async function enrol(tx: Tx, input: EnrolInput): Promise<EnrolResult> {
  const a = typeof input.automation === "string" ? (await loadAutomations(tx, { ids: [input.automation] }))[0] : input.automation;
  if (!a || a.status !== "active" || !a.versionId || !a.definition) return skipped("inactive");
  const def = a.definition;
  const ev = input.event ?? null;
  const versionId = a.versionId;
  const base = { personId: input.personId, automationId: a.id, automationVersionId: versionId, actor: input.actor };
  const entryKey = ev ? entryDedupeKey(a.id, ev.id) : null;

  if (ev && (input.source === "trigger" || input.source === "segment")) {
    const [done] = await tx
      .select({ id: automationEnrolments.id })
      .from(automationEnrolments)
      .where(and(eq(automationEnrolments.automationId, a.id), eq(automationEnrolments.triggerEventId, BigInt(ev.id))));
    if (done) return skipped("re_entry");
  }

  // A-11: the person lock, erased and merged persons, restriction for marketing.
  // `no key update`, not `update`: it still serialises enrolments and person writes, but not the
  // `for key share` locks that every insert referencing the person takes (activity_events,
  // person_stats, ...). With `for update`, the evaluator (one transaction holding several person
  // locks) deadlocked with ops.refresh_recent_stats upserting person_stats for the same persons.
  const [person] = await tx
    .select({ id: persons.id, erasedAt: persons.erasedAt, mergedInto: persons.mergedIntoPersonId, restrictedAt: persons.processingRestrictedAt, locale: persons.locale })
    .from(persons)
    .where(eq(persons.id, input.personId))
    .for(PERSON_LOCK);
  if (!person || person.erasedAt || person.mergedInto) return skipped("audience");
  if (a.isMarketing && person.restrictedAt) {
    await writeRun(tx, { ...base, enrolmentId: null, outcome: "skipped_unreachable", reason: "restricted", dedupeKey: entryKey });
    return skipped("skipped_unreachable");
  }

  const subjectKey = def.subject === "ref" && ev ? eventSubjectKey(ev) : (input.subjectKey ?? "");

  if (!input.override) {
    if (!(await inAudience(tx, def, person.id, person.locale))) return skipped("audience");
    const history = await entryHistory(tx, a.id, person.id, subjectKey);
    if (!canReEnter(def.re_entry, history, input.now)) return skipped("re_entry");
    // A-14: marketing reachability for the automation purpose.
    const requireReachable = def.audience?.require_reachable ?? a.isMarketing;
    if (requireReachable && a.purpose) {
      const reach = await getReachability(tx, person.id, a.purpose);
      if (!reach.isReachable) {
        await writeRun(tx, {
          ...base,
          enrolmentId: null,
          outcome: "skipped_unreachable",
          reason: `purpose ${a.purpose} not reachable${reach.blockedReason ? `: ${reach.blockedReason}` : ""}`,
          dedupeKey: entryKey,
        });
        return skipped("skipped_unreachable");
      }
    }
  } else {
    const history = await entryHistory(tx, a.id, person.id, subjectKey);
    if (history.hasActive) return skipped("re_entry");
  }

  // A-16: the anchor.
  let anchorAt: Date | null = null;
  if (def.anchor !== "enrolment") {
    anchorAt = input.anchorAt ?? (ev ? parseAnchor(readPath(ev, def.anchor)) : null);
    if (!anchorAt) {
      await writeRun(tx, { ...base, enrolmentId: null, outcome: "failed", reason: "anchor_missing", data: ev ? { event_id: ev.id.toString() } : {}, dedupeKey: entryKey });
      return skipped("anchor_missing");
    }
  }

  // A-15: exclusivity inside the domain.
  const enrolmentId = randomUUID();
  const domain = exclusiveDomain({ key: a.groupKey, isExclusive: a.isExclusive, lane: a.lane });
  if (domain) {
    const holder = await domainHolder(tx, person.id, domain);
    if (holder) {
      const decision = input.override
        ? "moved"
        : resolveExclusivity({ groupPriority: a.groupPriority, automationPriority: a.priority }, { ...holder });
      if (decision === "skip") {
        await writeRun(tx, { ...base, enrolmentId: null, outcome: "skipped_exclusive", reason: `blocked_by:${holder.slug}`, data: { blocking_enrolment_id: holder.enrolmentId }, dedupeKey: entryKey });
        return skipped("skipped_exclusive");
      }
      await endEnrolmentWith(tx, holder.enrolmentId, "exited", decision === "moved" ? "moved" : "superseded", input.actor, { superseded_by: enrolmentId });
    }
  }

  // A-17 to A-19: plan, insert, log.
  const enteredAt = input.now;
  const planned = planSteps(def, { enteredAt, anchorAt });
  const { plan, next } = startPlan(planned);
  const context: EnrolmentContextJson = { ...(ev ? { trigger: triggerContext(ev) } : {}), subject: subjectKey, vars: input.vars ?? {} };
  const completed = next === null;
  const inserted = await tx
    .insert(automationEnrolments)
    .values({
      id: enrolmentId,
      automationId: a.id,
      automationVersionId: versionId,
      personId: person.id,
      subjectKey,
      groupId: a.groupId,
      exclusiveDomain: domain,
      source: input.source,
      triggerEventId: ev && (input.source === "trigger" || input.source === "segment") ? BigInt(ev.id) : null,
      anchorAt,
      status: completed ? "completed" : "active",
      nextStepKey: next?.key ?? null,
      nextStepAt: next ? new Date(next.due_at) : null,
      enteredAt,
      endedAt: completed ? enteredAt : null,
      endReason: completed ? "anchor_passed" : null,
      plan,
      context,
      enteredByUserId: input.enteredByUserId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: automationEnrolments.id });
  if (!inserted.length) return skipped("re_entry");

  const run = { ...base, enrolmentId };
  await writeRun(tx, { ...run, outcome: "entered", reason: input.source, data: ev ? { trigger_event_id: ev.id.toString() } : {}, dedupeKey: runDedupeKey(enrolmentId, null, "entered"), occurredAt: enteredAt });
  for (const p of plan) {
    if (p.state !== "skipped") continue;
    await writeRun(tx, { ...run, stepKey: p.key, outcome: "skipped_late_entry", reason: `due ${p.due_at} before entry`, data: { due_at: p.due_at }, dedupeKey: runDedupeKey(enrolmentId, p.key, "skipped_late_entry"), occurredAt: enteredAt });
  }
  if (next) {
    await writeRun(tx, { ...run, stepKey: next.key, outcome: "scheduled", data: { due_at: next.due_at }, dedupeKey: runDedupeKey(enrolmentId, next.key, "scheduled"), occurredAt: enteredAt });
  } else {
    await writeRun(tx, { ...run, outcome: "completed", reason: "anchor_passed", dedupeKey: runDedupeKey(enrolmentId, null, "completed"), occurredAt: enteredAt });
  }
  return { status: "enrolled", enrolmentId };
}

/** The statuses whose definitions count as "in use" (A-5: archived ones do not). */
export const IN_USE_STATUSES = ["draft", "active", "paused"] as const;
