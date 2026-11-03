/**
 * Slack incoming webhook (`SLACK_WEBHOOK_URL`, channel `#beam-alerts`). Called only by the
 * `notify.slack` job; `notifySlack()` owns the key `slack:<fingerprint>:<hour>` (PL-29, PL-75).
 * 429 and 5xx are retryable (the job retries up to 4 attempts, then Sentry only).
 */
import { digestRequest } from "../_shared/digest";
import { errorFromStatus } from "../_shared/errors";
import { trackCall, withTimeout } from "../_shared/timeout";
import { noopOnCall, type FetchLike, type OnCall } from "../_shared/types";

export type SlackMessage = { text: string; blocks?: readonly Record<string, unknown>[] };

export interface SlackClient {
  postMessage(message: SlackMessage): Promise<{ ok: true }>;
}

export type SlackClientOptions = { webhookUrl: string; onCall?: OnCall; fetch?: FetchLike; timeoutMs?: number };

export function createSlackClient(options: SlackClientOptions): SlackClient {
  const onCall = options.onCall ?? noopOnCall;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const operation = "webhook.post";
  // The webhook URL is a secret: only its path shape enters the digest.
  const requestDigest = digestRequest({ method: "POST", path: "/services/webhook" });
  return {
    postMessage(message) {
      return trackCall(onCall, { provider: "slack", operation, requestDigest }, () =>
        withTimeout(
          async (signal) => {
            const res = await doFetch(options.webhookUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text: message.text, ...(message.blocks ? { blocks: message.blocks } : {}) }),
              signal,
            });
            if (!res.ok) throw errorFromStatus("slack", operation, res.status, await res.text().catch(() => ""));
            return { value: { ok: true as const }, statusCode: res.status };
          },
          options.timeoutMs ?? 10_000,
          { provider: "slack", operation },
        ),
      );
    },
  };
}
