/**
 * automation types named in the cross-module contract (02-data-model section 6.9). Wave 0
 * skeleton by platform-P7; automation owns this file from automation-P1 on.
 */
export type AutomationRunOutcome =
  | "entered"
  | "scheduled"
  | "sent"
  | "task_created"
  | "tag_applied"
  | "tag_removed"
  | "field_set"
  | "status_set"
  | "enrolled"
  | "notified"
  | "webhook_called"
  | "branched"
  | "skipped_late_entry"
  | "skipped_condition"
  | "skipped_unreachable"
  | "skipped_translation"
  | "skipped_exclusive"
  | "skipped_paused"
  | "skipped_stale"
  | "skipped_frequency_cap"
  | "exited"
  | "completed"
  | "failed";

export type EnrolResult =
  | { status: "enrolled"; enrolmentId: string }
  | { status: "skipped"; outcome: "skipped_exclusive" | "skipped_unreachable" | "audience" | "re_entry" | "inactive" | "anchor_missing" };

export type AutomationTimelineItem = {
  id: string;
  occurredAt: Date;
  automationSlug: string;
  automationName: string;
  stepKey: string | null;
  outcome: AutomationRunOutcome;
  reason: string | null;
  endReason: string | null;
  emailMessageId: string | null;
  emailStatus: string | null;
  taskId: string | null;
};

export type PersonEnrolmentSummary = {
  enrolmentId: string;
  automationSlug: string;
  automationName: string;
  status: "active" | "completed" | "exited";
  enteredAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  nextStepKey: string | null;
  nextStepAt: Date | null;
};
