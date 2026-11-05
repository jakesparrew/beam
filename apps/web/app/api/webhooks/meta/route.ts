/**
 * The Meta webhook (crm spec 4.4, R3): Messenger and Instagram messages for the unified inbox.
 *
 * - GET: the subscription check. `hub.mode=subscribe` with `hub.verify_token` equal to
 *   `META_VERIFY_TOKEN` answers `hub.challenge` as plain text; anything else 403.
 * - POST: one line over platform's `handleWebhook()`. `verifyMetaDelivery` checks
 *   `X-Hub-Signature-256` with `META_APP_SECRET` and returns the first message `mid` as the
 *   event id; platform stores `webhook_events (meta, mid)` once and enqueues `webhook.process`,
 *   whose `meta` handler ingests the messages. A bad signature answers 401 and stores nothing.
 */
import { timingSafeEqual } from "node:crypto";
import { handleWebhook } from "@/lib/webhooks";
import { verifyMetaDelivery } from "@/modules/crm/inbox/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function GET(req: Request): Response {
  const params = new URL(req.url).searchParams;
  const expected = process.env.META_VERIFY_TOKEN ?? "";
  const token = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge") ?? "";
  if (params.get("hub.mode") === "subscribe" && expected && safeEqual(token, expected) && challenge) {
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response("forbidden", { status: 403 });
}

export function POST(req: Request): Promise<Response> {
  return handleWebhook(req, { provider: "meta", verify: verifyMetaDelivery });
}
