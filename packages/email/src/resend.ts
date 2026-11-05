/**
 * `buildOutgoingEmail()`: a rendered message -> the Resend `OutgoingEmail` (email spec rules 2,
 * 3, 43, 51 and section 6).
 *
 * - Marketing messages carry `List-Unsubscribe: <oneClickPostUrl>` and
 *   `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058, https only, no mailto);
 *   transactional messages carry neither, whatever the caller passes. Outside production
 *   (`allowLocalhost`) or with the sink rewrite, an `http://localhost` (or loopback) one-click
 *   URL is accepted too, so local and e2e runs (`APP_URL=http://localhost:3100`) can send
 *   marketing mail; production always requires https.
 * - Every message has an HTML and a text part, else `PermanentError('missing_text_part')`.
 * - Tags: `message_id`, `kind` and `campaign_id` when present.
 * - Outside production the sink rewrite sends to `EMAIL_SINK` and prefixes the subject with
 *   `[<env> → <real address>]`.
 *
 * `OutgoingEmail` mirrors `@beam/integrations/resend`'s type structurally (this package does not
 * depend on the integrations package), so the result is passed to `ResendClient` as is.
 */
import { PermanentError } from "@beam/core/errors";

export type OutgoingAttachment = { filename: string; content: Uint8Array; contentType?: string; inline?: boolean };
export type OutgoingTag = { name: string; value: string };

export type OutgoingEmail = {
  from: string;
  to: string | readonly string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  tags?: readonly OutgoingTag[];
  attachments?: readonly OutgoingAttachment[];
};

/** The rendered message: ids for the tags, the address and the parts. */
export type OutgoingMessage = {
  messageId: string;
  /** `email_messages.kind` (`transactional`, `campaign`, `automation`, `test`); defaults to `options.kind`. */
  messageKind?: string;
  campaignId?: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  attachments?: readonly OutgoingAttachment[];
};

export type BuildOutgoingOptions = {
  /** Marketing content (campaigns, marketing automation steps, D54 registry sends) or transactional. */
  kind: "marketing" | "transactional";
  from: string;
  replyTo: string;
  /** crm's one-click URL built from the message's link token; required for marketing. */
  listUnsubscribe?: { oneClickPostUrl: string } | null;
  /** Outside production: every recipient goes to the sink and the subject names the real address. */
  sinkRewrite?: { sink: string; env: string } | null;
  /** Outside production: accept an `http://localhost` (loopback) one-click URL (also implied by `sinkRewrite`). */
  allowLocalhost?: boolean;
};

/** An `http://` URL on a loopback host: `localhost`, `*.localhost`, `127.x.x.x` or `[::1]`. */
export function isLoopbackHttpUrl(url: string): boolean {
  if (!/^http:\/\/[^\s<>]+$/.test(url)) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host) || host === "[::1]";
}

export const LIST_UNSUBSCRIBE_POST = "List-Unsubscribe=One-Click";

/** The subject prefix of a sink-rewritten message (rule 43). */
export function sinkSubject(subject: string, env: string, realAddress: string): string {
  return `[${env} → ${realAddress}] ${subject}`;
}

function tagValue(value: string): string {
  // Resend accepts ASCII letters, numbers, underscores and dashes in tag values.
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

export function buildOutgoingEmail(msg: OutgoingMessage, options: BuildOutgoingOptions): OutgoingEmail {
  if (!msg.html.trim()) throw new PermanentError("missing_html_part");
  if (!msg.text.trim()) throw new PermanentError("missing_text_part");
  if (!msg.subject.trim()) throw new PermanentError("missing_subject");

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(msg.headers ?? {})) {
    if (!/^list-unsubscribe(-post)?$/i.test(name)) headers[name] = value;
  }
  if (options.kind === "marketing") {
    const url = options.listUnsubscribe?.oneClickPostUrl?.trim();
    if (!url) throw new PermanentError("list_unsubscribe_missing");
    const local = (options.allowLocalhost === true || !!options.sinkRewrite?.sink?.trim()) && isLoopbackHttpUrl(url);
    if (!/^https:\/\/[^\s<>]+$/.test(url) && !local) throw new PermanentError("list_unsubscribe_not_https");
    headers["List-Unsubscribe"] = `<${url}>`;
    headers["List-Unsubscribe-Post"] = LIST_UNSUBSCRIBE_POST;
  }

  const tags: OutgoingTag[] = [
    { name: "message_id", value: tagValue(msg.messageId) },
    { name: "kind", value: tagValue(msg.messageKind ?? options.kind) },
  ];
  if (msg.campaignId) tags.push({ name: "campaign_id", value: tagValue(msg.campaignId) });

  const sink = options.sinkRewrite?.sink?.trim();
  const to = sink || msg.to;
  const subject = sink ? sinkSubject(msg.subject, options.sinkRewrite?.env ?? "dev", msg.to) : msg.subject;

  return {
    from: options.from,
    to,
    replyTo: options.replyTo,
    subject,
    html: msg.html,
    text: msg.text,
    headers,
    tags,
    ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
  };
}
