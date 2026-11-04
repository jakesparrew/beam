import { describe, expect, it } from "vitest";
import {
  bounceTypeOf,
  EMAIL_EVENT_TYPES,
  mapResendEventType,
  MESSAGE_STATUS_RANK,
  messageEventPatch,
  nextMessageStatus,
  type EmailEventType,
  type MessageEventState,
} from "./message-status";
import type { MessageStatus } from "./types";

const fresh = (status: MessageStatus = "queued"): MessageEventState => ({
  status,
  bounceType: null,
  sentAt: null,
  deliveredAt: null,
  openedAt: null,
  clickedAt: null,
  bouncedAt: null,
  complainedAt: null,
  lastEventAt: null,
});

function apply(state: MessageEventState, events: { type: EmailEventType; at: string; bounceType?: "hard" | "soft" }[]): MessageEventState {
  let s = state;
  for (const e of events) s = { ...s, ...messageEventPatch(s, { type: e.type, occurredAt: new Date(e.at), ...(e.bounceType ? { bounceType: e.bounceType } : {}) }) };
  return s;
}

describe("message status (rule 47)", () => {
  it("ranks queued < sent < delivered < bounced = complained = failed", () => {
    expect(MESSAGE_STATUS_RANK.queued).toBeLessThan(MESSAGE_STATUS_RANK.sent);
    expect(MESSAGE_STATUS_RANK.sent).toBeLessThan(MESSAGE_STATUS_RANK.delivered);
    expect(MESSAGE_STATUS_RANK.delivered).toBeLessThan(MESSAGE_STATUS_RANK.bounced);
    expect(MESSAGE_STATUS_RANK.bounced).toBe(MESSAGE_STATUS_RANK.complained);
    expect(MESSAGE_STATUS_RANK.complained).toBe(MESSAGE_STATUS_RANK.failed);
  });

  it("moves forward only", () => {
    expect(nextMessageStatus("queued", "sent")).toBe("sent");
    expect(nextMessageStatus("sent", "delivered")).toBe("delivered");
    expect(nextMessageStatus("delivered", "sent")).toBe("delivered");
    expect(nextMessageStatus("delivered", "bounced")).toBe("bounced");
    expect(nextMessageStatus("bounced", "delivered")).toBe("bounced");
    expect(nextMessageStatus("sent", "failed")).toBe("failed");
  });

  it("never changes the status on delayed, opened or clicked", () => {
    for (const type of ["delayed", "opened", "clicked"] as const) {
      expect(nextMessageStatus("sent", type)).toBe("sent");
      expect(nextMessageStatus("delivered", type)).toBe("delivered");
    }
  });

  it("leaves blocked_translation and suppressed alone", () => {
    for (const type of EMAIL_EVENT_TYPES) {
      expect(nextMessageStatus("blocked_translation", type)).toBe("blocked_translation");
      expect(nextMessageStatus("suppressed", type)).toBe("suppressed");
    }
  });

  it("ends in the same state when events arrive out of order (delivered before sent)", () => {
    const inOrder = apply(fresh(), [
      { type: "sent", at: "2026-11-03T10:00:00Z" },
      { type: "delivered", at: "2026-11-03T10:00:05Z" },
    ]);
    const outOfOrder = apply(fresh(), [
      { type: "delivered", at: "2026-11-03T10:00:05Z" },
      { type: "sent", at: "2026-11-03T10:00:00Z" },
    ]);
    expect(outOfOrder).toEqual(inOrder);
    expect(inOrder).toMatchObject({ status: "delivered", sentAt: new Date("2026-11-03T10:00:00Z"), lastEventAt: new Date("2026-11-03T10:00:05Z") });
  });

  it("keeps bounced and still sets complained_at for a complaint after a bounce", () => {
    const s = apply(fresh("sent"), [
      { type: "bounced", at: "2026-11-03T10:01:00Z", bounceType: "hard" },
      { type: "complained", at: "2026-11-03T10:02:00Z" },
    ]);
    expect(s).toMatchObject({ status: "bounced", bounceType: "hard", bouncedAt: new Date("2026-11-03T10:01:00Z"), complainedAt: new Date("2026-11-03T10:02:00Z") });
  });

  it("sets first-occurrence timestamps once; a click also sets opened_at", () => {
    const s = apply(fresh("delivered"), [
      { type: "clicked", at: "2026-11-03T11:00:00Z" },
      { type: "opened", at: "2026-11-03T11:05:00Z" },
      { type: "clicked", at: "2026-11-03T11:10:00Z" },
    ]);
    expect(s.clickedAt).toEqual(new Date("2026-11-03T11:00:00Z"));
    expect(s.openedAt).toEqual(new Date("2026-11-03T11:00:00Z"));
    expect(s.lastEventAt).toEqual(new Date("2026-11-03T11:10:00Z"));
  });

  it("maps Resend webhook types (rule 46)", () => {
    expect(mapResendEventType("email.delivery_delayed")).toBe("delayed");
    expect(mapResendEventType("email.bounced")).toBe("bounced");
    expect(mapResendEventType("email.received")).toBe("received");
    expect(mapResendEventType("contact.created")).toBeNull();
    expect(bounceTypeOf("Permanent")).toBe("hard");
    expect(bounceTypeOf("Transient")).toBe("soft");
    expect(bounceTypeOf(undefined)).toBe("soft");
  });
});
