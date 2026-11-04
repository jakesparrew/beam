/**
 * The webhook step payload (automation spec section 6). Only `WEBHOOK_ALLOWED_FIELDS` of the
 * person leave BEAM: no email, no phone, no sensitive column. Signing (HMAC SHA-256) and the
 * HTTP call live in `packages/integrations/src/webhook/`.
 */

export const WEBHOOK_ALLOWED_FIELDS = ["id", "first_name", "locale", "status", "tags"] as const;
export type WebhookPersonField = (typeof WEBHOOK_ALLOWED_FIELDS)[number];

export type WebhookPerson = { id: string; first_name: string | null; locale: string; status: string; tags: string[] };

export type WebhookPayload = {
  event: "automation.step";
  automation: string;
  step_key: string;
  enrolment_id: string;
  person: WebhookPerson;
  occurred_at: string;
};

/** Keeps only the allowed person fields, whatever the caller passes in. */
export function pickWebhookPerson(person: Record<string, unknown>): WebhookPerson {
  const tags = person.tags;
  return {
    id: String(person.id),
    first_name: typeof person.first_name === "string" ? person.first_name : null,
    locale: String(person.locale),
    status: String(person.status),
    tags: Array.isArray(tags) ? tags.map(String) : [],
  };
}

export function buildWebhookPayload(input: {
  automationSlug: string;
  stepKey: string;
  enrolmentId: string;
  person: Record<string, unknown>;
  occurredAt: Date;
}): WebhookPayload {
  return {
    event: "automation.step",
    automation: input.automationSlug,
    step_key: input.stepKey,
    enrolment_id: input.enrolmentId,
    person: pickWebhookPerson(input.person),
    occurred_at: input.occurredAt.toISOString(),
  };
}

/** `X-Beam-Idempotency-Key` and the `automation.call_webhook` job key. */
export const webhookIdempotencyKey = (enrolmentId: string, stepKey: string) => `automation_webhook:${enrolmentId}:${stepKey}`;

/** A-1: the URL is https (no credentials) and its host is on the allow-list (compared lower-case). */
export function checkWebhookUrl(url: string, hosts: readonly string[]): { https: boolean; allowed: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { https: false, allowed: false };
  }
  const https = parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  const host = parsed.hostname.toLowerCase();
  return { https, allowed: https && hosts.some((h) => h.toLowerCase() === host) };
}
