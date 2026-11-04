/**
 * Step planning (A-17, A-18, A-28, A-34). The plan is stored as `automation_enrolments.plan`:
 * `[{ key, type, due_at, state }]`, in definition order.
 *
 * Decisions:
 * - The default path is the definition order; a `condition` step plans the steps after it
 *   linearly and `nextStep` re-plans when a branch jumps (steps jumped over are `not_taken`).
 * - A `wait` step is planned (its due time is the end of the wait) but never executed: the
 *   engine passes it, marking it `done`.
 * - `snap_to` on a step timed from the enrolment or the previous step never moves the step
 *   before its base instant; it moves to the next day instead ("+0 at 10:00" entered at 15:00
 *   runs tomorrow at 10:00). Anchor-relative steps keep the date (A-18 handles the past).
 */
import type { Definition, Step, StepType } from "./definition";
import { addBrusselsDays, addMinutes, brusselsAt } from "./time";

export type PlanState = "pending" | "done" | "skipped" | "not_taken";

export type PlannedStep = {
  key: string;
  type: StepType;
  /** ISO timestamp (UTC). */
  due_at: string;
  state: PlanState;
  /** Why a step is `skipped` at planning time (`late_entry`) or re-planned (`anchor_moved`). */
  reason?: string;
};

export type PlanInput = { enteredAt: Date; anchorAt: Date | null };

/** Steps the overdue rule skips when more than 24 hours late (A-28). */
export const TIME_SENSITIVE_STEP_TYPES: readonly StepType[] = ["email", "notify_slack", "webhook"];
export const OVERDUE_LIMIT_MS = 24 * 3_600_000;

const iso = (d: Date) => d.toISOString();

function offsetOf(step: Step): number {
  return step.type === "wait" ? step.minutes + (step.at?.minutes ?? 0) : (step.at?.minutes ?? 0);
}

/** Due time of one step from its base; `previousBase` is the due of the last planned step. */
function computeDue(step: Step, input: PlanInput, previousBase: Date): Date {
  const from = step.at?.from ?? "previous";
  let baseAt: Date;
  if (from === "enrolment") baseAt = input.enteredAt;
  else if (from === "anchor") {
    if (!input.anchorAt) throw new Error(`planSteps: step ${step.key} is anchor-relative but the enrolment has no anchor`);
    baseAt = input.anchorAt;
  } else baseAt = previousBase;
  let due = addMinutes(baseAt, offsetOf(step));
  const snap = step.at?.snap_to;
  if (snap) {
    due = brusselsAt(due, snap);
    if (from !== "anchor" && due.getTime() < baseAt.getTime()) due = brusselsAt(addBrusselsDays(due, 1), snap);
  }
  return due;
}

const isAbsolute = (step: Step) => step.at?.from === "enrolment" || step.at?.from === "anchor";

/**
 * A-17 and A-18: due time per step along the default path. Steps timed from the enrolment or the
 * anchor whose due is before `enteredAt` are `skipped` (`late_entry`), unless `late_entry:
 * send_now`, which makes them due at `enteredAt`. Steps timed from the previous step are never late.
 */
export function planSteps(def: Definition, input: PlanInput): PlannedStep[] {
  const plan: PlannedStep[] = [];
  let previous = input.enteredAt;
  for (const step of def.steps) {
    let due = computeDue(step, input, previous);
    let state: PlanState = "pending";
    let reason: string | undefined;
    if (isAbsolute(step) && due.getTime() < input.enteredAt.getTime()) {
      if (step.late_entry === "send_now") due = input.enteredAt;
      else {
        state = "skipped";
        reason = "late_entry";
      }
    }
    plan.push(reason ? { key: step.key, type: step.type, due_at: iso(due), state, reason } : { key: step.key, type: step.type, due_at: iso(due), state });
    if (state !== "skipped") previous = due;
  }
  return plan;
}

/** The first pending step that runs (waits are passed), or null when nothing is left. */
export function firstPendingStep(plan: readonly PlannedStep[], fromIndex = 0): PlannedStep | null {
  for (let i = fromIndex; i < plan.length; i++) {
    const p = plan[i]!;
    if (p.state === "pending" && p.type !== "wait") return p;
  }
  return null;
}

/** True when nothing in the plan will run (A-16: every step skipped, the enrolment completes). */
export const planIsExhausted = (plan: readonly PlannedStep[]): boolean => firstPendingStep(plan) === null;

/** Marks waits before the first runnable step as passed, returning a new plan. */
function passWaits(plan: PlannedStep[], fromIndex: number): PlannedStep | null {
  for (let i = fromIndex; i < plan.length; i++) {
    const p = plan[i]!;
    if (p.state !== "pending") continue;
    if (p.type === "wait") {
      plan[i] = { ...p, state: "done" };
      continue;
    }
    return p;
  }
  return null;
}

/** The plan after the first scheduling: waits before the first runnable step are passed. */
export function startPlan(plan: readonly PlannedStep[]): { plan: PlannedStep[]; next: PlannedStep | null } {
  const copy = plan.map((p) => ({ ...p }));
  return { plan: copy, next: passWaits(copy, 0) };
}

/** Sets the state of one step, returning a new plan (step-time skips such as `skipped_condition`). */
export function markStep(plan: readonly PlannedStep[], key: string, state: PlanState, reason?: string): PlannedStep[] {
  return plan.map((p) => (p.key === key ? (reason ? { ...p, state, reason } : { ...p, state }) : { ...p }));
}

/** Marks every pending entry `not_taken` (A-25: ending an enrolment). */
export function closePlan(plan: readonly PlannedStep[]): PlannedStep[] {
  return plan.map((p) => (p.state === "pending" ? { ...p, state: "not_taken" as const } : { ...p }));
}

/**
 * A-34: after step `fromKey` ran (or was skipped at step time), the next step. Without `branch`
 * it is the next pending step in definition order. With a branch target, the steps between are
 * `not_taken` and the target and the pending steps after it are re-planned: steps timed from the
 * enrolment or the anchor keep their due time, steps timed from the previous step count from
 * `now` (default: the due time of `fromKey`). `end` closes the rest of the plan.
 */
export function nextStep(
  def: Definition,
  plan: PlannedStep[],
  fromKey: string,
  /** `target` is a later step key or `'end'`. */
  branch?: { target: string },
  now?: Date,
): { plan: PlannedStep[]; next: PlannedStep | null } {
  const out = plan.map((p) => ({ ...p }));
  const fromIndex = out.findIndex((p) => p.key === fromKey);
  if (fromIndex < 0) throw new Error(`nextStep: no step ${fromKey} in the plan`);
  const from = out[fromIndex]!;
  if (from.state === "pending") out[fromIndex] = { ...from, state: "done" };
  if (!branch) return { plan: out, next: passWaits(out, fromIndex + 1) };

  if (branch.target === "end") {
    for (let i = fromIndex + 1; i < out.length; i++) if (out[i]!.state === "pending") out[i] = { ...out[i]!, state: "not_taken" };
    return { plan: out, next: null };
  }
  const targetIndex = out.findIndex((p) => p.key === branch.target);
  if (targetIndex <= fromIndex) throw new Error(`nextStep: branch target ${branch.target} is not after ${fromKey}`);
  for (let i = fromIndex + 1; i < targetIndex; i++) if (out[i]!.state === "pending") out[i] = { ...out[i]!, state: "not_taken" };

  const steps = new Map(def.steps.map((s) => [s.key, s]));
  let previous = now ?? new Date(from.due_at);
  for (let i = targetIndex; i < out.length; i++) {
    const entry = out[i]!;
    if (entry.state !== "pending" && i !== targetIndex) continue;
    const step = steps.get(entry.key);
    if (!step) continue;
    if (i === targetIndex && entry.state === "not_taken") out[i] = { ...entry, state: "pending" };
    if (out[i]!.state !== "pending") continue;
    if (isAbsolute(step)) {
      previous = new Date(out[i]!.due_at);
      continue;
    }
    const due = computeDue(step, { enteredAt: previous, anchorAt: null }, previous);
    out[i] = { ...out[i]!, due_at: iso(due) };
    previous = due;
  }
  return { plan: out, next: passWaits(out, targetIndex) };
}

/**
 * Re-plans the pending steps after the anchor moved (A-27a): due times are recomputed from the
 * new anchor, steps now before `now` are skipped (`anchor_moved`) unless `late_entry: send_now`.
 */
export function replanForAnchor(def: Definition, plan: readonly PlannedStep[], input: PlanInput, now: Date): PlannedStep[] {
  const fresh = planSteps(def, { enteredAt: input.enteredAt, anchorAt: input.anchorAt });
  const byKey = new Map(fresh.map((p) => [p.key, p]));
  const steps = new Map(def.steps.map((s) => [s.key, s]));
  return plan.map((p) => {
    if (p.state !== "pending") return { ...p };
    const f = byKey.get(p.key);
    const step = steps.get(p.key);
    if (!f || !step) return { ...p };
    const due = new Date(f.due_at);
    if (isAbsolute(step) && due.getTime() < now.getTime()) {
      return step.late_entry === "send_now"
        ? { ...p, due_at: iso(now), reason: "anchor_moved" }
        : { ...p, due_at: f.due_at, state: "skipped" as const, reason: "anchor_moved" };
    }
    return { ...p, due_at: f.due_at, reason: "anchor_moved" };
  });
}

/**
 * A-28: an `email`, `notify_slack` or `webhook` step processed more than 24 hours after its due
 * time is skipped (`skipped_paused` when the automation was paused in that window, else
 * `skipped_stale`); every other step type still runs late.
 */
export function overdueOutcome(type: StepType, dueAt: Date, now: Date, pausedDuring: boolean): "run" | "skipped_paused" | "skipped_stale" {
  if (!TIME_SENSITIVE_STEP_TYPES.includes(type)) return "run";
  if (now.getTime() - dueAt.getTime() <= OVERDUE_LIMIT_MS) return "run";
  return pausedDuring ? "skipped_paused" : "skipped_stale";
}
