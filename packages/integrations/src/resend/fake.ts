/**
 * The Resend fake (runbook section 1.5): `sendEmail` returns `fake_<uuid>` ids and records the
 * message in memory. The same idempotency key returns the same id, as Resend does.
 */
import { randomUUID } from "node:crypto";
import { digestRequest } from "../_shared/digest";
import { errorFromStatus } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type OnCall } from "../_shared/types";
import type { ResendClient, SendEmailInput } from "./client";

export type ResendFakeMessage = SendEmailInput & { id: string; at: Date };

export type ResendFake = ResendClient & {
  readonly sent: ResendFakeMessage[];
  /** Messages sent to an address (case-insensitive). */
  sentTo(address: string): ResendFakeMessage[];
  failNext(status?: number): void;
  reset(): void;
};

export function createResendFake(options: { onCall?: OnCall; now?: () => Date } = {}): ResendFake {
  const onCall = options.onCall ?? noopOnCall;
  const now = options.now ?? (() => new Date());
  const sent: ResendFakeMessage[] = [];
  const byKey = new Map<string, string>();
  const failures: number[] = [];
  return {
    sent,
    sendEmail(input) {
      return trackCall(onCall, { provider: "resend", operation: "emails.send", requestDigest: digestRequest({ method: "POST", path: "/emails" }) }, () => {
        const status = failures.shift();
        if (status !== undefined) throw errorFromStatus("resend", "emails.send", status);
        const existing = byKey.get(input.idempotencyKey);
        if (existing) return { value: { id: existing }, statusCode: 200 };
        const id = `fake_${randomUUID()}`;
        byKey.set(input.idempotencyKey, id);
        sent.push({ ...input, id, at: now() });
        return { value: { id }, statusCode: 200 };
      });
    },
    sentTo(address) {
      const a = address.toLowerCase();
      return sent.filter((m) => (typeof m.to === "string" ? [m.to] : m.to).some((t) => t.toLowerCase() === a));
    },
    failNext(status = 500) {
      failures.push(status);
    },
    reset() {
      sent.length = 0;
      byKey.clear();
      failures.length = 0;
    },
  };
}
