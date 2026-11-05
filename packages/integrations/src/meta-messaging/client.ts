/**
 * Meta Messenger and Instagram messaging client (crm spec section 6, R3, behind
 * `ff_crm_inbox_meta`). Called only by crm's `crm.send_meta_reply` job and the Meta webhook
 * route, never by another request path.
 *
 * - `verifySignature(raw, header)`: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw
 *   body with META_APP_SECRET>`, compared in constant time.
 * - `parseWebhook(body)`: the inbound customer messages of one delivery (echoes of our own
 *   sends, read receipts and delivery reports are skipped).
 * - `sendMessage({ recipientPsid, text })`: `POST /me/messages` with `messaging_type: RESPONSE`.
 *   A 4xx (window closed, missing permission) is a permanent `IntegrationError`; 408, 429 and
 *   5xx are retryable. The access token is never part of the request digest.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { digestRequest } from "../_shared/digest";
import { IntegrationError, isRetryableStatus, scrubError } from "../_shared/errors";
import { trackCall, withTimeout } from "../_shared/timeout";
import { noopOnCall, type FetchLike, type OnCall } from "../_shared/types";
import { MetaErrorBody, MetaSendResponse, MetaWebhookBody, type MetaInbound } from "./schemas";

export type { MetaInbound };

export const META_SIGNATURE_HEADER = "x-hub-signature-256";
export const META_GRAPH_URL = "https://graph.facebook.com/v21.0";
/** Meta answers a send outside the 24-hour window with code 10 and this subcode. */
export const META_WINDOW_CLOSED_SUBCODE = 2018278;

export interface MetaMessagingClient {
  verifySignature(raw: string, header: string): boolean;
  parseWebhook(body: unknown): MetaInbound[];
  sendMessage(input: { recipientPsid: string; text: string }): Promise<{ messageId: string }>;
}

export type MetaMessagingClientOptions = {
  appSecret: string;
  pageAccessToken: string;
  graphUrl?: string;
  onCall?: OnCall;
  fetch?: FetchLike;
  timeoutMs?: number;
};

/** `sha256=<hex>` of the raw body with the app secret. */
export function signMetaBody(raw: string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(raw, "utf8").digest("hex")}`;
}

/** Constant-time check of an `X-Hub-Signature-256` header; an empty secret never verifies. */
export function verifyMetaSignature(raw: string, header: string | null | undefined, appSecret: string): boolean {
  if (!appSecret || !header) return false;
  const expected = Buffer.from(signMetaBody(raw, appSecret));
  const given = Buffer.from(header.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The inbound customer messages of one webhook body (invalid bodies yield none). */
export function parseMetaWebhook(body: unknown): MetaInbound[] {
  const parsed = MetaWebhookBody.safeParse(body);
  if (!parsed.success) return [];
  const channel = parsed.data.object === "instagram" ? "instagram" : parsed.data.object === "page" ? "messenger" : null;
  if (!channel) return [];
  const out: MetaInbound[] = [];
  for (const entry of parsed.data.entry) {
    for (const m of entry.messaging ?? []) {
      if (!m.message || m.message.is_echo) continue;
      out.push({
        channel,
        mid: m.message.mid,
        senderId: m.sender.id,
        recipientId: m.recipient.id,
        text: (m.message.text ?? "").slice(0, 50_000),
        attachmentCount: Math.min(m.message.attachments?.length ?? 0, 32_767),
        sentAt: new Date(m.timestamp ?? entry.time ?? Date.now()),
      });
    }
  }
  return out;
}

/** The error a failed send maps to: a closed window or a refused permission is permanent. */
export function metaSendError(status: number, bodyText: string): IntegrationError {
  let code: string | undefined;
  let detail = bodyText;
  try {
    const parsed = MetaErrorBody.safeParse(JSON.parse(bodyText));
    if (parsed.success) {
      detail = parsed.data.error.message ?? bodyText;
      if (parsed.data.error.error_subcode === META_WINDOW_CLOSED_SUBCODE || parsed.data.error.code === 10) code = "window_closed";
      else if (parsed.data.error.code === 200 || status === 403) code = "permission";
    }
  } catch {
    // not JSON: keep the text
  }
  return new IntegrationError({
    provider: "meta",
    operation: "messages.send",
    statusCode: status,
    retryable: isRetryableStatus(status),
    ...(code ? { code } : {}),
    message: `meta messages.send failed with ${status}${detail ? `: ${scrubError(detail)}` : ""}`,
  });
}

export function createMetaMessagingClient(options: MetaMessagingClientOptions): MetaMessagingClient {
  const onCall = options.onCall ?? noopOnCall;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = options.graphUrl ?? META_GRAPH_URL;
  const operation = "messages.send";
  const requestDigest = digestRequest({ method: "POST", path: "/me/messages" });
  return {
    verifySignature: (raw, header) => verifyMetaSignature(raw, header, options.appSecret),
    parseWebhook: parseMetaWebhook,
    sendMessage({ recipientPsid, text }) {
      return trackCall(onCall, { provider: "meta", operation, requestDigest }, () =>
        withTimeout(
          async (signal) => {
            const url = `${base}/me/messages?access_token=${encodeURIComponent(options.pageAccessToken)}`;
            const res = await doFetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ recipient: { id: recipientPsid }, messaging_type: "RESPONSE", message: { text } }),
              signal,
            });
            const bodyText = await res.text().catch(() => "");
            if (!res.ok) throw metaSendError(res.status, bodyText);
            const parsed = MetaSendResponse.safeParse(JSON.parse(bodyText || "{}"));
            if (!parsed.success) throw new IntegrationError({ provider: "meta", operation, statusCode: res.status, retryable: true, message: "meta messages.send: unexpected response" });
            return { value: { messageId: parsed.data.message_id }, statusCode: res.status };
          },
          options.timeoutMs ?? 10_000,
          { provider: "meta", operation },
        ),
      );
    },
  };
}
