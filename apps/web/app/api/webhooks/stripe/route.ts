/**
 * `POST /api/webhooks/stripe`: a one-liner over platform's `handleWebhook`. The `Stripe-Signature`
 * header must match `STRIPE_WEBHOOK_SECRET` (HMAC-SHA256, 5 minutes tolerance); anything else
 * answers 401 and stores nothing. The body is not trusted beyond the ids it names: the inbox
 * stores `{ objectId, paymentIntentId, beamPaymentId }` once per Stripe event id, and commerce's
 * `stripe` handler fetches the payment from Stripe and applies it (`syncPayment`).
 *
 * In the Stripe dashboard, point a webhook endpoint at this URL with at least the events
 * `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
 * `checkout.session.async_payment_failed`, `checkout.session.expired`,
 * `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded` and
 * `charge.dispute.created`.
 */
import { stripeEventRef, verifyStripeSignature } from "@beam/integrations/payments";
import { handleWebhook } from "@/lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleWebhook(req, {
    provider: "stripe",
    verify: (raw, headers) => {
      if (!verifyStripeSignature(process.env.STRIPE_WEBHOOK_SECRET, headers.get("stripe-signature"), raw)) return Promise.resolve({ ok: false as const });
      const ref = stripeEventRef(raw);
      if (!ref) return Promise.resolve({ ok: false as const });
      return Promise.resolve({
        ok: true as const,
        externalEventId: ref.eventId,
        payload: { type: ref.type, objectId: ref.objectId, paymentIntentId: ref.paymentIntentId, beamPaymentId: ref.beamPaymentId },
      });
    },
  });
}
