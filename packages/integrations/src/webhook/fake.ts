/**
 * The webhook fake: records every call in memory (with the headers the real client would send)
 * and answers with a configurable status. Same contract as `createWebhookClient`: returns the
 * status, throws `RetryableError` for a simulated network failure.
 */
import { RetryableError } from "@beam/core/errors";
import { webhookBodyText, webhookHeaders, webhookUrl, type PostWebhookInput, type WebhookPoster } from "./client";

export type WebhookFakeCall = {
  url: string;
  host: string;
  bodyText: string;
  body: unknown;
  headers: Record<string, string>;
  idempotencyKey: string;
  at: Date;
};

export type WebhookFake = {
  postWebhook: WebhookPoster;
  readonly calls: WebhookFakeCall[];
  /** The status every later call answers with (default 200). */
  respondWith(status: number): void;
  /** The next call answers `status` (queued, before `respondWith`). */
  failNext(status?: number): void;
  /** The next call fails like a network error or a timeout. */
  networkErrorNext(): void;
  reset(): void;
};

export function createWebhookFake(options: { status?: number; now?: () => Date } = {}): WebhookFake {
  const now = options.now ?? (() => new Date());
  const calls: WebhookFakeCall[] = [];
  const queued: (number | "network")[] = [];
  let status = options.status ?? 200;
  return {
    calls,
    async postWebhook(input: PostWebhookInput) {
      const url = webhookUrl(input.url);
      const next = queued.shift();
      if (next === "network") throw new RetryableError("webhook_network: fake network error");
      const bodyText = webhookBodyText(input.body);
      calls.push({
        url: url.toString(),
        host: url.hostname,
        bodyText,
        body: JSON.parse(bodyText) as unknown,
        headers: webhookHeaders(bodyText, input.secret, input.idempotencyKey),
        idempotencyKey: input.idempotencyKey,
        at: now(),
      });
      return Promise.resolve({ status: next ?? status });
    },
    respondWith(s) {
      status = s;
    },
    failNext(s = 500) {
      queued.push(s);
    },
    networkErrorNext() {
      queued.push("network");
    },
    reset() {
      calls.length = 0;
      queued.length = 0;
      status = options.status ?? 200;
    },
  };
}
