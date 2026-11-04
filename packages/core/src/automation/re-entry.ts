/**
 * Re-entry (A-13), judged per person across every subject of the automation.
 */
import { reEntryDays, type ReEntry } from "./definition";
import { DAY_MS } from "./time";

export type EntryHistory = {
  /** Latest `entered_at` of any enrolment of this automation for the person. */
  lastEnteredAt: Date | null;
  /** An active enrolment for the same automation, person and subject exists. */
  hasActive: boolean;
  /** Any enrolment of this automation for the person exists (any subject, any status). */
  everEntered: boolean;
};

/**
 * `never` refuses when the person was ever enrolled; `after_days:N` refuses when the latest
 * entry is less than N days ago; `always` and `after_days:0` allow. An active enrolment for the
 * same subject always refuses (`uq_enrolment_active`).
 */
export function canReEnter(policy: ReEntry, h: EntryHistory, now: Date): boolean {
  if (h.hasActive) return false;
  if (policy === "always") return true;
  if (policy === "never") return !h.everEntered && h.lastEnteredAt === null;
  const days = reEntryDays(policy);
  if (days === null) throw new Error(`canReEnter: unknown policy ${String(policy)}`);
  if (days === 0 || h.lastEnteredAt === null) return true;
  return now.getTime() - h.lastEnteredAt.getTime() >= days * DAY_MS;
}
