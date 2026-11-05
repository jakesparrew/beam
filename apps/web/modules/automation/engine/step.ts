/**
 * `automation.step` (A-26 to A-34, A-11a, A-27a, A-44): one due step of one enrolment.
 *
 * Order of the checks, under the enrolment row lock (A-26), with one run row for the first
 * failing check: the enrolment is active and its `next_step_key` is the job's step (else no-op,
 * no row); the automation is `active` (paused or archived: no-op, no row; A-29 re-enqueues on
 * resume); the person is not erased (exit `erased`); the flag gate (A-11a, `skipped_condition`
 * `flag_off:<key>`); the anchor refresh before an anchor-relative step (A-27a, re-plans and
 * sends nothing); the overdue rule (A-28); `unless` (`skipped_condition` `unless:<predicate>`);
 * then the step itself (A-31, A-33) and the advance (A-34).
 *
 * Protected facts (A-44): no code path here writes bookings, waitlist entries, credit entries,
 * orders or payments; every write to another module goes through its api (crm tasks, tags,
 * fields and status override; email messages; commerce's checkout recovery mark).
 *
 * Frequency rules (A-32, automation-P7): an email step sent as marketing (a marketing template
 * or `send_as: 'marketing'`) that passed reachability and translation is judged by
 * `applyFrequencyRules` against `settings.automation_rules` and the person's automation
 * marketing messages of the last 7 days. Inside the quiet hours the step is deferred: the plan
 * entry and `next_step_at` move to the end of the quiet hours, a new `scheduled` run (reason
 * `quiet_hours`) is written and the job enqueues itself with the `:defer:` key and `runAt`
 * (A-26a); over a cap it writes `skipped_frequency_cap` (reason `cap_day:<n>` or `cap_week:<n>`)
 * and the enrolment advances. Transactional templates are never capped or deferred.
 *
 * Decisions:
 * - A recent automation marketing send is an `email_messages` row of the person with `kind =
 *   automation`, a non-null `purpose` and a status other than `suppressed`, `blocked_translation`
 *   or `failed` (those never reached the person), created in the trailing window; the message of
 *   this very step (its idempotency key) is not counted, so a re-run never caps itself.
 * - A `webhook` step writes no run when it runs: it enqueues `automation.call_webhook` and the
 *   enrolment advances; that job writes `webhook_called` (or its `onDead` hook `failed`).
 * - An `enrol` step whose target refuses the entry for audience, re-entry or a missing anchor
 *   writes `skipped_condition` with reason `target_<outcome>:<slug>`; exclusivity and
 *   reachability refusals keep their own outcome (`skipped_exclusive`, `skipped_unreachable`).
 * - An `exit` step naming an automation the person is not in writes `skipped_condition`
 *   `not_enrolled:<slug>`. An `exit` of the enrolment itself writes the one `exited` run of
 *   A-25 (`exit_step`, `data.step_key`).
 * - Task due dates use `booking.nextOpeningAt(tx, due)` with its default, which skips Belgian
 *   public holidays (booking decision 57; `includePublicHolidays: true` is the customer-facing
 *   opening and would let a task fall due on Easter Monday).
 */
import type { Tx } from "@beam/db";
import { persons, type RoleKey, type RunDataJson } from "@beam/db/schema";
import {
  addMinutes,
  evaluateCondition,
  overdueOutcome,
  replanForAnchor,
  startPlan,
  utcMinuteBucket,
  webhookIdempotencyKey,
  type AutomationRunOutcome,
  type ConditionScope,
  type Definition,
  type EmailStep,
  type EnrolStep,
  type EventView,
  type ExitStep,
  type NotifySlackStep,
  type PersonFacts,
  type Step,
  type TaskStep,
} from "@beam/core/automation";
import { createCtx, eq, sql, type Actor, type Ctx } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { getSetting } from "@/lib/settings";
import { rowsOf } from "@/lib/sensitive";
import { nextOpeningAt } from "@/modules/booking/api";
import { getCheckoutRecoveryProps, markCheckoutRecoveryMessage } from "@/modules/commerce/api";
import { applyTag, createTask, removeTag, setStatusOverride, updatePersonFields } from "@/modules/crm/api";
import { getPublishedTemplateInfo, getReachability, queueAutomationEmail, queueMarketingEmail } from "@/modules/email/api";
import { listStaffForAssignment, notifySlack } from "@/modules/platform/api";
import { advance, lockEnrolment, lockEnrolmentPerson, replanDedupeKey, skipStep, storePlan, writeStepRun, type LockedEnrolment } from "./advance";
import { enrol, loadAutomations } from "./enrol";
import { activeEnrolmentsOf, endEnrolmentWith } from "./exits";
import { loadFacts, needsOf } from "./facts";
import { writeRun } from "./runs";
// Until `@beam/core/automation` re-exports it (requested from the owner of its index.ts).
import { applyFrequencyRules, FREQUENCY_WEEK_MS, frequencyCapReason, type AutomationRules } from "../../../../../packages/core/src/automation/frequency";

export type RunStepInput = { enrolmentId: string; stepKey: string; now: Date };

export type RunStepResult =
  | { status: "noop"; reason: "missing" | "ended" | "not_next" | "automation_inactive" }
  | { status: "replanned"; reason: "anchor_moved"; nextStepKey: string | null }
  | { status: "deferred"; reason: "quiet_hours"; nextStepKey: string; until: Date }
  | { status: "ran"; outcome: AutomationRunOutcome | null; nextStepKey: string | null; ended: boolean };

export type RunStepOptions = { ctx?: Ctx };

/** Anchor moves above this re-plan the enrolment (A-27a). */
export const ANCHOR_MOVE_TOLERANCE_MS = 5 * 60_000;

/**
 * The `automation.step` job key (A-26a): `automation:<enrolment_id>:<step_key>`, or with
 * `:resume:<YYYY-MM-DDTHH:mm>` / `:defer:<YYYY-MM-DDTHH:mm>` / `:replan:<YYYY-MM-DDTHH:mm>` (UTC
 * minute of the resume, run or re-planned due time).
 */
export function stepJobKey(enrolmentId: string, stepKey: string, qualifier?: { kind: "resume" | "defer" | "replan"; at: Date }): string {
  const base = `automation:${enrolmentId}:${stepKey}`;
  return qualifier ? `${base}:${qualifier.kind}:${utcMinuteBucket(qualifier.at)}` : base;
}

/** The email idempotency key of a step: one email per step whatever the job attempts (A-26a). */
export const stepEmailKey = (enrolmentId: string, stepKey: string): string => `automation:${enrolmentId}:${stepKey}`;

/** The job priority of a step: 2 for a transactional automation, 5 for a marketing one (4.4). */
export const stepJobPriority = (isMarketing: boolean): number => (isMarketing ? 5 : 2);

const ran = (outcome: AutomationRunOutcome | null, e: LockedEnrolment): RunStepResult => ({
  status: "ran",
  outcome,
  nextStepKey: e.status === "active" ? e.nextStepKey : null,
  ended: e.status !== "active",
});

const conditionScope = (e: LockedEnrolment): ConditionScope => ({ trigger: e.context.trigger ?? null, subjectKey: e.subjectKey });

/** The facts the `unless` and `if` of a step need, loaded fresh (A-27). */
export function stepFacts(tx: Tx, e: LockedEnrolment, step: Step, now: Date): Promise<PersonFacts> {
  const conds = [step.unless, step.type === "condition" ? step.if : undefined];
  return loadFacts(tx, e.personId, needsOf(conds, { now, enrolment: { id: e.id, enteredAt: e.enteredAt, subjectKey: e.subjectKey } }));
}

/** A-27a: the current session start of the subject booking, when the enrolment depends on it. */
async function movedAnchor(tx: Tx, e: LockedEnrolment, def: Definition, step: Step): Promise<Date | null> {
  if (step.at?.from !== "anchor" || def.anchor !== "data.starts_at" || !e.anchorAt || !e.subjectKey.startsWith("booking:")) return null;
  const bookingId = e.subjectKey.slice("booking:".length);
  const [row] = rowsOf<{ starts_at: string | Date }>(await tx.execute(sql`select starts_at from v_person_bookings where id::text = ${bookingId} limit 1`));
  if (!row) return null;
  const startsAt = new Date(row.starts_at);
  return Math.abs(startsAt.getTime() - e.anchorAt.getTime()) > ANCHOR_MOVE_TOLERANCE_MS ? startsAt : null;
}

/**
 * Re-plans the pending steps on the new anchor and sends nothing (A-27a, edge case 10b). When the
 * re-planned next step is the step this job holds, its plain job key is already taken (a
 * finished job keeps its key), so the step is enqueued again under `:replan:<due minute>`. A
 * different next step keeps a free plain key and the evaluator picks it up.
 */
async function replanOnAnchor(tx: Tx, ctx: Ctx, e: LockedEnrolment, def: Definition, anchorAt: Date, now: Date): Promise<RunStepResult> {
  const actor = ctx.actor;
  const before = new Map(e.plan.map((p) => [p.key, p.state]));
  const replanned = replanForAnchor(def, e.plan, { enteredAt: e.enteredAt, anchorAt }, now);
  const { plan, next } = startPlan(replanned);
  await tx.execute(sql`update automation_enrolments set anchor_at = ${anchorAt.toISOString()}::timestamptz where id = ${e.id}::uuid`);
  await storePlan(tx, e.id, plan, next);
  for (const p of plan) {
    if (p.state === "skipped" && before.get(p.key) === "pending") {
      await writeStepRun(tx, e, p.key, "skipped_late_entry", actor, { reason: "anchor_moved", data: { due_at: p.due_at } });
    }
  }
  if (next) {
    await writeRun(tx, {
      enrolmentId: e.id,
      personId: e.personId,
      automationId: e.automationId,
      automationVersionId: e.versionId,
      stepKey: next.key,
      outcome: "scheduled",
      reason: "anchor_moved",
      data: { due_at: next.due_at, anchor_at: anchorAt.toISOString() },
      actor,
      dedupeKey: replanDedupeKey(e.id, next.key, "anchor_moved", now),
    });
    if (next.key === e.nextStepKey) {
      const at = new Date(next.due_at);
      await ctx.enqueue({
        kind: "automation.step",
        payload: { enrolmentId: e.id, stepKey: next.key },
        key: stepJobKey(e.id, next.key, { kind: "replan", at }),
        runAt: at,
        lane: "fast",
        priority: stepJobPriority(e.automation.isMarketing),
      });
    }
  } else {
    await endEnrolmentWith(tx, e.id, "completed", "anchor_passed", actor);
  }
  return { status: "replanned", reason: "anchor_moved", nextStepKey: next?.key ?? null };
}

/** Runs one due step; see the file header for the order of checks. */
export async function runStep(tx: Tx, input: RunStepInput, opts: RunStepOptions = {}): Promise<RunStepResult> {
  const ctx = opts.ctx ?? createCtx({ tx, actor: { kind: "system", jobId: "" }, now: input.now });
  const actor = ctx.actor;
  const now = input.now;
  // Person first, then the enrolment: the evaluator's order (advance.ts header).
  if (!(await lockEnrolmentPerson(tx, input.enrolmentId))) return { status: "noop", reason: "missing" };
  const e = await lockEnrolment(tx, input.enrolmentId);
  if (!e) return { status: "noop", reason: "missing" };
  if (e.status !== "active") return { status: "noop", reason: "ended" };
  if (e.nextStepKey !== input.stepKey) return { status: "noop", reason: "not_next" };
  if (e.automation.status !== "active") return { status: "noop", reason: "automation_inactive" };

  const [person] = await tx
    .select({ id: persons.id, erasedAt: persons.erasedAt, locale: persons.locale, firstName: persons.firstName })
    .from(persons)
    .where(eq(persons.id, e.personId));
  if (!person || person.erasedAt) {
    await endEnrolmentWith(tx, e.id, "exited", "erased", actor);
    return { status: "ran", outcome: "exited", nextStepKey: null, ended: true };
  }

  const def = e.definition;
  const step = def?.steps.find((s) => s.key === input.stepKey);
  if (!def || !step) {
    await skipStep(tx, e, input.stepKey, "failed", def ? "step_missing" : "definition_invalid", { actor, now });
    return ran("failed", e);
  }

  // A-11a: the flag gate (the job's system actor: only the global state counts).
  if (e.automation.requiresFlag && !(await flag(e.automation.requiresFlag as Parameters<typeof flag>[0], actor))) {
    await skipStep(tx, e, step.key, "skipped_condition", `flag_off:${e.automation.requiresFlag}`, { actor, now });
    return ran("skipped_condition", e);
  }

  // A-27a: the subject booking's session moved.
  const anchor = await movedAnchor(tx, e, def, step);
  if (anchor) return replanOnAnchor(tx, ctx, e, def, anchor, now);

  // A-28: overdue time-sensitive steps.
  const dueAt = e.nextStepAt ?? now;
  const pausedDuring = !!e.automation.lastResumedAt && e.automation.lastResumedAt.getTime() > dueAt.getTime();
  const overdue = overdueOutcome(step.type, dueAt, now, pausedDuring);
  if (overdue !== "run") {
    await skipStep(tx, e, step.key, overdue, `due ${dueAt.toISOString()}`, { actor, now, data: { due_at: dueAt.toISOString() } });
    return ran(overdue, e);
  }

  // A-27: conditions against fresh facts.
  const scope = conditionScope(e);
  const facts = step.unless || step.type === "condition" ? await stepFacts(tx, e, step, now) : null;
  if (step.unless && facts) {
    const r = evaluateCondition(step.unless, facts, scope);
    if (r.result) {
      await skipStep(tx, e, step.key, "skipped_condition", `unless:${r.predicate}`, { actor, now });
      return ran("skipped_condition", e);
    }
  }

  if (step.type === "condition" && facts) {
    const r = evaluateCondition(step.if, facts, scope);
    const target = r.result ? step.then : step.else;
    const data: RunDataJson = { result: r.result, target, branch: r.result ? "then" : "else" };
    await writeStepRun(tx, e, step.key, "branched", actor, { reason: r.predicate, data });
    await advance(tx, e, step.key, { actor, now, branch: { target } });
    return ran("branched", e);
  }

  const stepPerson: StepPerson = { id: person.id, locale: person.locale, firstName: person.firstName };
  const result = await executeStep(tx, ctx, e, step, stepPerson, now);
  if (result.ended) return ran(result.outcome, e);
  if (result.deferUntil) return deferStep(tx, ctx, e, step.key, result.deferUntil, now);
  if (result.outcome) {
    await writeStepRun(tx, e, step.key, result.outcome, actor, {
      reason: result.reason ?? null,
      data: result.data ?? {},
      emailMessageId: result.emailMessageId ?? null,
      taskId: result.taskId ?? null,
    });
  }
  const skipped = !!result.outcome && (result.outcome.startsWith("skipped_") || result.outcome === "failed");
  await advance(tx, e, step.key, { actor, now, ...(skipped ? { state: "skipped" as const, reason: result.outcome! } : {}) });
  return ran(result.outcome, e);
}

// ---------------------------------------------------------------------------
// Step types (A-31, A-33)
// ---------------------------------------------------------------------------

export type StepPerson = { id: string; locale: string; firstName: string | null };

export type StepOutcome = {
  /** null: no run row for this step (a `wait`, a `webhook` handed to its job). */
  outcome: AutomationRunOutcome | null;
  reason?: string | null;
  data?: RunDataJson;
  emailMessageId?: string | null;
  taskId?: string | null;
  /** The step ended the enrolment itself (an `exit` of this enrolment). */
  ended?: boolean;
  /** Quiet hours (A-32): the step runs again at this time; nothing is written for it now. */
  deferUntil?: Date;
};

/** Runs the step itself once every check passed. */
export async function executeStep(tx: Tx, ctx: Ctx, e: LockedEnrolment, step: Step, person: StepPerson, now: Date): Promise<StepOutcome> {

  switch (step.type) {
    case "email":
      return runEmailStep(tx, ctx, e, step, person, now);
    case "wait":
    case "condition":
      return { outcome: null };
    case "task":
      return runTaskStep(tx, ctx, e, step, now);
    case "tag": {
      const r = await applyTag(tx, ctx, e.personId, step.tag, "automation");
      return { outcome: "tag_applied", data: { tag: step.tag, changed: r.applied } };
    }
    case "untag": {
      const r = await removeTag(tx, ctx, e.personId, step.tag);
      return { outcome: "tag_removed", data: { tag: step.tag, changed: r.removed } };
    }
    case "set_field": {
      const r = await updatePersonFields(tx, ctx, e.personId, { preferredChannel: step.value }, { onlyEmpty: false });
      return { outcome: "field_set", data: { field: step.field, value: step.value, changed: r.changed.length > 0 } };
    }
    case "status_override": {
      const r = await setStatusOverride(tx, ctx, { personId: e.personId, status: step.value, reason: step.reason, source: "automation" });
      return { outcome: "status_set", reason: step.reason, data: { value: step.value, changed: r.applied } };
    }
    case "enrol":
      return runEnrolStep(tx, ctx.actor, e, step, now);
    case "exit":
      return runExitStep(tx, ctx.actor, e, step);
    case "notify_slack":
      return runSlackStep(ctx, e, step, person);
    case "webhook":
      await ctx.enqueue({
        kind: "automation.call_webhook",
        payload: { enrolmentId: e.id, stepKey: step.key },
        key: webhookIdempotencyKey(e.id, step.key),
        lane: "fast",
      });
      return { outcome: null };
  }
}

/**
 * The email `context` (A-31): string ids of the trigger (`ref_type`, `ref_id`, every `data` key
 * ending in `_id`), `subject_key` and `enrolment_id`, so email never reads the enrolment.
 */
export function buildEmailContext(e: Pick<LockedEnrolment, "id" | "subjectKey" | "context">): Record<string, string> {
  const out: Record<string, string> = {};
  const t = e.context.trigger;
  if (t?.ref_type) out.ref_type = t.ref_type;
  if (t?.ref_id) out.ref_id = t.ref_id;
  for (const [k, v] of Object.entries(t?.data ?? {})) {
    if (k.endsWith("_id") && (typeof v === "string" || typeof v === "number")) out[k] = String(v);
  }
  out.subject_key = e.subjectKey;
  out.enrolment_id = e.id;
  return out;
}

async function runEmailStep(tx: Tx, ctx: Ctx, e: LockedEnrolment, step: EmailStep, person: StepPerson, now: Date): Promise<StepOutcome> {
  const slug = step.template;
  const info = (await getPublishedTemplateInfo(tx, [slug])).get(slug);
  if (!info) return { outcome: "failed", reason: "template_unavailable", data: { template_slug: slug } };
  const asMarketing = step.send_as === "marketing" || info.kind === "marketing";
  if (asMarketing) {
    const purpose = step.send_as === "marketing" ? e.automation.purpose : (info.purpose ?? e.automation.purpose);
    if (!purpose) return { outcome: "skipped_unreachable", reason: "no_purpose", data: { template_slug: slug } };
    const reach = await getReachability(tx, e.personId, purpose);
    if (!reach.isReachable) return { outcome: "skipped_unreachable", reason: reach.blockedReason ?? `purpose ${purpose} not reachable`, data: { template_slug: slug } };
  }
  if (!(info.locales as string[]).includes(person.locale)) {
    return {
      outcome: "skipped_translation",
      reason: `locale ${person.locale} missing in template ${slug}`,
      data: { template_slug: slug, template_version_id: info.templateVersionId },
    };
  }
  if (asMarketing) {
    // A-32: quiet hours and frequency caps, marketing sends only.
    const rules = (await getSetting(tx, "automation_rules")) as AutomationRules;
    const input = { now, recentMarketingSends: await recentMarketingSends(tx, e.personId, now, stepEmailKey(e.id, step.key)), rules };
    const decision = applyFrequencyRules(input);
    if (decision.action === "defer") return { outcome: null, deferUntil: decision.until };
    if (decision.action === "skip") return { outcome: "skipped_frequency_cap", reason: frequencyCapReason(input) ?? "frequency_cap", data: { template_slug: slug } };
  }
  const context = buildEmailContext(e);
  const checkoutId = e.subjectKey.startsWith("checkout:") ? e.subjectKey.slice("checkout:".length) : null;
  if (checkoutId) {
    const props = await getCheckoutRecoveryProps(tx, checkoutId);
    context.checkout_id = checkoutId;
    context.resume_url = props.resumeUrl;
  }
  const input = { templateSlug: slug, personId: e.personId, enrolmentId: e.id, idempotencyKey: stepEmailKey(e.id, step.key), context, stepKey: step.key };
  const res = asMarketing ? await queueMarketingEmail(ctx, input) : await queueAutomationEmail(ctx, input);
  const data: RunDataJson = { template_slug: slug, template_version_id: res.templateVersionId };
  if (res.status !== "queued") return { outcome: res.status, reason: `email:${res.status}`, data };
  if (checkoutId) await markCheckoutRecoveryMessage(tx, { checkoutId, emailMessageId: res.messageId });
  return { outcome: "sent", data, emailMessageId: res.messageId };
}

/**
 * The person's automation marketing messages of the last 7 days (A-32): `kind = automation` with
 * a purpose, not suppressed, blocked or failed, other than the message of this step itself.
 */
export async function recentMarketingSends(tx: Tx, personId: string, now: Date, ownKey: string): Promise<Date[]> {
  const since = new Date(now.getTime() - FREQUENCY_WEEK_MS);
  const rows = rowsOf<{ at: string | Date }>(
    await tx.execute(sql`select created_at as at from email_messages
      where person_id = ${personId}::uuid and kind = 'automation' and purpose is not null
        and status not in ('suppressed', 'blocked_translation', 'failed')
        and idempotency_key <> ${ownKey}
        and created_at > ${since.toISOString()}::timestamptz and created_at <= ${now.toISOString()}::timestamptz`),
  );
  return rows.map((r) => new Date(r.at));
}

/**
 * A-32 deferral: the step stays the next step, its plan entry and `next_step_at` move to
 * `until`, a new `scheduled` run (reason `quiet_hours`) is written and the step is enqueued again
 * with the `:defer:<YYYY-MM-DDTHH:mm>` key and `runAt` (the plain key is taken by this job).
 */
async function deferStep(tx: Tx, ctx: Ctx, e: LockedEnrolment, stepKey: string, until: Date, now: Date): Promise<RunStepResult> {
  const due = until.toISOString();
  const plan = e.plan.map((p) => (p.key === stepKey ? { ...p, due_at: due } : p));
  const next = plan.find((p) => p.key === stepKey) ?? { key: stepKey, type: "email" as const, due_at: due, state: "pending" as const };
  await storePlan(tx, e.id, plan, next);
  e.plan = plan;
  e.nextStepAt = until;
  await writeRun(tx, {
    enrolmentId: e.id,
    personId: e.personId,
    automationId: e.automationId,
    automationVersionId: e.versionId,
    stepKey,
    outcome: "scheduled",
    reason: "quiet_hours",
    data: { due_at: due, deferred_from: now.toISOString() },
    actor: ctx.actor,
    dedupeKey: replanDedupeKey(e.id, stepKey, "defer", until),
  });
  await ctx.enqueue({
    kind: "automation.step",
    payload: { enrolmentId: e.id, stepKey },
    key: stepJobKey(e.id, stepKey, { kind: "defer", at: until }),
    runAt: until,
    lane: "fast",
    priority: stepJobPriority(e.automation.isMarketing),
  });
  return { status: "deferred", reason: "quiet_hours", nextStepKey: stepKey, until };
}

/** `{{trigger.data.<key>}}` in a task title, for a string key of the trigger data. */
export function interpolateTitle(title: string, e: Pick<LockedEnrolment, "context">): string {
  const data = e.context.trigger?.data ?? {};
  return title.replace(/\{\{\s*trigger\.data\.([a-z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = data[key];
    return typeof v === "string" || typeof v === "number" ? String(v) : "";
  });
}

type Staff = { userId: string; name: string; roleKey: RoleKey };

/** The candidate with the fewest open tasks, ties by name (A-33). */
async function leastBusy(tx: Tx, staff: Staff[]): Promise<Staff | null> {
  if (!staff.length) return null;
  const counts = rowsOf<{ owner: string; n: number | string }>(
    await tx.execute(sql`select owner_user_id::text as owner, count(*) as n from tasks where status = 'open'
      and owner_user_id in (${sql.join(
        staff.map((s) => sql`${s.userId}::uuid`),
        sql`, `,
      )}) group by owner_user_id`),
  );
  const open = new Map(counts.map((c) => [c.owner, Number(c.n)]));
  const sorted = [...staff].sort(
    (a, b) => (open.get(a.userId) ?? 0) - (open.get(b.userId) ?? 0) || a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId),
  );
  return sorted[0] ?? null;
}

/** A-33 and edge case 15: the task owner, with the fallback to management, then owner. */
export async function pickTaskOwner(tx: Tx, step: TaskStep, e: Pick<LockedEnrolment, "context">): Promise<{ userId: string; reason: string | null } | null> {
  if (step.owner === "trigger_owner") {
    const wanted = e.context.trigger?.data.owner_user_id;
    if (typeof wanted === "string") {
      const active = (await listStaffForAssignment(tx)).find((s) => s.userId === wanted);
      if (active) return { userId: active.userId, reason: null };
    }
  }
  const role = await leastBusy(tx, await listStaffForAssignment(tx, { roleKey: step.owner_role as RoleKey }));
  if (role) return { userId: role.userId, reason: null };
  for (const fallback of ["management", "owner"] as RoleKey[]) {
    const pick = await leastBusy(tx, await listStaffForAssignment(tx, { roleKey: fallback }));
    if (pick) return { userId: pick.userId, reason: `owner_fallback:${step.owner_role}` };
  }
  return null;
}

async function runTaskStep(tx: Tx, ctx: Ctx, e: LockedEnrolment, step: TaskStep, now: Date): Promise<StepOutcome> {
  const owner = await pickTaskOwner(tx, step, e);
  if (!owner) return { outcome: "failed", reason: "no_staff_user" };
  let dueAt = addMinutes(now, step.due_in_minutes);
  const reasons = owner.reason ? [owner.reason] : [];
  const opening = await nextOpeningAt(tx, dueAt);
  if (opening && opening.getTime() > dueAt.getTime()) {
    dueAt = opening;
    reasons.push(`due_moved:${opening.toISOString()}`);
  }
  const res = await createTask(tx, ctx, {
    title: interpolateTitle(step.title, e),
    kind: step.kind,
    ownerUserId: owner.userId,
    personId: e.personId,
    dueAt,
    priority: step.priority,
    source: "automation",
    ref: { type: "automation_enrolment", id: e.id },
    dedupeKey: stepEmailKey(e.id, step.key),
  });
  return { outcome: "task_created", reason: reasons.join(" ") || null, data: { due_at: dueAt.toISOString() }, taskId: res.taskId };
}

/** The trigger of the enrolment as an event view (anchor and subject of an `enrol` step's target). */
function triggerEvent(e: LockedEnrolment): EventView | null {
  const t = e.context.trigger;
  if (!t?.event_id) return null;
  return {
    id: BigInt(t.event_id),
    kind: t.kind,
    personId: e.personId,
    occurredAt: e.enteredAt,
    mode: t.mode,
    refType: t.ref_type,
    refId: t.ref_id,
    isSensitive: false,
    data: t.data,
  };
}

async function runEnrolStep(tx: Tx, actor: Actor, e: LockedEnrolment, step: EnrolStep, now: Date): Promise<StepOutcome> {
  const data: RunDataJson = { target: step.automation };
  const [target] = await loadAutomations(tx, { slugs: [step.automation] });
  if (!target || target.status !== "active") return { outcome: "skipped_condition", reason: `target_inactive:${step.automation}`, data };
  const res = await enrol(tx, {
    automation: target,
    personId: e.personId,
    source: "enrol_step",
    actor,
    now,
    event: triggerEvent(e),
    ...(e.context.vars ? { vars: e.context.vars } : {}),
  });
  if (res.status === "enrolled") return { outcome: "enrolled", data: { ...data, enrolment_id: res.enrolmentId } };
  if (res.outcome === "skipped_exclusive" || res.outcome === "skipped_unreachable") return { outcome: res.outcome, reason: `target:${step.automation}`, data };
  return { outcome: "skipped_condition", reason: `target_${res.outcome}:${step.automation}`, data };
}

async function runExitStep(tx: Tx, actor: Actor, e: LockedEnrolment, step: ExitStep): Promise<StepOutcome> {
  if (!step.automation || step.automation === e.automation.slug) {
    await storePlan(
      tx,
      e.id,
      e.plan.map((p) => (p.key === step.key ? { ...p, state: "done" as const } : p)),
      null,
    );
    await endEnrolmentWith(tx, e.id, "exited", "exit_step", actor, { step_key: step.key });
    e.status = "exited";
    return { outcome: "exited", ended: true };
  }
  const ids = rowsOf<{ id: string }>(await tx.execute(sql`select id::text as id from automations where slug = ${step.automation}`)).map((r) => r.id);
  const active = (await activeEnrolmentsOf(tx, e.personId)).filter((x) => ids.includes(x.automationId) && x.id !== e.id);
  if (!active.length) return { outcome: "skipped_condition", reason: `not_enrolled:${step.automation}`, data: { target: step.automation } };
  let ended = 0;
  for (const x of active) if (await endEnrolmentWith(tx, x.id, "exited", "exit_step", actor, { exited_by: e.id })) ended++;
  return { outcome: "exited", reason: "exit_step", data: { target: step.automation, ended } };
}

/** `{{first_name}}`, `{{person_url}}` (`/admin/persons/<id>`) and `{{automation}}` only. */
export function slackText(text: string, v: { firstName: string | null; personId: string; automation: string }): string {
  return text
    .replaceAll("{{first_name}}", v.firstName ?? "")
    .replaceAll("{{person_url}}", `/admin/persons/${v.personId}`)
    .replaceAll("{{automation}}", v.automation);
}

async function runSlackStep(ctx: Ctx, e: LockedEnrolment, step: NotifySlackStep, person: StepPerson): Promise<StepOutcome> {
  const fingerprint = `automation:${e.automationId}:${step.key}:${e.id}`;
  await notifySlack(ctx, {
    fingerprint,
    severity: "normal",
    text: slackText(step.text, { firstName: person.firstName, personId: e.personId, automation: e.automation.name }),
  });
  return { outcome: "notified", data: { fingerprint } };
}
