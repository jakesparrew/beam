/**
 * Delivery status of one message (email spec rules 46, 47 and 50). Pure.
 *
 * Status moves forward only by rank `queued(0) < sent(1) < delivered(2) < bounced(3) =
 * complained(3) = failed(3)`; an event of an equal or lower rank never changes the status, so
 * out-of-order webhooks (`delivered` before `sent`) end in the same state. First-occurrence
 * timestamps are set once, whatever the status does: a `complained` event after `bounced` keeps
 * the status `bounced` and still sets `complained_at`. `blocked_translation` and `suppressed`
 * never left our side and no provider event moves them.
 */
import type { MessageStatus } from "./types";

export const EMAIL_EVENT_TYPES = ["sent", "delivered", "delayed", "bounced", "complained", "opened", "clicked", "failed"] as const;
export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number];

export const MESSAGE_STATUS_RANK: Readonly<Record<MessageStatus, number>> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  bounced: 3,
  complained: 3,
  failed: 3,
  blocked_translation: 3,
  suppressed: 3,
};

/** The status an event points at; `null` for events that never change the status. */
const TARGET: Readonly<Record<EmailEventType, MessageStatus | null>> = {
  sent: "sent",
  delivered: "delivered",
  delayed: null,
  bounced: "bounced",
  complained: "complained",
  opened: null,
  clicked: null,
  failed: "failed",
};

/** The status after `eventType` (forward-only by rank). */
export function nextMessageStatus(current: MessageStatus, eventType: EmailEventType): MessageStatus {
  if (current === "blocked_translation" || current === "suppressed") return current;
  const target = TARGET[eventType];
  if (!target) return current;
  return MESSAGE_STATUS_RANK[target] > MESSAGE_STATUS_RANK[current] ? target : current;
}

/** The first-occurrence column each event type fills. */
export const FIRST_OCCURRENCE_COLUMN = {
  sent: "sentAt",
  delivered: "deliveredAt",
  bounced: "bouncedAt",
  complained: "complainedAt",
  opened: "openedAt",
  clicked: "clickedAt",
} as const satisfies Partial<Record<EmailEventType, string>>;

export type MessageTimestamps = {
  sentAt: Date | null;
  deliveredAt: Date | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  bouncedAt: Date | null;
  complainedAt: Date | null;
  lastEventAt: Date | null;
};

export type MessageEventState = MessageTimestamps & { status: MessageStatus; bounceType: "hard" | "soft" | null };

export type MessageEventPatch = Partial<MessageEventState>;

/**
 * The columns to update on `email_messages` for one event: status by rank, the first-occurrence
 * timestamp when still null (a click also sets `opened_at`), `bounce_type` with a bounce that
 * moves the status, and `last_event_at` when the event is newer.
 */
export function messageEventPatch(
  current: MessageEventState,
  event: { type: EmailEventType; occurredAt: Date; bounceType?: "hard" | "soft" | null },
): MessageEventPatch {
  const patch: MessageEventPatch = {};
  const status = nextMessageStatus(current.status, event.type);
  if (status !== current.status) patch.status = status;
  const column = (FIRST_OCCURRENCE_COLUMN as Partial<Record<EmailEventType, keyof MessageTimestamps>>)[event.type];
  if (column && current[column] === null) patch[column] = event.occurredAt;
  if (event.type === "clicked" && current.openedAt === null) patch.openedAt = event.occurredAt;
  if (event.type === "bounced" && event.bounceType && (status === "bounced" || current.bounceType === null)) patch.bounceType = event.bounceType;
  if (!current.lastEventAt || event.occurredAt > current.lastEventAt) patch.lastEventAt = event.occurredAt;
  return patch;
}

/** Resend webhook types (rule 46): outbound ones map to an `email_events.type`. */
export const RESEND_EVENT_MAP: Readonly<Record<string, EmailEventType>> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.failed": "failed",
};

/**
 * The event type of a Resend webhook `type`: an outbound `EmailEventType`, `received` for R3
 * inbound mail (dispatched to crm, never stored in `email_events`), or `null` when unknown.
 */
export function mapResendEventType(type: string): EmailEventType | "received" | null {
  if (type === "email.received") return "received";
  return RESEND_EVENT_MAP[type] ?? null;
}

/** `bounce.type = 'Permanent'` is a hard bounce; everything else soft. */
export function bounceTypeOf(resendBounceType: string | null | undefined): "hard" | "soft" {
  return resendBounceType === "Permanent" ? "hard" : "soft";
}
