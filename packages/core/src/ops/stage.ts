/**
 * B2C stage derivation (ops rules 8-14a). Pure: the stats engine (ops-P2) gathers the inputs
 * in SQL and calls this per person; the first matching rule wins. The stage is derived only;
 * staff correct the commercial status through crm's `status_override`, never the stage.
 */
import { RETENTION_DEFAULTS, type StageThresholds } from "./retention-defaults";

/** Values of `person_stats_b2c_stage`, in pipeline order. */
export const B2C_STAGES = [
  "lead",
  "engaged_lead",
  "experienced",
  "first_visit",
  "first_purchase",
  "active",
  "repeat",
  "member",
  "retention",
  "lost",
] as const;
export type B2cStage = (typeof B2C_STAGES)[number];

const DAY_MS = 86_400_000;

export type StageInput = {
  /** `v_person_status.status` (honours `status_override`, rule 8). */
  status: "lead" | "customer" | "member";
  /** Paid orders plus imported purchases. */
  purchases: number;
  /** Attended day or night bookings plus imported visits; no-shows are never visits (rule 3). */
  visits: number;
  /** Informational: no-shows never count as visits and never move the stage forward. */
  noShows?: number;
  lastVisitAt: Date | null;
  lastPurchaseAt: Date | null;
  hasFutureBooking: boolean;
  /** Attended an event session or a webinar (live, replay or on demand), rule 12. */
  attendedEventOrWebinar: boolean;
  /** Latest form completion, email click, webinar registration or booking made, rule 13. */
  lastEngagementAt: Date | null;
  now: Date;
  /** `settings.retention_defaults` stage thresholds; defaults to the seeded values. */
  thresholds?: Partial<StageThresholds>;
};

/** The later of the last visit and the last purchase (the anchor of rules 9, 10 and 15). */
export function stageAnchor(input: Pick<StageInput, "lastVisitAt" | "lastPurchaseAt">): Date | null {
  const { lastVisitAt: v, lastPurchaseAt: p } = input;
  if (v && p) return v.getTime() >= p.getTime() ? v : p;
  return v ?? p ?? null;
}

function olderThan(at: Date | null, days: number, now: Date): boolean {
  return at !== null && now.getTime() - at.getTime() > days * DAY_MS;
}

/** Rules 8-13, first match wins. */
export function computeB2cStage(input: StageInput): B2cStage {
  const t: StageThresholds = {
    stage_retention_days: input.thresholds?.stage_retention_days ?? RETENTION_DEFAULTS.stage_retention_days,
    stage_lost_days: input.thresholds?.stage_lost_days ?? RETENTION_DEFAULTS.stage_lost_days,
    stage_engaged_window_days: input.thresholds?.stage_engaged_window_days ?? RETENTION_DEFAULTS.stage_engaged_window_days,
  };
  const purchases = Math.max(0, input.purchases);
  const visits = Math.max(0, input.visits);
  // Rule 8.
  if (input.status === "member") return "member";
  // Rules 9 and 10.
  if (purchases >= 1 && !input.hasFutureBooking) {
    const anchor = stageAnchor(input);
    if (olderThan(anchor, t.stage_lost_days, input.now)) return "lost";
    if (olderThan(anchor, t.stage_retention_days, input.now)) return "retention";
  }
  // Rule 11.
  if (purchases >= 2) return "repeat";
  if (purchases === 1 && visits >= 2) return "active";
  if (purchases === 1) return "first_purchase";
  // Rule 12.
  if (visits >= 1) return "first_visit";
  if (input.attendedEventOrWebinar) return "experienced";
  // Rule 13.
  const engaged = input.lastEngagementAt;
  if (engaged && input.now.getTime() - engaged.getTime() <= t.stage_engaged_window_days * DAY_MS) return "engaged_lead";
  return "lead";
}

/** Rule 14: the dedupe key of the `ops.stage_changed` event (Brussels date `YYYY-MM-DD`). */
export function stageChangedDedupeKey(personId: string, to: B2cStage, brusselsDate: string): string {
  return `stage:${personId}:${to}:${brusselsDate}`;
}
