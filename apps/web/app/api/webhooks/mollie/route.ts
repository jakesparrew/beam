/**
 * `POST /api/webhooks/mollie` (commerce spec section 4.4): a one-liner over platform's
 * `handleWebhook`. Mollie posts only `id=<payment id>`; the body is never trusted (rule 30), so
 * `verify` checks only that the call is ours: query `t` equal to `MOLLIE_WEBHOOK_SECRET`
 * (constant time) or a valid `X-Mollie-Signature`, else the provider's `verifyWebhook`. The
 * event id is `<id>:<received ms>`, so every delivery gets its own inbox row and job, and
 * `syncPayment` makes repeats a no-op in effect. A failure answers 401.
 */
import { timingSafeEqual } from "node:crypto";
import { getIntegrations } from "@/lib/integrations";
import { handleWebhook } from "@/lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  return handleWebhook(req, {
    provider: "mollie",
    verify: (raw, headers) => {
      const id = new URLSearchParams(raw).get("id")?.trim();
      if (!id) return Promise.resolve({ ok: false as const });
      const secret = process.env.MOLLIE_WEBHOOK_SECRET;
      const token = url.searchParams.get("t");
      const ok = secret && token ? safeEqual(token, secret) : getIntegrations().payments.verifyWebhook({ headers, rawBody: raw, url });
      return Promise.resolve(ok ? { ok: true as const, externalEventId: `${id}:${Date.now()}`, payload: { id } } : { ok: false as const });
    },
  });
}
