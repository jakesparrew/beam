/**
 * The Meta messaging fake (architecture section 8): signs and verifies like the real client with
 * its own app secret, parses webhooks with the real parser, records every send and can close a
 * recipient's 24-hour window (the send then fails like Meta's code 10 answer: permanent).
 */
import { digestRequest } from "../_shared/digest";
import { errorFromStatus } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type OnCall } from "../_shared/types";
import { metaSendError, parseMetaWebhook, signMetaBody, verifyMetaSignature, type MetaMessagingClient } from "./client";
import type { MetaChannel } from "./schemas";

export const META_FAKE_APP_SECRET = "meta-fake-app-secret";

export type MetaFakeSend = { recipientPsid: string; text: string; messageId: string; at: Date };

export type MetaMessagingFake = MetaMessagingClient & {
  readonly appSecret: string;
  readonly sent: MetaFakeSend[];
  /** The `X-Hub-Signature-256` header the fake accepts for `raw`. */
  sign(raw: string): string;
  /** A webhook body with one inbound message per item (test and demo helper). */
  webhookBody(input: { channel?: MetaChannel; messages: { mid: string; senderId: string; text?: string; attachments?: number; at?: Date }[] }): Record<string, unknown>;
  /** Sends to this recipient fail as outside the 24-hour window (400, permanent). */
  closeWindow(recipientPsid: string): void;
  /** The next send fails with this status. */
  failNext(status?: number): void;
  reset(): void;
};

export function createMetaMessagingFake(options: { onCall?: OnCall; now?: () => Date; appSecret?: string } = {}): MetaMessagingFake {
  const onCall = options.onCall ?? noopOnCall;
  const now = options.now ?? (() => new Date());
  const appSecret = options.appSecret ?? META_FAKE_APP_SECRET;
  const sent: MetaFakeSend[] = [];
  const closed = new Set<string>();
  const failures: number[] = [];
  let counter = 0;
  return {
    appSecret,
    sent,
    verifySignature: (raw, header) => verifyMetaSignature(raw, header, appSecret),
    parseWebhook: parseMetaWebhook,
    sendMessage({ recipientPsid, text }) {
      return trackCall(onCall, { provider: "meta", operation: "messages.send", requestDigest: digestRequest({ method: "POST", path: "/me/messages" }) }, () => {
        const status = failures.shift();
        if (status !== undefined) throw errorFromStatus("meta", "messages.send", status);
        if (closed.has(recipientPsid)) {
          throw metaSendError(400, JSON.stringify({ error: { message: "This message is sent outside of allowed window.", code: 10, error_subcode: 2018278 } }));
        }
        counter += 1;
        const messageId = `m_fake_${counter}_${recipientPsid}`;
        sent.push({ recipientPsid, text, messageId, at: now() });
        return { value: { messageId }, statusCode: 200 };
      });
    },
    sign: (raw) => signMetaBody(raw, appSecret),
    webhookBody({ channel = "messenger", messages }) {
      return {
        object: channel === "instagram" ? "instagram" : "page",
        entry: [
          {
            id: "page-fake",
            time: now().getTime(),
            messaging: messages.map((m) => ({
              sender: { id: m.senderId },
              recipient: { id: "page-fake" },
              timestamp: (m.at ?? now()).getTime(),
              message: {
                mid: m.mid,
                ...(m.text !== undefined ? { text: m.text } : {}),
                ...(m.attachments ? { attachments: Array.from({ length: m.attachments }, () => ({ type: "image" })) } : {}),
              },
            })),
          },
        ],
      };
    },
    closeWindow(recipientPsid) {
      closed.add(recipientPsid);
    },
    failNext(status = 500) {
      failures.push(status);
    },
    reset() {
      sent.length = 0;
      closed.clear();
      failures.length = 0;
    },
  };
}
