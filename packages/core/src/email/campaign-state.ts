/**
 * Campaign lifecycle (email spec rule 25). Pure. `canTransition()` is the single check; every
 * status write is `update campaigns set status = $to where id = $id and status = $from` after
 * `select ... for update`, so two concurrent transitions cannot both win.
 *
 * draft -> planning -> scheduled -> sending -> sent; sending <-> paused; paused -> sent (resume
 * with nothing planned); sending|paused -> stopped; draft|scheduled -> cancelled; scheduled ->
 * draft (unschedule); planning -> draft (plan failure). sent, stopped, cancelled are terminal.
 */
import { PermanentError } from "../errors";

export const CAMPAIGN_STATUSES = ["draft", "planning", "scheduled", "sending", "paused", "sent", "stopped", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const TERMINAL_CAMPAIGN_STATUSES = ["sent", "stopped", "cancelled"] as const satisfies readonly CampaignStatus[];

/** Every allowed move, keyed by the status it leaves. */
export const CAMPAIGN_TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  draft: ["planning", "cancelled"],
  planning: ["scheduled", "draft"],
  scheduled: ["sending", "cancelled", "draft"],
  sending: ["sent", "paused", "stopped"],
  paused: ["sending", "sent", "stopped"],
  sent: [],
  stopped: [],
  cancelled: [],
};

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminalCampaignStatus(status: CampaignStatus): boolean {
  return (TERMINAL_CAMPAIGN_STATUSES as readonly CampaignStatus[]).includes(status);
}

/** Statuses in which a campaign still uses its segment (crm's `isSegmentInUse` guard). */
export const ACTIVE_CAMPAIGN_STATUSES: readonly CampaignStatus[] = CAMPAIGN_STATUSES.filter((s) => !isTerminalCampaignStatus(s));

/** Statuses in which a planned recipient may be removed or restored (rule 28). */
export const RECIPIENT_EDIT_STATUSES = ["scheduled", "paused"] as const satisfies readonly CampaignStatus[];

/** Statuses that block archiving the campaign's template (rule 15). */
export const TEMPLATE_LOCKING_STATUSES = ["scheduled", "sending", "paused"] as const satisfies readonly CampaignStatus[];

/** A refused campaign status move. */
export class CampaignTransitionError extends PermanentError {
  override readonly name: string = "CampaignTransitionError";
  readonly code = "invalid_transition" as const;
  readonly from: CampaignStatus;
  readonly to: CampaignStatus;
  constructor(from: CampaignStatus, to: CampaignStatus) {
    super(`invalid_transition: ${from} -> ${to}`);
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: CampaignStatus, to: CampaignStatus): void {
  if (!canTransition(from, to)) throw new CampaignTransitionError(from, to);
}
