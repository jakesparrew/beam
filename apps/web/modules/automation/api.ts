/**
 * automation's cross-module door (automation spec 4.7, 02-data-model section 6.9). automation-P2
 * implements every function. `PersonAutomationsPanel` is automation-P4's read-only interim
 * panel (platform-P7 request: no throwing stand-in); automation-P6 replaces it with
 * `export { PersonAutomationsPanel } from './ui/person-automations-panel'` (staff controls,
 * preview drawer, outcome filters).
 */
import { createElement as el, type ReactElement, type ReactNode } from "react";
import type { DbOrTx, Tx } from "@beam/db";
import {
  automationEnrolments,
  automationRuns,
  automations,
  automationVersions,
  vPersonAutomationTimeline,
} from "@beam/db/schema";
import { formatDateTime, type Locale } from "@beam/core/i18n";
import type { AutomationTimelineItem, EnrolResult, PersonEnrolmentSummary } from "@beam/core/automation";
import { and, desc, enqueueJob, eq, getAppDb, gt, inArray, lt, sql, type Actor, type Ctx } from "@/lib/ctx";
import { evaluatorLagSeconds } from "./engine/cursor";
import { enrol, IN_USE_STATUSES, loadAutomations } from "./engine/enrol";
import { exitPersonEnrolments as exitAll } from "./engine/exits";

export type { AutomationRunOutcome, AutomationTimelineItem, EnrolResult, PersonEnrolmentSummary } from "@beam/core/automation";
export { endEnrolment } from "./engine/exits";

const SYSTEM: Actor = { kind: "system", jobId: "" };

/** Called only by crm.addSuppression in the transaction that inserts the suppression (D8): enqueues `automation.exit_for_suppression`. */
export async function requestSuppressionExit(tx: Tx, input: { suppressionId: string }): Promise<{ jobId: string | null }> {
  const { id } = await enqueueJob(tx, {
    kind: "automation.exit_for_suppression",
    payload: { suppressionId: input.suppressionId },
    key: `supp:${input.suppressionId}`,
    lane: "fast",
  });
  return { jobId: id };
}

/** Called by crm merge (loser, 'merged') and by this module's privacy erase ('erased'). */
export function exitPersonEnrolments(
  tx: Tx,
  input: { personId: string; reason: "erased" | "merged" | "manual" | "restricted" | "objected"; onlyMarketing?: boolean; actor: Actor },
): Promise<{ exited: number }> {
  return exitAll(tx, input);
}

/** Ops' restriction and objection transaction (ops rules 65, 66): ends marketing journeys only. */
export function exitAllForPerson(tx: Tx, ctx: Ctx, personId: string, reason: "restricted" | "objected"): Promise<{ exited: number }> {
  return exitAll(tx, { personId, reason, onlyMarketing: true, actor: ctx.actor });
}

/** Enrol from another module (forms R2 outcomes, site, crm R3): source `api`, every entry rule applies. */
export async function enrolPersonBySlug(
  tx: Tx,
  input: { slug: string; personId: string; anchorAt?: Date; subjectKey?: string; context?: Record<string, string | number | boolean | null> },
): Promise<EnrolResult> {
  const [automation] = await loadAutomations(tx, { slugs: [input.slug] });
  if (!automation) return { status: "skipped", outcome: "inactive" };
  return enrol(tx, {
    automation,
    personId: input.personId,
    source: "api",
    actor: SYSTEM,
    now: new Date(),
    anchorAt: input.anchorAt ?? null,
    ...(input.subjectKey !== undefined ? { subjectKey: input.subjectKey } : {}),
    ...(input.context ? { vars: input.context } : {}),
  });
}

/** The current-version and draft definitions of every draft, active or paused automation. */
async function inUseDefinitions(db: DbOrTx): Promise<unknown[]> {
  const rows = await db
    .select({ draft: automations.draftDefinition, current: automationVersions.definition })
    .from(automations)
    .leftJoin(automationVersions, eq(automationVersions.id, automations.currentVersionId))
    .where(inArray(automations.status, [...IN_USE_STATUSES]));
  return rows.flatMap((r) => [r.current, r.draft].filter((d) => d !== null && d !== undefined));
}

/** Walks a definition (parsed or a draft with issues) and calls `visit` for every object. */
function walk(value: unknown, visit: (obj: Record<string, unknown>) => boolean): boolean {
  if (Array.isArray(value)) return value.some((v) => walk(v, visit));
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return visit(obj) || Object.values(obj).some((v) => walk(v, visit));
}

/** Called by email before archiving a template (email rule 15). */
export async function isTemplateInUse(tx: DbOrTx, templateSlug: string): Promise<boolean> {
  return (await inUseDefinitions(tx)).some((def) => walk(def, (o) => o.type === "email" && o.template === templateSlug));
}

/** Called by crm's archiveSegment guard: trigger, audience, exclusions or an `in_segment` condition. */
export async function isSegmentInUse(db: DbOrTx, segmentId: string): Promise<boolean> {
  return (await inUseDefinitions(db)).some((def) =>
    walk(
      def,
      (o) =>
        o.segment_enter === segmentId ||
        o.segment_id === segmentId ||
        o.in_segment === segmentId ||
        (Array.isArray(o.exclude_segment_ids) && o.exclude_segment_ids.includes(segmentId)),
    ),
  );
}

export async function listPersonEnrolments(db: DbOrTx, personId: string): Promise<PersonEnrolmentSummary[]> {
  return db
    .select({
      enrolmentId: automationEnrolments.id,
      automationSlug: automations.slug,
      automationName: automations.name,
      status: automationEnrolments.status,
      enteredAt: automationEnrolments.enteredAt,
      endedAt: automationEnrolments.endedAt,
      endReason: automationEnrolments.endReason,
      nextStepKey: automationEnrolments.nextStepKey,
      nextStepAt: automationEnrolments.nextStepAt,
    })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .where(eq(automationEnrolments.personId, personId))
    .orderBy(desc(automationEnrolments.enteredAt), desc(automationEnrolments.id));
}

/** Merged into the crm person timeline, newest first (default 100, at most 500). */
export async function getTimelineItems(db: DbOrTx, personId: string, opts: { before?: Date; limit?: number } = {}): Promise<AutomationTimelineItem[]> {
  const v = vPersonAutomationTimeline;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
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
    .where(and(eq(v.personId, personId), opts.before ? lt(v.occurredAt, opts.before) : undefined))
    .orderBy(desc(v.occurredAt), desc(v.id))
    .limit(limit);
}

export async function hasActiveEnrolment(db: DbOrTx, personId: string, slug: string): Promise<boolean> {
  const [row] = await db
    .select({ id: automationEnrolments.id })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .where(and(eq(automationEnrolments.personId, personId), eq(automations.slug, slug), eq(automationEnrolments.status, "active")))
    .limit(1);
  return !!row;
}

/** Stuck: an active enrolment of an active automation more than 30 minutes past `next_step_at` (A-45). */
export const STUCK_AFTER_MS = 30 * 60_000;

/** Read by ops.daily_digest and the System page (A-45). */
export async function countAutomationIssues(
  db: DbOrTx,
  since: Date,
): Promise<{ failed: number; skippedTranslation: number; stuck: number; evaluatorLagSeconds: number }> {
  const now = new Date();
  const [runs] = await db
    .select({
      failed: sql<number>`count(*) filter (where ${automationRuns.outcome} = 'failed')`.mapWith(Number),
      skippedTranslation: sql<number>`count(*) filter (where ${automationRuns.outcome} = 'skipped_translation')`.mapWith(Number),
    })
    .from(automationRuns)
    .where(and(gt(automationRuns.occurredAt, since), inArray(automationRuns.outcome, ["failed", "skipped_translation"])));
  const [stuck] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .where(
      and(
        eq(automationEnrolments.status, "active"),
        eq(automations.status, "active"),
        lt(automationEnrolments.nextStepAt, new Date(now.getTime() - STUCK_AFTER_MS)),
      ),
    );
  const lag = await evaluatorLagSeconds(db, now);
  return {
    failed: runs?.failed ?? 0,
    skippedTranslation: runs?.skippedTranslation ?? 0,
    stuck: Number(stuck?.n ?? 0),
    evaluatorLagSeconds: lag,
  };
}

export type PersonAutomationsPanelProps = {
  personId: string;
  /** Defaults to the app database (tests pass theirs). */
  db?: DbOrTx;
  /** Defaults to the signed-in staff user's locale. */
  locale?: Locale;
};

/**
 * Server component rendered by crm in the person page "Automations" tab (spec 5, A-41). Interim
 * read-only version (automation-P4): active journeys with next step and due time, ended journeys
 * with their end reason, and the automation timeline, newest first. Labels are the
 * `automation.panel.*`, `automation.outcome.*` and `automation.end_reason.*` catalogue keys
 * (automation-P5 writes them; `softTranslator` shows the key until then). Times in Europe/Brussels.
 */
export async function PersonAutomationsPanel(props: PersonAutomationsPanelProps): Promise<ReactElement> {
  const { adminLocale, softTranslator } = await import("@/lib/i18n");
  const db = props.db ?? (await getAppDb());
  const locale = props.locale ?? (await adminLocale());
  const tr = softTranslator(locale);
  const [enrolments, timeline] = await Promise.all([listPersonEnrolments(db, props.personId), getTimelineItems(db, props.personId, { limit: 100 })]);
  const when = (d: Date | null) => (d ? formatDateTime(d, locale) : "");
  const endReason = (r: string | null) => (r ? tr(`automation.end_reason.${r.split(":")[0]}`) : "");
  if (!enrolments.length && !timeline.length) {
    return el("div", { "data-testid": "automation-panel" }, el("p", { "data-testid": "automation-panel-empty" }, tr("automation.panel.empty")));
  }
  const section = (key: string, body: ReactNode) =>
    el("section", { "aria-labelledby": `automation-panel-${key}`, "data-testid": `automation-panel-${key}` }, el("h3", { id: `automation-panel-${key}` }, tr(`automation.panel.${key}`)), body);
  const item = (e: PersonEnrolmentSummary, detail: string) =>
    el("li", { key: e.enrolmentId, "data-enrolment-id": e.enrolmentId }, el("strong", null, e.automationName), " ", el("span", null, detail));
  const active = enrolments.filter((e) => e.status === "active");
  const ended = enrolments.filter((e) => e.status !== "active");
  return el(
    "div",
    { "data-testid": "automation-panel" },
    section(
      "active",
      active.length
        ? el("ul", null, ...active.map((e) => item(e, e.nextStepKey ? `${tr("automation.panel.next_step")}: ${e.nextStepKey}, ${when(e.nextStepAt)}` : "")))
        : el("p", null, tr("automation.panel.no_active")),
    ),
    ended.length ? section("ended", el("ul", null, ...ended.map((e) => item(e, `${endReason(e.endReason)}, ${when(e.endedAt)}`)))) : null,
    section(
      "timeline",
      el(
        "ol",
        null,
        ...timeline.map((t) =>
          el(
            "li",
            { key: t.id, "data-outcome": t.outcome },
            el("time", { dateTime: t.occurredAt.toISOString() }, when(t.occurredAt)),
            " ",
            el("strong", null, t.automationName),
            t.stepKey ? ` / ${t.stepKey}` : "",
            " ",
            el("span", null, tr(`automation.outcome.${t.outcome}`)),
            t.outcome === "exited" && t.endReason ? ` (${endReason(t.endReason)})` : "",
            t.reason && t.outcome !== "exited" ? el("small", null, ` ${t.reason}`) : null,
          ),
        ),
      ),
    ),
  );
}
