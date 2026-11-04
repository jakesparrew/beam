/**
 * The generic HTTPS webhook client of the automation `webhook` step (automation spec section 6).
 * Called only by the `automation.call_webhook` job, never in a request.
 *
 * `POST <url>` with the JSON body, `X-Beam-Signature: sha256=<hex HMAC-SHA256 of the exact body
 * with the secret>` and `X-Beam-Idempotency-Key`; a 10 s timeout; redirects are never followed
 * (a 3xx answer is returned as its status). The client returns the status code and leaves the
 * policy to the caller (2xx done, 4xx permanent, 5xx retry). A network failure or a timeout
 * throws `RetryableError`; an invalid URL throws `PermanentError`.
 *
 * Each call is reported through `onCall` (host only, never the body or the path) so the job can
 * log it to `integration_calls` (provider `webhook`).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { PermanentError, RetryableError } from "@beam/core/errors";
import { digestRequest } from "../_shared/digest";
import type { FetchLike } from "../_shared/types";

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_SIGNATURE_HEADER = "X-Beam-Signature";
export const WEBHOOK_IDEMPOTENCY_HEADER = "X-Beam-Idempotency-Key";

export type PostWebhookInput = { url: string; body: unknown; secret: string; idempotencyKey: string };

/** One webhook call as `integration_calls` stores it (provider `webhook`, the host only). */
export type WebhookCallEntry = {
  provider: "webhook";
  operation: "webhook.post";
  requestDigest: string;
  statusCode: number | null;
  ok: boolean;
  durationMs: number;
  error: string | null;
};

export type WebhookClientOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
  onCall?: (entry: WebhookCallEntry) => void | Promise<void>;
};

export type WebhookPoster = (input: PostWebhookInput) => Promise<{ status: number }>;

/** `sha256=<hex>`: the HMAC-SHA256 of the exact body string with the secret. */
export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** Receiver side check (and tests): the signature header matches the body. */
export function verifyWebhookSignature(body: string, secret: string, header: string | null | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(signWebhookBody(body, secret));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The JSON body exactly as it is sent and signed. */
export const webhookBodyText = (body: unknown): string => JSON.stringify(body ?? null);

/** The request headers of one call. */
export function webhookHeaders(bodyText: string, secret: string, idempotencyKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": "BEAM-Automation/1",
    [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(bodyText, secret),
    [WEBHOOK_IDEMPOTENCY_HEADER]: idempotencyKey,
  };
}

/** Parses an https URL without credentials; anything else is a permanent configuration error. */
export function webhookUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PermanentError("webhook_invalid_url");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new PermanentError("webhook_invalid_url");
  return parsed;
}

const scrub = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(/https?:\/\/\S+/g, "[url]").slice(0, 1000);

/** A client with an injectable `fetch` (tests) and call log. */
export function createWebhookClient(options: WebhookClientOptions = {}): { postWebhook: WebhookPoster } {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  return {
    async postWebhook(input) {
      const url = webhookUrl(input.url);
      if (!input.secret) throw new PermanentError("webhook_not_configured");
      const bodyText = webhookBodyText(input.body);
      const requestDigest = digestRequest({ method: "POST", path: "/", params: { host: url.hostname } });
      const started = Date.now();
      const report = async (statusCode: number | null, error: string | null) => {
        await options.onCall?.({
          provider: "webhook",
          operation: "webhook.post",
          requestDigest,
          statusCode,
          ok: statusCode !== null && statusCode >= 200 && statusCode < 300,
          durationMs: Date.now() - started,
          error,
        });
      };
      let res: Response;
      try {
        res = await doFetch(url.toString(), {
          method: "POST",
          headers: webhookHeaders(bodyText, input.secret, input.idempotencyKey),
          body: bodyText,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const message = scrub(error);
        await report(null, message);
        throw new RetryableError(`webhook_network: ${message}`);
      }
      await res.body?.cancel().catch(() => undefined);
      await report(res.status, res.status >= 200 && res.status < 300 ? null : `status ${res.status}`);
      return { status: res.status };
    },
  };
}

/** The production poster (global `fetch`). */
export const postWebhook: WebhookPoster = (input) => createWebhookClient().postWebhook(input);
