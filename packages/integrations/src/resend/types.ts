/**
 * Resend types (email spec section 6). `OutgoingEmail` is a superset of the Wave 0
 * `SendEmailInput` fields (platform-P3): `to` may be a list, `replyTo` and `tags` are optional,
 * attachments carry bytes and an optional content type, and `inline` sends `content_id =
 * filename` for `cid:` images.
 */
import type { FetchLike, OnCall } from "../_shared/types";

export type EmailAttachment = { filename: string; content: Uint8Array; contentType?: string; inline?: boolean };

/** Tags on every message: `message_id`, `kind`, `campaign_id` when present. */
export type EmailTag = { name: string; value: string };

export type OutgoingEmail = {
  from: string;
  to: string | readonly string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  tags?: readonly EmailTag[];
  /** Single sends only; a batch never carries attachments. */
  attachments?: readonly EmailAttachment[];
};

/** `sendEmail` input: an `OutgoingEmail` plus the `Idempotency-Key` (`email:<message_id>`). */
export type SendEmailInput = OutgoingEmail & { idempotencyKey: string };

export type ResendDomainName = "mail.beam.be" | "news.beam.be";
export type ResendDomainStatus = "verified" | "pending" | "failed" | "not_started";
export type ResendDomain = { status: ResendDomainStatus; records: { type: string; name: string; status: string }[] };

export const RESEND_BATCH_MAX = 100;

export interface ResendClient {
  sendEmail(msg: SendEmailInput): Promise<{ id: string }>;
  /** 1 to 100 messages without attachments; `Idempotency-Key` `campaign:<id>:chunk:<n>:batch:<k>`. Ids in input order. */
  sendBatch(msgs: readonly OutgoingEmail[], opts: { idempotencyKey: string }): Promise<{ ids: string[] }>;
  getDomain(name: ResendDomainName): Promise<ResendDomain>;
  /** Called only by ops' `privacy.erase_external`; 404 -> `{ deleted: false }`. */
  deleteContact(email: string): Promise<{ deleted: boolean }>;
}

export type ResendClientOptions = {
  apiKey: string;
  onCall?: OnCall;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  /** `settings.email_config.resend_domain_ids`; without an id `getDomain` looks the domain up by name. */
  domainIds?: Partial<Record<ResendDomainName, string>>;
};
