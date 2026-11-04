/**
 * The Resend fake (runbook section 1.5; email spec section 6): an in-memory store that records
 * every sent message, honours idempotency keys as Resend does (the same key returns the same
 * ids), enforces the batch rules of the real client, and signs webhook bodies for tests.
 *
 * `createFakeResendClient()` (email-P1) makes deterministic ids `re_fake_<n>`. `createResendFake()`
 * is the Wave 0 entry used by `createFakeIntegrations()`; it keeps the Wave 0 `fake_<uuid>` ids
 * so earlier tests keep their assertions. Both have the full surface.
 */
import { randomUUID } from "node:crypto";
import { digestRequest } from "../_shared/digest";
import { errorFromStatus } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type OnCall } from "../_shared/types";
import { assertBatch } from "./client";
import type { OutgoingEmail, ResendClient, ResendDomain, ResendDomainName, SendEmailInput } from "./types";
import { signResendWebhook } from "./webhook";

export type ResendFakeMessage = SendEmailInput & { id: string; at: Date; batchKey: string | null };

export type ResendWebhookRequest = {
  id: string;
  body: string;
  headers: { "svix-id": string; "svix-timestamp": string; "svix-signature": string };
  payload: { type: string; created_at: string; data: Record<string, unknown> };
};

export type ResendFailure = "retryable" | "permanent" | number;

export type ResendFake = ResendClient & {
  readonly sent: ResendFakeMessage[];
  readonly batches: { idempotencyKey: string; ids: string[] }[];
  readonly deletedContacts: string[];
  /** The secret `emitWebhook` signs with (`whsec_...`). */
  readonly webhookSecret: string;
  /** Messages sent to an address (case-insensitive). */
  sentTo(address: string): ResendFakeMessage[];
  /** The next call fails: `retryable` = 503, `permanent` = 422, or an HTTP status. */
  failNext(kind?: ResendFailure): void;
  setDomain(name: ResendDomainName, domain: ResendDomain): void;
  /** A Resend contact that `deleteContact` finds (we never create contacts; the call is defensive). */
  addContact(email: string): void;
  /** A signed webhook delivery for a sent message (`type` such as `email.delivered`). */
  emitWebhook(type: string, messageResendId: string, extra?: Record<string, unknown>): ResendWebhookRequest;
  reset(): void;
};

export type ResendFakeOptions = {
  onCall?: OnCall;
  now?: () => Date;
  /** `sequential` = `re_fake_<n>` (default of `createFakeResendClient`); `uuid` = `fake_<uuid>` (Wave 0). */
  ids?: "sequential" | "uuid";
  webhookSecret?: string;
};

/** A fixed test secret (`whsec_` + base64 of 32 bytes). */
export const FAKE_RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("beam-fake-resend-webhook-secret!").toString("base64")}`;

const verified = (name: string): ResendDomain => ({
  status: "verified",
  records: [
    { type: "MX", name: `send.${name}`, status: "verified" },
    { type: "TXT", name: `send.${name}`, status: "verified" },
    { type: "TXT", name: `resend._domainkey.${name}`, status: "verified" },
  ],
});

export function createResendFake(options: ResendFakeOptions = {}): ResendFake {
  const onCall = options.onCall ?? noopOnCall;
  const now = options.now ?? (() => new Date());
  const idMode = options.ids ?? "uuid";
  const webhookSecret = options.webhookSecret ?? FAKE_RESEND_WEBHOOK_SECRET;
  const sent: ResendFakeMessage[] = [];
  const batches: { idempotencyKey: string; ids: string[] }[] = [];
  const deletedContacts: string[] = [];
  const singleByKey = new Map<string, string>();
  const batchByKey = new Map<string, string[]>();
  const failures: number[] = [];
  const contacts = new Set<string>();
  const domains = new Map<ResendDomainName, ResendDomain>();
  let counter = 0;
  let eventCounter = 0;

  const nextId = () => (idMode === "uuid" ? `fake_${randomUUID()}` : `re_fake_${++counter}`);

  function tracked<T>(operation: string, method: string, path: string, work: () => T) {
    return trackCall(onCall, { provider: "resend", operation, requestDigest: digestRequest({ method, path }) }, () => {
      const status = failures.shift();
      if (status !== undefined) throw errorFromStatus("resend", operation, status);
      return { value: work(), statusCode: 200 };
    });
  }

  const record = (msg: OutgoingEmail, idempotencyKey: string, batchKey: string | null): string => {
    const id = nextId();
    sent.push({ ...msg, idempotencyKey, id, at: now(), batchKey });
    return id;
  };

  return {
    sent,
    batches,
    deletedContacts,
    webhookSecret,

    sendEmail(input) {
      return tracked("emails.send", "POST", "/emails", () => {
        const existing = singleByKey.get(input.idempotencyKey);
        if (existing) return { id: existing };
        const { idempotencyKey, ...msg } = input;
        const id = record(msg, idempotencyKey, null);
        singleByKey.set(idempotencyKey, id);
        return { id };
      });
    },

    async sendBatch(msgs, opts) {
      assertBatch(msgs);
      return tracked("emails.batch", "POST", "/emails/batch", () => {
        const existing = batchByKey.get(opts.idempotencyKey);
        if (existing) return { ids: [...existing] };
        const ids = msgs.map((m, i) => record(m, `${opts.idempotencyKey}#${i}`, opts.idempotencyKey));
        batchByKey.set(opts.idempotencyKey, ids);
        batches.push({ idempotencyKey: opts.idempotencyKey, ids: [...ids] });
        return { ids };
      });
    },

    getDomain(name) {
      return tracked("domains.get", "GET", "/domains/:id", () => structuredClone(domains.get(name) ?? verified(name)));
    },

    deleteContact(email) {
      return tracked("contacts.delete", "DELETE", "/contacts/:email", () => {
        const key = email.trim().toLowerCase();
        const deleted = contacts.delete(key);
        if (deleted) deletedContacts.push(key);
        return { deleted };
      });
    },

    sentTo(address) {
      const a = address.toLowerCase();
      return sent.filter((m) => (typeof m.to === "string" ? [m.to] : m.to).some((t) => t.toLowerCase() === a));
    },

    failNext(kind = 500) {
      failures.push(kind === "retryable" ? 503 : kind === "permanent" ? 422 : kind);
    },

    setDomain(name, domain) {
      domains.set(name, structuredClone(domain));
    },

    addContact(email) {
      contacts.add(email.trim().toLowerCase());
    },

    emitWebhook(type, messageResendId, extra = {}) {
      const at = now();
      const message = sent.find((m) => m.id === messageResendId);
      const data: Record<string, unknown> = {
        email_id: messageResendId,
        created_at: at.toISOString(),
        ...(message ? { from: message.from, to: typeof message.to === "string" ? [message.to] : [...message.to], subject: message.subject } : {}),
        ...extra,
      };
      const payload = { type, created_at: at.toISOString(), data };
      const body = JSON.stringify(payload);
      const id = `msg_fake_${++eventCounter}`;
      const timestamp = String(Math.floor(at.getTime() / 1000));
      return {
        id,
        body,
        payload,
        headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signResendWebhook({ id, timestamp, body, secret: webhookSecret }) },
      };
    },

    reset() {
      sent.length = 0;
      batches.length = 0;
      deletedContacts.length = 0;
      singleByKey.clear();
      batchByKey.clear();
      failures.length = 0;
      contacts.clear();
      domains.clear();
      counter = 0;
      eventCounter = 0;
    },
  };
}

/** The email-P1 fake: deterministic `re_fake_<n>` ids. */
export function createFakeResendClient(options: Omit<ResendFakeOptions, "ids"> = {}): ResendFake {
  return createResendFake({ ...options, ids: "sequential" });
}
