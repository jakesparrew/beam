/**
 * The Resend client (email spec section 6), EU region. Wave 0 (platform-P3) shipped `sendEmail`;
 * email-P1 keeps its name and fields and adds `sendBatch`, `getDomain` and `deleteContact`.
 *
 * Calls: `POST /emails`, `POST /emails/batch`, `GET /domains/{id}` (or `GET /domains` to find the
 * id by name), `DELETE /contacts/{email}`. Every call is reported through `onCall` (operation,
 * status, duration; never bodies). Failures throw `IntegrationError { provider: 'resend',
 * retryable }`: retryable for network errors, timeouts, 429 and 5xx; other 4xx are permanent.
 */
import { z } from "zod";
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError } from "../_shared/errors";
import { trackCall, withTimeout } from "../_shared/timeout";
import { noopOnCall, type FetchLike } from "../_shared/types";
import {
  RESEND_BATCH_MAX,
  type EmailAttachment,
  type OutgoingEmail,
  type ResendClient,
  type ResendClientOptions,
  type ResendDomain,
  type ResendDomainName,
  type ResendDomainStatus,
} from "./types";

export type {
  EmailAttachment,
  EmailTag,
  OutgoingEmail,
  ResendClient,
  ResendClientOptions,
  ResendDomain,
  ResendDomainName,
  ResendDomainStatus,
  SendEmailInput,
} from "./types";
export { RESEND_BATCH_MAX } from "./types";

const SendResponse = z.object({ id: z.string().min(1) });
const BatchResponse = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });
const DomainResponse = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  status: z.string(),
  records: z
    .array(z.object({ record: z.string().optional(), type: z.string().optional(), name: z.string().optional(), status: z.string().optional() }).passthrough())
    .default([]),
});
const DomainList = z.object({ data: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()) });

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function attachmentBody(a: EmailAttachment) {
  return {
    filename: a.filename,
    content: base64(a.content),
    ...(a.contentType ? { content_type: a.contentType } : {}),
    ...(a.inline ? { content_id: a.filename } : {}),
  };
}

/** The JSON body of one message for `POST /emails` and `POST /emails/batch`. */
export function emailBody(msg: OutgoingEmail): Record<string, unknown> {
  return {
    from: msg.from,
    to: typeof msg.to === "string" ? [msg.to] : [...msg.to],
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    headers: msg.headers,
    ...(msg.tags?.length ? { tags: msg.tags.map((t) => ({ name: t.name, value: t.value })) } : {}),
    ...(msg.attachments?.length ? { attachments: msg.attachments.map(attachmentBody) } : {}),
  };
}

/** Refuses a batch outside 1..100 messages or with attachments (a programming error; never retried). */
export function assertBatch(msgs: readonly OutgoingEmail[]): void {
  const refuse = (code: string, message: string) => new IntegrationError({ provider: "resend", operation: "emails.batch", retryable: false, code, message });
  if (msgs.length === 0) throw refuse("batch_empty", "resend emails.batch: no messages");
  if (msgs.length > RESEND_BATCH_MAX) throw refuse("batch_too_large", `resend emails.batch: ${msgs.length} messages, the limit is ${RESEND_BATCH_MAX}`);
  if (msgs.some((m) => m.attachments?.length)) throw refuse("batch_attachments", "resend emails.batch: batches never carry attachments");
}

const DOMAIN_STATUSES: readonly ResendDomainStatus[] = ["verified", "pending", "failed", "not_started"];

/** Resend's domain status, narrowed (`temporary_failure` and unknown values read as `pending`). */
export function domainStatusOf(status: string): ResendDomainStatus {
  return (DOMAIN_STATUSES as readonly string[]).includes(status) ? (status as ResendDomainStatus) : "pending";
}

export function createResendClient(options: ResendClientOptions): ResendClient {
  const onCall = options.onCall ?? noopOnCall;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = (options.baseUrl ?? "https://api.resend.com").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 15_000;

  /** One tracked HTTP call; `accept` lets a status (404 of a delete) through as a value. */
  function call<T>(
    operation: string,
    req: { method: string; path: string; digestPath?: string; body?: unknown; idempotencyKey?: string },
    parse: (res: Response) => Promise<T>,
    accept: (status: number) => boolean = () => false,
  ): Promise<T> {
    return trackCall(onCall, { provider: "resend", operation, requestDigest: digestRequest({ method: req.method, path: req.digestPath ?? req.path }) }, () =>
      withTimeout(
        async (signal) => {
          const res = await doFetch(`${base}${req.path}`, {
            method: req.method,
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              ...(req.body === undefined ? {} : { "content-type": "application/json" }),
              ...(req.idempotencyKey ? { "idempotency-key": req.idempotencyKey } : {}),
            },
            ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
            signal,
          });
          if (!res.ok && !accept(res.status)) throw errorFromStatus("resend", operation, res.status, await res.text().catch(() => ""));
          return { value: await parse(res), statusCode: res.status };
        },
        timeoutMs,
        { provider: "resend", operation },
      ),
    );
  }

  const invalid = (operation: string, status: number, what: string) =>
    new IntegrationError({ provider: "resend", operation, retryable: true, statusCode: status, code: "invalid_response", message: `resend ${operation}: ${what}` });

  async function domainId(name: ResendDomainName): Promise<string> {
    const configured = options.domainIds?.[name];
    if (configured) return configured;
    const list = await call("domains.list", { method: "GET", path: "/domains" }, async (res) => {
      const parsed = DomainList.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw invalid("domains.list", res.status, "unexpected response");
      return parsed.data.data;
    });
    const found = list.find((d) => d.name === name);
    if (!found) throw new IntegrationError({ provider: "resend", operation: "domains.get", retryable: false, code: "domain_not_found", message: `resend domains.get: ${name} is not in the account` });
    return found.id;
  }

  return {
    sendEmail(input) {
      return call("emails.send", { method: "POST", path: "/emails", body: emailBody(input), idempotencyKey: input.idempotencyKey }, async (res) => {
        const parsed = SendResponse.safeParse(await res.json().catch(() => null));
        if (!parsed.success) throw invalid("emails.send", res.status, "response without id");
        return { id: parsed.data.id };
      });
    },

    async sendBatch(msgs, opts) {
      assertBatch(msgs);
      return call("emails.batch", { method: "POST", path: "/emails/batch", body: msgs.map(emailBody), idempotencyKey: opts.idempotencyKey }, async (res) => {
        const parsed = BatchResponse.safeParse(await res.json().catch(() => null));
        if (!parsed.success || parsed.data.data.length !== msgs.length) throw invalid("emails.batch", res.status, "response ids do not match the batch");
        return { ids: parsed.data.data.map((d) => d.id) };
      });
    },

    async getDomain(name) {
      const id = await domainId(name);
      return call("domains.get", { method: "GET", path: `/domains/${encodeURIComponent(id)}` }, async (res): Promise<ResendDomain> => {
        const parsed = DomainResponse.safeParse(await res.json().catch(() => null));
        if (!parsed.success) throw invalid("domains.get", res.status, "unexpected response");
        return {
          status: domainStatusOf(parsed.data.status),
          records: parsed.data.records.map((r) => ({ type: r.type ?? r.record ?? "unknown", name: r.name ?? "", status: r.status ?? "unknown" })),
        };
      });
    },

    deleteContact(email) {
      return call(
        "contacts.delete",
        { method: "DELETE", path: `/contacts/${encodeURIComponent(email.trim().toLowerCase())}`, digestPath: "/contacts/:email" },
        (res) => Promise.resolve({ deleted: res.status !== 404 }),
        (status) => status === 404,
      );
    },
  };
}
