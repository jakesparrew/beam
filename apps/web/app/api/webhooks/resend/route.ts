/**
 * The Resend webhook (email spec rule 45, section 4 "Route handlers"): one line over platform's
 * `handleWebhook()`. A valid Svix signature (HMAC-SHA256 over `<svix-id>.<svix-timestamp>.<body>`
 * with `RESEND_WEBHOOK_SECRET`, timestamp within 5 minutes) stores `webhook_events` once per
 * `svix-id` and enqueues `webhook.process`, which calls email's `processResendEvent()`; anything
 * else answers 401 and stores nothing.
 */
import { resendWebhookVerifier } from "@beam/integrations/resend";
import { handleWebhook } from "@/lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleWebhook(req, { provider: "resend", verify: resendWebhookVerifier(process.env.RESEND_WEBHOOK_SECRET ?? "") });
}
