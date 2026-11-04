/**
 * Exclusive groups (A-15, A-9). A group's exclusivity domain is `coalesce(lane, key)` when it is
 * exclusive, else null. Inside a domain the lower `(group priority, automation priority)` wins.
 */

/** The rank of an automation inside its exclusivity domain; lower wins. */
export type Rank = { groupPriority: number; automationPriority: number };

/** `coalesce(lane, key)` of an exclusive group, else null (`automation_enrolments.exclusive_domain`). */
export function exclusiveDomain(group: { key: string; isExclusive: boolean; lane: string | null }): string | null {
  return group.isExclusive ? (group.lane ?? group.key) : null;
}

/** Negative when `a` ranks before (wins over) `b`, zero when equal. */
export function compareRank(a: Rank, b: Rank): number {
  return a.groupPriority - b.groupPriority || a.automationPriority - b.automationPriority;
}

/**
 * A-15: with no active enrolment in the domain the candidate enrols; a strictly lower pair
 * supersedes the active enrolment; an equal or higher pair is skipped (`skipped_exclusive`).
 */
export function resolveExclusivity(candidate: Rank, active: (Rank & { enrolmentId: string }) | null): "enrol" | "supersede" | "skip" {
  if (!active) return "enrol";
  return compareRank(candidate, active) < 0 ? "supersede" : "skip";
}

/** A-9 step 3: trigger matches run by group priority, then automation priority, then slug. */
export function compareTriggerOrder(a: Rank & { slug: string }, b: Rank & { slug: string }): number {
  return compareRank(a, b) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}
