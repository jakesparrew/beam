/**
 * Preview (A-39): what the journey would do for one person, read-only. `previewSteps` plans the
 * steps (A-17, A-18) and runs the step checks of `automation.step` (A-26 to A-31) against the
 * person's current facts, in the same order and with the same functions as the step job, and
 * returns each step with its due time and the predicted outcome. It writes nothing: no
 * enrolment, no run, no job, no email.
 *
 * Two cases:
 * - The person has an active enrolment of the automation and no `anchorAt` is given: the
 *   remaining (pending) steps of that enrolment's plan, on its own version, anchor, subject and
 *   trigger context ("Preview next steps" on the person page).
 * - Otherwise: a fresh enrolment entered at `now` on the current version, with `anchorAt` as the
 *   anchor when the definition has a data anchor ("Enrol in..." dialog). Steps planned before
 *   `now` are `late_entry`, exactly as A-18 skips them at enrolment.
 *
 * Mapping of the step job's outcomes: `skipped_late_entry`, `skipped_stale` and `skipped_paused`
 * -> `late_entry`; `skipped_condition` (`unless`, the flag gate of A-11a, a branch not taken) ->
 * `condition_false`; `skipped_unreachable` -> `unreachable`; `skipped_translation` ->
 * `translation_missing`; `skipped_frequency_cap` -> `frequency_cap`; every step that would run ->
 * `will_send` (a quiet-hours deferral stays `will_send`, at the deferred time, reason `quiet_hours`).
 *
 * Decisions:
 * - A missing published template gives `failed` (reason `template_unavailable`), the outcome
 *   the step job writes; the spec's list of predicted outcomes lacks it.
 * - Frequency rules (A-32, R2): an email step sent as marketing that passes the template,
 *   reachability and locale checks is judged by `applyFrequencyRules`, exactly like the step job,
 *   at the time it would run (its due time, or `now` when already due). The recent sends are the
 *   person's automation marketing messages of the last 7 days (`recentMarketingSends` of the step
 *   job) plus the marketing sends this preview predicts earlier in the same journey. Inside the
 *   quiet hours the step is deferred: its `dueAt` moves to the end of the quiet hours, the reason
 *   is `quiet_hours`, and the caps are judged again at that time (as the deferred job does); over
 *   a cap it is `frequency_cap` with the reason `cap_day:<n>` or `cap_week:<n>`. A deferral does
 *   not move the later steps (their due times come from the plan, as in the step job). Marketing
 *   sends of other automations due between now and the step are unknown and not counted.
 * - `wait` steps are not listed (they never execute). Steps after a `condition` are judged on the
 *   branch the current facts take; the others are `condition_false` with reason
 *   `branch_not_taken`, keeping their default-path due time.
 * - Conditions are evaluated on the facts of `now`, not of the due time (facts of the future are
 *   unknown); the step job re-checks everything when the step is due (A-27).
 */
import { randomUUID } from "node:crypto";
import type { DbOrTx, Tx } from "@beam/db";
import { automationEnrolments, automationVersions, persons, type EnrolmentContextJson } from "@beam/db/schema";
import {
  applyFrequencyRules,
  evaluateCondition,
  frequencyCapReason,
  overdueOutcome,
  planSteps,
  type AutomationPurpose,
  type AutomationRules,
  type ConditionScope,
  type Definition,
  type PlannedStep,
  type Step,
  type StepType,
} from "@beam/core/automation";
import { and, desc, eq, NotFoundError, ValidationError } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { getSetting } from "@/lib/settings";
import { getPublishedTemplateInfo, getReachability } from "@/modules/email/api";
import { loadAutomations } from "./enrol";
import { versionDefinition } from "./exits";
import { loadFacts, needsOf } from "./facts";
import { recentMarketingSends } from "./step";

export type PreviewOutcome = "will_send" | "late_entry" | "condition_false" | "unreachable" | "translation_missing" | "frequency_cap" | "failed";

export type PreviewStep = {
  key: string;
  type: StepType;
  dueAt: Date;
  outcome: PreviewOutcome;
  /** Machine reason, as the step job would write it (`unless:has_tag`, `no_consent`, ...). */
  reason: string | null;
  /** The template of an email step. */
  templateSlug: string | null;
};

export type PreviewInput = { personId: string; automationId: string; anchorAt?: Date; now: Date };

type Basis = {
  def: Definition;
  plan: PlannedStep[];
  fresh: boolean;
  enrolment: { id: string; enteredAt: Date; subjectKey: string };
  scope: ConditionScope;
};

/** The active enrolment of the person in the automation (newest), with its version's definition. */
async function activeEnrolment(db: DbOrTx, personId: string, automationId: string) {
  const [row] = await db
    .select({
      id: automationEnrolments.id,
      versionId: automationEnrolments.automationVersionId,
      definition: automationVersions.definition,
      plan: automationEnrolments.plan,
      enteredAt: automationEnrolments.enteredAt,
      anchorAt: automationEnrolments.anchorAt,
      subjectKey: automationEnrolments.subjectKey,
      context: automationEnrolments.context,
    })
    .from(automationEnrolments)
    .innerJoin(automationVersions, eq(automationVersions.id, automationEnrolments.automationVersionId))
    .where(and(eq(automationEnrolments.personId, personId), eq(automationEnrolments.automationId, automationId), eq(automationEnrolments.status, "active")))
    .orderBy(desc(automationEnrolments.enteredAt))
    .limit(1);
  return row ?? null;
}

const scopeOf = (context: EnrolmentContextJson | null, subjectKey: string): ConditionScope => ({
  trigger: context?.trigger ?? null,
  subjectKey,
});

/** A-39: the predicted outcome of every remaining step (see the file header). */
export async function previewSteps(tx: DbOrTx, input: PreviewInput): Promise<PreviewStep[]> {
  const [automation] = await loadAutomations(tx as Tx, { ids: [input.automationId] });
  if (!automation) throw new NotFoundError("automation_not_found");
  const [person] = await tx.select({ id: persons.id, locale: persons.locale }).from(persons).where(eq(persons.id, input.personId));
  if (!person) throw new NotFoundError("person_not_found");
  const now = input.now;

  const active = input.anchorAt ? null : await activeEnrolment(tx, person.id, automation.id);
  let basis: Basis;
  if (active) {
    const def = versionDefinition(active.versionId, active.definition);
    if (!def) return [];
    basis = {
      def,
      plan: active.plan,
      fresh: false,
      enrolment: { id: active.id, enteredAt: active.enteredAt, subjectKey: active.subjectKey },
      scope: scopeOf(active.context, active.subjectKey),
    };
  } else {
    const def = automation.definition;
    if (!def) return [];
    const anchorAt = def.anchor === "enrolment" ? null : (input.anchorAt ?? null);
    if (def.anchor !== "enrolment" && !anchorAt) throw new ValidationError("anchor_required", { anchorAt: "anchor_required" });
    basis = {
      def,
      plan: planSteps(def, { enteredAt: now, anchorAt }),
      fresh: true,
      enrolment: { id: randomUUID(), enteredAt: now, subjectKey: "" },
      scope: scopeOf(null, ""),
    };
  }
  return predict(tx, basis, { personId: person.id, locale: person.locale, purpose: automation.purpose, requiresFlag: automation.requiresFlag, now });
}

type PredictPerson = { personId: string; locale: string; purpose: AutomationPurpose | null; requiresFlag: string | null; now: Date };

async function predict(tx: DbOrTx, b: Basis, p: PredictPerson): Promise<PreviewStep[]> {
  const steps = new Map(b.def.steps.map((s) => [s.key, s]));
  const listed = b.plan.filter((e) => {
    const s = steps.get(e.key);
    return !!s && s.type !== "wait" && (b.fresh || e.state === "pending");
  });
  if (!listed.length) return [];

  // Everything the checks read, loaded once (reads only).
  const conditions = listed.flatMap((e) => {
    const s = steps.get(e.key)!;
    return [s.unless, s.type === "condition" ? s.if : undefined];
  });
  const facts = await loadFacts(tx as Tx, p.personId, needsOf(conditions, { now: p.now, enrolment: b.enrolment }));
  const slugs = [...new Set(listed.map((e) => steps.get(e.key)!).flatMap((s) => (s.type === "email" ? [s.template] : [])))];
  const templates: Awaited<ReturnType<typeof getPublishedTemplateInfo>> = slugs.length ? await getPublishedTemplateInfo(tx, slugs) : new Map<string, never>();
  const reach = new Map<string, Awaited<ReturnType<typeof getReachability>>>();
  const reachability = async (purpose: AutomationPurpose) => {
    if (!reach.has(purpose)) reach.set(purpose, await getReachability(tx, p.personId, purpose));
    return reach.get(purpose)!;
  };
  const flagOn = p.requiresFlag ? await flag(p.requiresFlag as Parameters<typeof flag>[0], { kind: "system", jobId: "" }) : true;
  // A-32: the rules and the person's recent marketing sends, loaded on the first marketing step.
  let frequency: { rules: AutomationRules; sends: Date[] } | null = null;
  const frequencyBasis = async () => {
    frequency ??= {
      rules: await getSetting(tx, "automation_rules"),
      sends: await recentMarketingSends(tx as Tx, p.personId, p.now, `preview:${b.enrolment.id}`),
    };
    return frequency;
  };

  const out: PreviewStep[] = [];
  let jumpTo: string | null = null;
  let ended = false;
  const push = (e: PlannedStep, s: Step, outcome: PreviewOutcome, reason: string | null, dueAt = new Date(e.due_at)) =>
    out.push({ key: e.key, type: s.type, dueAt, outcome, reason, templateSlug: s.type === "email" ? s.template : null });

  for (const e of listed) {
    const s = steps.get(e.key)!;
    if (ended || (jumpTo !== null && e.key !== jumpTo)) {
      push(e, s, "condition_false", "branch_not_taken");
      continue;
    }
    jumpTo = null;
    if (e.state === "skipped") {
      push(e, s, "late_entry", e.reason ?? "late_entry");
      continue;
    }
    // A-11a: the flag gate.
    if (!flagOn) {
      push(e, s, "condition_false", `flag_off:${p.requiresFlag}`);
      continue;
    }
    // A-28: a time-sensitive step already more than 24 hours late is skipped when it runs
    // (`skipped_paused` or `skipped_stale`; both are `late_entry` here).
    const overdue = overdueOutcome(s.type, new Date(e.due_at), p.now, false);
    if (overdue !== "run") {
      push(e, s, "late_entry", overdue);
      continue;
    }
    // A-26 / A-27: `unless` on the current facts.
    if (s.unless) {
      const r = evaluateCondition(s.unless, facts, b.scope);
      if (r.result) {
        push(e, s, "condition_false", `unless:${r.predicate}`);
        continue;
      }
    }
    if (s.type === "condition") {
      const r = evaluateCondition(s.if, facts, b.scope);
      const target = r.result ? s.then : s.else;
      push(e, s, "will_send", `${r.result ? "then" : "else"}:${target}`);
      if (target === "end") ended = true;
      else jumpTo = target;
      continue;
    }
    if (s.type !== "email") {
      push(e, s, "will_send", null);
      continue;
    }
    // A-31: template, reachability for a marketing send, locale.
    const info = templates.get(s.template);
    if (!info) {
      push(e, s, "failed", "template_unavailable");
      continue;
    }
    const asMarketing = s.send_as === "marketing" || info.kind === "marketing";
    if (asMarketing) {
      const purpose = s.send_as === "marketing" ? p.purpose : (info.purpose ?? p.purpose);
      if (!purpose) {
        push(e, s, "unreachable", "no_purpose");
        continue;
      }
      const r = await reachability(purpose);
      if (!r.isReachable) {
        push(e, s, "unreachable", r.blockedReason ?? `purpose ${purpose} not reachable`);
        continue;
      }
    }
    if (!(info.locales as readonly string[]).includes(p.locale)) {
      push(e, s, "translation_missing", `locale ${p.locale} missing in template ${s.template}`);
      continue;
    }
    if (asMarketing) {
      const fr = await frequencyBasis();
      const due = new Date(e.due_at);
      const judged = predictFrequency(due.getTime() < p.now.getTime() ? p.now : due, fr.sends, fr.rules);
      if (judged.outcome === "frequency_cap") {
        push(e, s, "frequency_cap", judged.reason, judged.at);
        continue;
      }
      fr.sends.push(judged.at);
      push(e, s, "will_send", judged.reason, judged.at);
      continue;
    }
    push(e, s, "will_send", null);
  }
  return out;
}

/**
 * A-32 for one marketing step run at `at`: inside the quiet hours it is deferred to their end and
 * judged again there (the deferred job re-runs the checks), then sent or capped.
 */
export function predictFrequency(
  at: Date,
  sends: readonly Date[],
  rules: AutomationRules,
): { outcome: "will_send" | "frequency_cap"; at: Date; reason: string | null } {
  let when = at;
  let deferred = false;
  // A deferral ends outside the quiet hours; the bound only guards a malformed setting.
  for (let i = 0; i < 3; i++) {
    const input = { now: when, recentMarketingSends: [...sends], rules };
    const decision = applyFrequencyRules(input);
    if (decision.action === "defer") {
      if (decision.until.getTime() <= when.getTime()) break;
      when = decision.until;
      deferred = true;
      continue;
    }
    if (decision.action === "skip") return { outcome: "frequency_cap", at: when, reason: frequencyCapReason(input) ?? "frequency_cap" };
    break;
  }
  return { outcome: "will_send", at: when, reason: deferred ? "quiet_hours" : null };
}
