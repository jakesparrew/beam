/** The Slack fake: records messages (`/admin/system` shows the last 50). */
import { digestRequest } from "../_shared/digest";
import { errorFromStatus } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type OnCall } from "../_shared/types";
import type { SlackClient, SlackMessage } from "./client";

export type SlackFakeMessage = SlackMessage & { at: Date };

export type SlackFake = SlackClient & {
  readonly messages: SlackFakeMessage[];
  /** The newest `n` messages, newest first. */
  last(n?: number): SlackFakeMessage[];
  failNext(status?: number): void;
  reset(): void;
};

const MAX_KEPT = 500;

export function createSlackFake(options: { onCall?: OnCall; now?: () => Date } = {}): SlackFake {
  const onCall = options.onCall ?? noopOnCall;
  const now = options.now ?? (() => new Date());
  const messages: SlackFakeMessage[] = [];
  const failures: number[] = [];
  return {
    messages,
    postMessage(message) {
      return trackCall(
        onCall,
        { provider: "slack", operation: "webhook.post", requestDigest: digestRequest({ method: "POST", path: "/services/webhook" }) },
        () => {
          const status = failures.shift();
          if (status !== undefined) throw errorFromStatus("slack", "webhook.post", status);
          messages.push({ ...message, at: now() });
          if (messages.length > MAX_KEPT) messages.splice(0, messages.length - MAX_KEPT);
          return { value: { ok: true as const }, statusCode: 200 };
        },
      );
    },
    last(n = 50) {
      return messages.slice(-n).reverse();
    },
    failNext(status = 500) {
      failures.push(status);
    },
    reset() {
      messages.length = 0;
      failures.length = 0;
    },
  };
}
