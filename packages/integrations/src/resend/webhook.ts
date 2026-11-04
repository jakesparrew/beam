/**
 * Resend webhook signatures (Svix scheme; email spec rule 45). The signed content is
 * `<svix-id>.<svix-timestamp>.<body>`, HMAC-SHA256 with the secret's key (base64 after the
 * `whsec_` prefix), base64. `svix-signature` holds one or more space-separated `v1,<sig>` entries
 * (key rotation); any match passes. The timestamp (seconds) must be within 5 minutes of now.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function secretKey(secret: string): Buffer {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(raw, "base64");
}

/** The base64 signature (without the `v1,` prefix) of one webhook delivery. */
export function computeResendSignature(input: { id: string; timestamp: string; body: string; secret: string }): string {
  return createHmac("sha256", secretKey(input.secret)).update(`${input.id}.${input.timestamp}.${input.body}`).digest("base64");
}

/** The `svix-signature` header value for a delivery (`v1,<sig>`), used by the fake and tests. */
export function signResendWebhook(input: { id: string; timestamp: string; body: string; secret: string }): string {
  return `v1,${computeResendSignature(input)}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** True for a valid signature from `secret` whose timestamp is within 5 minutes of `now`. */
export function verifyResendWebhook(input: { id: string; timestamp: string; signature: string; body: string; secret: string; now: Date }): boolean {
  if (!input.id || !input.secret || !/^\d{1,12}$/.test(input.timestamp)) return false;
  const ageSeconds = Math.abs(input.now.getTime() / 1000 - Number(input.timestamp));
  if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = computeResendSignature(input);
  return input.signature
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => {
      const [version, sig] = part.split(",", 2);
      return version === "v1" && sig !== undefined && safeEqual(sig, expected);
    });
}

export type ResendVerifyResult = { ok: true; externalEventId: string; payload: unknown } | { ok: false };

/**
 * The adapter for platform's `handleWebhook({ verify })`: reads `svix-id`, `svix-timestamp` and
 * `svix-signature`, verifies, and returns the parsed payload with `svix-id` as the event id.
 */
export function resendWebhookVerifier(secret: string, options: { now?: () => Date } = {}): (raw: string, headers: Headers) => Promise<ResendVerifyResult> {
  const now = options.now ?? (() => new Date());
  return (raw, headers) => {
    const id = headers.get("svix-id") ?? "";
    const timestamp = headers.get("svix-timestamp") ?? "";
    const signature = headers.get("svix-signature") ?? "";
    if (!verifyResendWebhook({ id, timestamp, signature, body: raw, secret, now: now() })) return Promise.resolve({ ok: false });
    try {
      return Promise.resolve({ ok: true, externalEventId: id, payload: JSON.parse(raw) as unknown });
    } catch {
      return Promise.resolve({ ok: false });
    }
  };
}
