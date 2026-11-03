/**
 * Resend, Wave 0 minimum (platform section 6, on behalf of the email module): `sendEmail`
 * only. `POST /emails` with `Idempotency-Key` = the job key, so a retried job never sends twice.
 * 429 and 5xx are retryable; other 4xx are permanent. The email module extends this client in
 * Wave 1 (batch sends, webhooks, contacts) and keeps `sendEmail` unchanged.
 */
import { z } from "zod";
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError } from "../_shared/errors";
import { trackCall, withTimeout } from "../_shared/timeout";
import { noopOnCall, type FetchLike, type OnCall } from "../_shared/types";

export type EmailAttachment = { filename: string; content: Uint8Array; contentType: string; inline?: boolean };

export type SendEmailInput = {
  from: string;
  to: string | readonly string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers: Record<string, string>;
  attachments?: readonly EmailAttachment[];
  idempotencyKey: string;
};

export interface ResendClient {
  sendEmail(input: SendEmailInput): Promise<{ id: string }>;
}

export type ResendClientOptions = { apiKey: string; onCall?: OnCall; fetch?: FetchLike; baseUrl?: string; timeoutMs?: number };

const SendResponse = z.object({ id: z.string().min(1) });

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function createResendClient(options: ResendClientOptions): ResendClient {
  const onCall = options.onCall ?? noopOnCall;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = (options.baseUrl ?? "https://api.resend.com").replace(/\/$/, "");
  return {
    sendEmail(input) {
      const operation = "emails.send";
      return trackCall(onCall, { provider: "resend", operation, requestDigest: digestRequest({ method: "POST", path: "/emails" }) }, () =>
        withTimeout(
          async (signal) => {
            const body = {
              from: input.from,
              to: typeof input.to === "string" ? [input.to] : [...input.to],
              subject: input.subject,
              html: input.html,
              text: input.text,
              ...(input.replyTo ? { reply_to: input.replyTo } : {}),
              headers: input.headers,
              ...(input.attachments?.length
                ? {
                    attachments: input.attachments.map((a) => ({
                      filename: a.filename,
                      content: base64(a.content),
                      content_type: a.contentType,
                      ...(a.inline ? { content_id: a.filename } : {}),
                    })),
                  }
                : {}),
            };
            const res = await doFetch(`${base}/emails`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${options.apiKey}`,
                "content-type": "application/json",
                "idempotency-key": input.idempotencyKey,
              },
              body: JSON.stringify(body),
              signal,
            });
            if (!res.ok) throw errorFromStatus("resend", operation, res.status, await res.text().catch(() => ""));
            const parsed = SendResponse.safeParse(await res.json().catch(() => null));
            if (!parsed.success) {
              throw new IntegrationError({ provider: "resend", operation, retryable: true, statusCode: res.status, code: "invalid_response", message: "resend emails.send: response without id" });
            }
            return { value: { id: parsed.data.id }, statusCode: res.status };
          },
          options.timeoutMs ?? 15_000,
          { provider: "resend", operation },
        ),
      );
    },
  };
}
