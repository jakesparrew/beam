/**
 * Exits (A-21, A-22, A-24). `matchesExit` checks one definition's `exit_on` against an event;
 * `builtInExitReason` applies the exits every automation has; `exitGuard` is the A-22 guard.
 */
import type { AutomationPurpose, Definition, ExitOnEntry } from "./definition";
import { eventSubjectKey, matchesFilter, type EventView, type FilterVars } from "./filter";

/** The 15 values of `automation_enrolments.end_reason` (prefixes for the parameterised ones). */
export const END_REASONS = [
  "completed",
  "exit_event",
  "unsubscribed",
  "consent_withdrawn",
  "restricted",
  "objected",
  "manual",
  "moved",
  "superseded",
  "migrated",
  "exit_step",
  "erased",
  "merged",
  "archived",
  "anchor_passed",
] as const;
export type EndReasonBase = (typeof END_REASONS)[number];

/** The base of an end reason (`exit_event:order.paid` -> `exit_event`), for catalogue keys. */
export const endReasonBase = (reason: string): string => reason.split(":")[0]!;

type ExitEvent = Pick<EventView, "kind" | "refType" | "refId" | "data">;

/** `kind:q` qualifier: `data.purpose = q`, `data.scope = q` or one of `data.lines[].kind = q`. */
function qualifierMatches(ev: ExitEvent, q: string): boolean {
  if (ev.data.purpose === q || ev.data.scope === q) return true;
  const lines = ev.data.lines;
  return Array.isArray(lines) && lines.some((l) => l !== null && typeof l === "object" && (l as { kind?: unknown }).kind === q);
}

/** One `exit_on` entry against an event. */
export function matchesExitEntry(entry: ExitOnEntry, ev: ExitEvent, subjectKey: string, vars?: FilterVars): boolean {
  if (typeof entry === "string") {
    const sep = entry.indexOf(":");
    if (sep < 0) return entry === ev.kind;
    return entry.slice(0, sep) === ev.kind && qualifierMatches(ev, entry.slice(sep + 1));
  }
  if (entry.event !== ev.kind) return false;
  if (entry.same_subject) {
    const evSubject = eventSubjectKey(ev);
    if (evSubject === "" || evSubject !== subjectKey) return false;
  }
  return matchesFilter(entry.where, ev, vars);
}

/**
 * A-22: true when any `exit_on` entry matches. `vars.trigger.data` is the enrolment's
 * `context.trigger.data`, which `{{trigger.data.<key>}}` literals in a `where` resolve against.
 */
export function matchesExit(exitOn: Definition["exit_on"], ev: ExitEvent, subjectKey: string, vars?: FilterVars): boolean {
  return exitOn.some((entry) => matchesExitEntry(entry, ev, subjectKey, vars));
}

/** The kind of the first matching entry (for `exit_event:<kind>`), or null. */
export function matchingExitKind(exitOn: Definition["exit_on"], ev: ExitEvent, subjectKey: string, vars?: FilterVars): string | null {
  return matchesExit(exitOn, ev, subjectKey, vars) ? ev.kind : null;
}

/**
 * A-22 guard: an event only exits enrolments whose `trigger_event_id` is null or lower than the
 * event id, so it never ends the enrolment it created (gap re-read, retry) or a later one.
 */
export function exitGuard(enrolment: { triggerEventId: bigint | number | string | null }, ev: Pick<EventView, "id">): boolean {
  if (enrolment.triggerEventId === null) return true;
  return BigInt(enrolment.triggerEventId) < BigInt(ev.id);
}

export type ExitAutomation = { isMarketing: boolean; purpose: AutomationPurpose | null };

/**
 * A-21 and A-24: built-in exits, whatever `exit_on` says. Returns the end reason or null.
 * `person.merged` ends every journey of the loser; the suppression, restriction and objection
 * exits apply to marketing automations only; consent withdrawal needs the automation purpose.
 */
export function builtInExitReason(ev: Pick<EventView, "kind" | "data">, automation: ExitAutomation): string | null {
  switch (ev.kind) {
    case "person.merged":
      return "merged";
    case "suppression.added": {
      if (!automation.isMarketing || !automation.purpose) return null;
      const scope = ev.data.scope;
      return scope === "all" || scope === automation.purpose ? "unsubscribed" : null;
    }
    case "consent.withdrawn":
      return automation.purpose !== null && ev.data.purpose === automation.purpose ? `consent_withdrawn:${automation.purpose}` : null;
    case "privacy.restricted":
      return automation.isMarketing ? "restricted" : null;
    case "privacy.objected":
      return automation.isMarketing ? "objected" : null;
    default:
      return null;
  }
}

/** A-23: a suppression scope covers an automation purpose (`all` covers every purpose). */
export const suppressionCovers = (scope: string, purpose: AutomationPurpose | null): boolean =>
  purpose !== null && (scope === "all" || scope === purpose);
