/**
 * The Stripe adapter (commerce spec section 6): the Stripe API over `fetch` (form-encoded
 * requests, JSON responses), so tests inject a `fetch` that returns recorded Stripe JSON.
 *
 * How BEAM's provider model maps onto Stripe:
 * - One-off and first payments are Stripe Checkout Sessions (`cs_...`): the customer pays on
 *   Stripe's hosted page with Bancontact or card. A first payment sets
 *   `setup_future_usage=off_session`, so a card is saved and a Bancontact payment yields a
 *   reusable SEPA Direct Debit payment method (`generated_sepa_debit`).
 * - A "mandate" is the reusable payment method (`pm_...`) attached to the customer. Recurring
 *   debits are off-session PaymentIntents (`pi_...`) on that payment method.
 * - `getPayment` reads a session (with its PaymentIntent) or a PaymentIntent, plus its refunds
 *   and disputes; `details` carries only non-sensitive fields (`paymentIntentId`,
 *   `beamPaymentId`, card brand and country, failure code).
 * - Webhooks are verified with the `Stripe-Signature` header (HMAC-SHA256 over
 *   `<timestamp>.<body>` with `STRIPE_WEBHOOK_SECRET`, 5 minutes tolerance).
 * - Terminal payments are not offered through Stripe in V1 (`not_supported`).
 *
 * Payment methods are managed in the Stripe dashboard (from API version 2026-11-18 requests no
 * longer list them): enable Bancontact, card and SEPA Direct Debit there and switch off the rest.
 * Requests pin `Stripe-Version` to `STRIPE_API_VERSION`, the version this adapter is tested on.
 *
 * Every create call sends `Idempotency-Key` (the job key). Responses are validated with Zod; a
 * malformed body is a permanent `IntegrationError` (`invalid_response`). 5xx, 429 and timeouts
 * (10 s) are retryable; other 4xx are permanent. Each call is reported through `onCall` with
 * operation, request digest (method and path only), status and duration; never bodies.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Locale } from "@beam/core/i18n";
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError } from "../_shared/errors";
import { trackCall, withTimeout } from "../_shared/timeout";
import { noopOnCall, type FetchLike, type OnCall } from "../_shared/types";
import type { PaymentProvider, PaymentStatus, ProviderPayment, ProviderRefund } from "./provider";

/** The environment variables a configured Stripe adapter needs. */
export const STRIPE_ENV_KEYS = ["STRIPE_API_KEY"] as const;

export function isStripeConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  return STRIPE_ENV_KEYS.every((k) => !!env[k]);
}

export type StripeProviderOptions = {
  /** `STRIPE_API_KEY`: `sk_test_...` or `sk_live_...` (or a restricted `rk_...` key). */
  apiKey: string;
  /** The public base URL of the app; relative redirect URLs resolve against it. */
  appBaseUrl: string;
  /** `STRIPE_WEBHOOK_SECRET` (`whsec_...`): without it `verifyWebhook` refuses every delivery. */
  webhookSecret?: string;
  onCall?: OnCall;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  /** Clock for webhook timestamps (tests). */
  now?: () => Date;
};

const STRIPE_LOCALES: Record<Locale, string> = { "nl-BE": "nl", "fr-BE": "fr", en: "en" };
const CUSTOMER_LOCALES: Record<Locale, string> = { "nl-BE": "nl-BE", "fr-BE": "fr-BE", en: "en" };
/** The Stripe API version this adapter is written and tested against. */
export const STRIPE_API_VERSION = "2026-11-18.endive";

/** BEAM method names (shared with Mollie) for Stripe payment method types. */
const METHOD_NAMES: Record<string, string> = { card: "creditcard", bancontact: "bancontact", sepa_debit: "directdebit", ideal: "ideal" };

/**
 * Nested params in Stripe's form encoding: `{ a: { b: [1, 2] } }` -> `a[b][0]=1&a[b][1]=2`.
 * `undefined` and `null` values are left out.
 */
export function stripeForm(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) walk(`${prefix}[${k}]`, v);
    else out.append(prefix, String(value as string | number | boolean));
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.toString();
}

// ---------------------------------------------------------------------------
// Response schemas (only the fields BEAM reads; `passthrough` keeps the rest out of the way)
// ---------------------------------------------------------------------------

const Metadata = z.record(z.string(), z.string()).nullable().optional();

const ChargeBody = z
  .object({
    id: z.string().regex(/^(ch|py)_/),
    amount: z.number().int(),
    amount_refunded: z.number().int().optional().default(0),
    created: z.number().int(),
    disputed: z.boolean().optional().default(false),
    payment_method_details: z
      .object({
        type: z.string(),
        card: z.object({ brand: z.string().nullable().optional(), country: z.string().nullable().optional() }).passthrough().nullable().optional(),
        bancontact: z.object({ generated_sepa_debit: z.string().nullable().optional() }).passthrough().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const PI_STATUSES = ["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "succeeded"] as const;

const PaymentIntentBody = z
  .object({
    id: z.string().regex(/^pi_/),
    object: z.literal("payment_intent").optional(),
    amount: z.number().int(),
    status: z.enum(PI_STATUSES),
    customer: z.union([z.string(), z.object({ id: z.string() }).passthrough()]).nullable().optional(),
    payment_method: z.union([z.string(), z.object({ id: z.string() }).passthrough()]).nullable().optional(),
    setup_future_usage: z.string().nullable().optional(),
    latest_charge: z.union([z.string(), ChargeBody]).nullable().optional(),
    last_payment_error: z.object({ code: z.string().nullable().optional(), decline_code: z.string().nullable().optional() }).passthrough().nullable().optional(),
    metadata: Metadata,
  })
  .passthrough();
type PaymentIntentBody = z.infer<typeof PaymentIntentBody>;

const SessionBody = z
  .object({
    id: z.string().regex(/^cs_/),
    object: z.literal("checkout.session").optional(),
    url: z.string().url().nullable().optional(),
    status: z.enum(["open", "complete", "expired"]).nullable(),
    payment_status: z.enum(["paid", "unpaid", "no_payment_required"]),
    amount_total: z.number().int().nullable(),
    customer: z.union([z.string(), z.object({ id: z.string() }).passthrough()]).nullable().optional(),
    payment_intent: z.union([z.string(), PaymentIntentBody]).nullable().optional(),
    metadata: Metadata,
  })
  .passthrough();
type SessionBody = z.infer<typeof SessionBody>;

const REFUND_STATUSES = ["pending", "requires_action", "succeeded", "failed", "canceled"] as const;
const RefundBody = z.object({ id: z.string().regex(/^(re|pyr)_/), amount: z.number().int(), status: z.enum(REFUND_STATUSES).nullable() }).passthrough();
const RefundList = z.object({ data: z.array(RefundBody) }).passthrough();
const DisputeList = z.object({ data: z.array(z.object({ id: z.string(), amount: z.number().int(), status: z.string() }).passthrough()) }).passthrough();
const CustomerBody = z.object({ id: z.string().regex(/^cus_/), email: z.string().nullable().optional(), deleted: z.boolean().optional() }).passthrough();
const SetupIntentBody = z
  .object({ id: z.string().regex(/^seti_/), status: z.string(), payment_method: z.union([z.string(), z.object({ id: z.string() }).passthrough()]).nullable().optional() })
  .passthrough();
const PaymentMethodBody = z
  .object({
    id: z.string().regex(/^pm_/),
    type: z.string(),
    customer: z.union([z.string(), z.object({ id: z.string() }).passthrough()]).nullable().optional(),
    card: z.object({ brand: z.string().nullable().optional(), last4: z.string().nullable().optional() }).passthrough().nullable().optional(),
    sepa_debit: z.object({ country: z.string().nullable().optional(), last4: z.string().nullable().optional() }).passthrough().nullable().optional(),
  })
  .passthrough();
type PaymentMethodBody = z.infer<typeof PaymentMethodBody>;
const ErrorBody = z
  .object({ error: z.object({ message: z.string().optional(), code: z.string().optional(), type: z.string().optional(), payment_intent: PaymentIntentBody.optional() }).passthrough() })
  .passthrough();

const REFUND_STATUS: Record<(typeof REFUND_STATUSES)[number], ProviderRefund["status"]> = {
  pending: "pending",
  requires_action: "pending",
  succeeded: "refunded",
  failed: "failed",
  canceled: "failed",
};

type StripeError = z.output<typeof ErrorBody>["error"];
/** The outcome of one call: the parsed body, or an accepted error status with Stripe's error. */
type CallResult<T> = { ok: true; value: T } | { ok: false; status: number; error: StripeError | null };

const idOf = (v: string | { id: string } | null | undefined): string | null => (v == null ? null : typeof v === "string" ? v : v.id);

/** A PaymentIntent's status in BEAM's `payments_status` (refunds are applied afterwards). */
export function mapPaymentIntentStatus(pi: Pick<PaymentIntentBody, "status" | "last_payment_error">): PaymentStatus {
  switch (pi.status) {
    case "succeeded":
      return "paid";
    case "processing":
      return "pending";
    case "requires_capture":
      return "authorized";
    case "canceled":
      return "cancelled";
    case "requires_payment_method":
      // Back to "pick a method" after a decline: the attempt failed.
      return pi.last_payment_error ? "failed" : "open";
    default:
      return "open";
  }
}

/** `paid` with refunds becomes `refunded` (all) or `partially_refunded`. */
function withRefunds(status: PaymentStatus, amountCents: number, refundedCents: number): PaymentStatus {
  if (status === "paid" && refundedCents > 0) return refundedCents >= amountCents ? "refunded" : "partially_refunded";
  return status;
}

/** A masked summary such as `BE** **** **** 3000` or `visa **** 4242`; never the full account. */
export function stripeMandateSummary(pm: Pick<PaymentMethodBody, "type" | "card" | "sepa_debit">): string | null {
  if (pm.type === "sepa_debit" && pm.sepa_debit?.last4) return `${pm.sepa_debit.country ?? "EU"}** **** **** ${pm.sepa_debit.last4}`;
  if (pm.type === "card" && pm.card?.last4) return `${pm.card.brand ?? "card"} **** ${pm.card.last4}`;
  return null;
}

/**
 * Checks a `Stripe-Signature` header (`t=<unix>,v1=<hex>[,v1=...]`): HMAC-SHA256 over
 * `<t>.<rawBody>` with the endpoint secret, constant-time, within `toleranceS` of `now`.
 */
export function verifyStripeSignature(secret: string | undefined, header: string | null, rawBody: string, now: Date = new Date(), toleranceS = 300): boolean {
  if (!secret || !header) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!t || !/^\d+$/.test(t) || !signatures.length) return false;
  if (Math.abs(now.getTime() / 1000 - Number(t)) > toleranceS) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return signatures.some((s) => safeEqual(s, expected));
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The ids a Stripe event points at, for the webhook inbox (no secrets, no card data). */
export type StripeEventRef = { eventId: string; type: string; objectId: string | null; paymentIntentId: string | null; beamPaymentId: string | null };

/** Reads the event id, type and the payment it concerns from a verified Stripe event body. */
export function stripeEventRef(rawBody: string): StripeEventRef | null {
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const e = event as { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } };
  if (typeof e.id !== "string" || typeof e.type !== "string") return null;
  const o = e.data?.object ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const objectId = str(o.id);
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  const paymentIntentId = objectId?.startsWith("pi_") ? objectId : str(o.payment_intent);
  return { eventId: e.id, type: e.type, objectId, paymentIntentId, beamPaymentId: str(meta.paymentId) };
}

export function createStripeProvider(options: StripeProviderOptions): PaymentProvider {
  const onCall = options.onCall ?? noopOnCall;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = (options.baseUrl ?? "https://api.stripe.com/v1").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const appBase = options.appBaseUrl.replace(/\/$/, "");
  const now = options.now ?? (() => new Date());
  const absolute = (url: string) => new URL(url, `${appBase}/`).toString();
  const enc = encodeURIComponent;

  /**
   * One tracked HTTP call. `accept` lets listed statuses through: the parsed error body is
   * returned as `{ error }` (a declined off-session charge answers 402 with its PaymentIntent).
   */
  function call<S extends z.ZodTypeAny>(
    operation: string,
    req: { method: "GET" | "POST" | "DELETE"; path: string; digestPath: string; query?: string; form?: Record<string, unknown>; idempotencyKey?: string | undefined },
    schema: S,
    accept: readonly number[] = [],
  ): Promise<CallResult<z.output<S>>> {
    return trackCall(onCall, { provider: "stripe", operation, requestDigest: digestRequest({ method: req.method, path: req.digestPath }) }, () =>
      withTimeout(
        async (signal): Promise<{ value: CallResult<z.output<S>>; statusCode: number }> => {
          const body = req.form ? stripeForm(req.form) : undefined;
          const res = await doFetch(`${base}${req.path}${req.query ? `?${req.query}` : ""}`, {
            method: req.method,
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              "stripe-version": STRIPE_API_VERSION,
              ...(body !== undefined ? { "content-type": "application/x-www-form-urlencoded" } : {}),
              ...(req.idempotencyKey ? { "idempotency-key": req.idempotencyKey } : {}),
            },
            ...(body !== undefined ? { body } : {}),
            signal,
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            let parsedError: StripeError | null = null;
            try {
              const p = ErrorBody.safeParse(JSON.parse(text));
              if (p.success) parsedError = p.data.error;
            } catch {
              // not JSON
            }
            if (accept.includes(res.status)) return { value: { ok: false, status: res.status, error: parsedError }, statusCode: res.status };
            throw errorFromStatus("stripe", operation, res.status, parsedError?.message ?? text);
          }
          const json: unknown = await res.json().catch(() => undefined);
          const parsed = schema.safeParse(json);
          if (!parsed.success) {
            throw new IntegrationError({
              provider: "stripe",
              operation,
              statusCode: res.status,
              retryable: false,
              code: "invalid_response",
              message: `stripe ${operation}: unexpected response (${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")})`,
            });
          }
          return { value: { ok: true, value: parsed.data as z.output<S> }, statusCode: res.status };
        },
        timeoutMs,
        { provider: "stripe", operation },
      ),
    );
  }

  async function must<T>(p: Promise<CallResult<T>>, operation: string): Promise<T> {
    const r = await p;
    if (r.ok) return r.value;
    throw new IntegrationError({ provider: "stripe", operation, statusCode: r.status, retryable: false, code: "rejected", message: `stripe ${operation}: rejected (${r.status})` });
  }

  async function chargeOf(pi: PaymentIntentBody): Promise<z.output<typeof ChargeBody> | null> {
    if (!pi.latest_charge) return null;
    if (typeof pi.latest_charge !== "string") return pi.latest_charge;
    const r = await must(call("charges.get", { method: "GET", path: `/charges/${enc(pi.latest_charge)}`, digestPath: "/charges/{id}" }, ChargeBody), "charges.get");
    return r;
  }

  async function paymentIntentOf(session: SessionBody): Promise<PaymentIntentBody | null> {
    const pi = session.payment_intent;
    if (!pi) return null;
    if (typeof pi !== "string") return pi;
    return must(
      call("payment_intents.get", { method: "GET", path: `/payment_intents/${enc(pi)}`, digestPath: "/payment_intents/{id}", query: "expand[]=latest_charge" }, PaymentIntentBody),
      "payment_intents.get",
    );
  }

  async function resolvePaymentIntentId(providerPaymentId: string, operation: string): Promise<string> {
    if (providerPaymentId.startsWith("pi_")) return providerPaymentId;
    const s = await must(call("checkout.sessions.get", { method: "GET", path: `/checkout/sessions/${enc(providerPaymentId)}`, digestPath: "/checkout/sessions/{id}" }, SessionBody), "checkout.sessions.get");
    const pi = idOf(s.payment_intent as string | { id: string } | null | undefined);
    if (!pi) throw new IntegrationError({ provider: "stripe", operation, retryable: false, code: "not_paid", message: `stripe ${operation}: the session has no payment` });
    return pi;
  }

  /** The BEAM view of a PaymentIntent (with its charge, refunds and disputes). */
  async function fromPaymentIntent(providerPaymentId: string, pi: PaymentIntentBody, sessionId: string | null): Promise<ProviderPayment> {
    const charge = await chargeOf(pi);
    let refunds: ProviderRefund[] = [];
    if (charge && charge.amount_refunded > 0) {
      const list = await must(call("refunds.list", { method: "GET", path: "/refunds", digestPath: "/refunds", query: `payment_intent=${enc(pi.id)}&limit=100` }, RefundList), "refunds.list");
      refunds = list.data.map((r) => ({ providerRefundId: r.id, amountCents: r.amount, status: r.status ? REFUND_STATUS[r.status] : "pending" }));
    }
    let chargebackCents = 0;
    if (charge?.disputed) {
      const list = await must(call("disputes.list", { method: "GET", path: "/disputes", digestPath: "/disputes", query: `payment_intent=${enc(pi.id)}&limit=100` }, DisputeList), "disputes.list");
      chargebackCents = list.data.filter((d) => !["won", "warning_closed", "prevented"].includes(d.status)).reduce((s, d) => s + d.amount, 0);
    }
    const type = charge?.payment_method_details?.type ?? null;
    const status = withRefunds(mapPaymentIntentStatus(pi), pi.amount, charge?.amount_refunded ?? 0);
    const reusable = pi.setup_future_usage && pi.status === "succeeded" ? (charge?.payment_method_details?.bancontact?.generated_sepa_debit ?? idOf(pi.payment_method)) : null;
    const details: Record<string, unknown> = { paymentIntentId: pi.id };
    if (sessionId) details.checkoutSessionId = sessionId;
    if (pi.metadata?.paymentId) details.beamPaymentId = pi.metadata.paymentId;
    if (charge?.payment_method_details?.card?.brand) details.cardLabel = charge.payment_method_details.card.brand;
    if (charge?.payment_method_details?.card?.country) details.cardCountryCode = charge.payment_method_details.card.country;
    if (pi.last_payment_error?.code) details.failureReason = pi.last_payment_error.decline_code ?? pi.last_payment_error.code;
    return {
      providerPaymentId,
      status,
      method: type ? (METHOD_NAMES[type] ?? type) : null,
      amountCents: pi.amount,
      paidAt: pi.status === "succeeded" && charge ? new Date(charge.created * 1000) : null,
      mandateId: reusable ?? null,
      customerId: idOf(pi.customer),
      refunds,
      chargebackCents,
      details,
    };
  }

  /** A Checkout Session for one payment (also used for payment links). */
  async function createSession(
    operation: string,
    i: { amountCents: number; description: string; redirectUrl: string; locale?: Locale; customerId?: string; first?: boolean; metadata?: Record<string, string>; expiresAt?: Date; idempotencyKey?: string },
  ) {
    const nowMs = now().getTime();
    // Stripe accepts an expiry between 30 minutes and 24 hours from now.
    const expires = i.expiresAt ? Math.round(Math.min(Math.max(i.expiresAt.getTime(), nowMs + 31 * 60_000), nowMs + 23.9 * 3_600_000) / 1000) : undefined;
    return must(
      call(
        operation,
        {
          method: "POST",
          path: "/checkout/sessions",
          digestPath: "/checkout/sessions",
          idempotencyKey: i.idempotencyKey,
          form: {
            mode: "payment",
            line_items: [{ quantity: 1, price_data: { currency: "eur", unit_amount: i.amountCents, product_data: { name: i.description } } }],
            success_url: absolute(i.redirectUrl),
            cancel_url: absolute(i.redirectUrl),
            locale: i.locale ? STRIPE_LOCALES[i.locale] : undefined,
            customer: i.customerId,
            client_reference_id: i.metadata?.paymentId,
            metadata: i.metadata,
            expires_at: expires,
            payment_intent_data: {
              description: i.description,
              metadata: i.metadata,
              setup_future_usage: i.first ? "off_session" : undefined,
            },
          },
        },
        SessionBody,
      ),
      operation,
    );
  }

  return {
    name: "stripe",

    async createPayment(i) {
      const s = await createSession("payments.create", {
        amountCents: i.amountCents,
        description: i.description,
        redirectUrl: i.redirectUrl,
        locale: i.locale,
        ...(i.customerId ? { customerId: i.customerId } : {}),
        first: i.sequenceType === "first",
        metadata: { orderId: i.metadata.orderId, paymentId: i.metadata.paymentId },
        ...(i.expiresAt ? { expiresAt: i.expiresAt } : {}),
        idempotencyKey: i.idempotencyKey,
      });
      if (!s.url) throw new IntegrationError({ provider: "stripe", operation: "payments.create", retryable: false, code: "invalid_response", message: "stripe payments.create: no checkout url" });
      return { providerPaymentId: s.id, checkoutUrl: s.url, status: "open" };
    },

    async getPayment(providerPaymentId) {
      if (providerPaymentId.startsWith("pi_")) {
        const pi = await must(
          call("payments.get", { method: "GET", path: `/payment_intents/${enc(providerPaymentId)}`, digestPath: "/payment_intents/{id}", query: "expand[]=latest_charge" }, PaymentIntentBody),
          "payments.get",
        );
        return fromPaymentIntent(providerPaymentId, pi, null);
      }
      const s = await must(
        call(
          "payments.get",
          { method: "GET", path: `/checkout/sessions/${enc(providerPaymentId)}`, digestPath: "/checkout/sessions/{id}", query: "expand[]=payment_intent&expand[]=payment_intent.latest_charge" },
          SessionBody,
        ),
        "payments.get",
      );
      const pi = await paymentIntentOf(s);
      if (pi && s.status !== "open") return fromPaymentIntent(s.id, pi, s.id);
      return {
        providerPaymentId: s.id,
        status: s.status === "expired" ? "expired" : "open",
        method: null,
        amountCents: s.amount_total ?? 0,
        paidAt: null,
        mandateId: null,
        customerId: idOf(s.customer),
        refunds: [],
        chargebackCents: 0,
        details: { checkoutSessionId: s.id, ...(s.metadata?.paymentId ? { beamPaymentId: s.metadata.paymentId } : {}) },
      };
    },

    async refund(i) {
      const paymentIntent = await resolvePaymentIntentId(i.providerPaymentId, "refunds.create");
      const r = await must(
        call(
          "refunds.create",
          {
            method: "POST",
            path: "/refunds",
            digestPath: "/refunds",
            idempotencyKey: i.idempotencyKey,
            form: { payment_intent: paymentIntent, amount: i.amountCents, metadata: { description: i.description.slice(0, 500) } },
          },
          RefundBody,
        ),
        "refunds.create",
      );
      return { providerRefundId: r.id, status: r.status ? REFUND_STATUS[r.status] : "pending" };
    },

    async createCustomer(i) {
      const c = await must(
        call(
          "customers.create",
          { method: "POST", path: "/customers", digestPath: "/customers", idempotencyKey: i.idempotencyKey, form: { name: i.name, email: i.email || undefined, preferred_locales: [CUSTOMER_LOCALES[i.locale]] } },
          CustomerBody,
        ),
        "customers.create",
      );
      return { customerId: c.id };
    },

    async createMandate(i) {
      // SEPA needs the holder's email on the payment method: take it from the customer.
      const customer = await must(call("customers.get", { method: "GET", path: `/customers/${enc(i.customerId)}`, digestPath: "/customers/{id}" }, CustomerBody), "customers.get");
      const s = await must(
        call(
          "mandates.create",
          {
            method: "POST",
            path: "/setup_intents",
            digestPath: "/setup_intents",
            idempotencyKey: i.idempotencyKey,
            form: {
              customer: i.customerId,
              confirm: true,
              usage: "off_session",
              // Methods come from the dashboard; none may redirect (there is no customer present).
              automatic_payment_methods: { enabled: true, allow_redirects: "never" },
              payment_method_data: {
                type: "sepa_debit",
                sepa_debit: { iban: i.iban.replace(/\s+/g, "") },
                billing_details: { name: i.consumerName, email: customer.email ?? undefined },
              },
              // The customer signed the mandate with BEAM (paper or in person).
              mandate_data: { customer_acceptance: { type: "offline" } },
            },
          },
          SetupIntentBody,
        ),
        "mandates.create",
      );
      const pm = idOf(s.payment_method);
      if (!pm) throw new IntegrationError({ provider: "stripe", operation: "mandates.create", retryable: false, code: "invalid_response", message: "stripe mandates.create: no payment method" });
      return { mandateId: pm, status: s.status === "succeeded" ? "valid" : s.status === "processing" ? "pending" : "invalid" };
    },

    async getMandate(i) {
      const r = await call("mandates.get", { method: "GET", path: `/payment_methods/${enc(i.mandateId)}`, digestPath: "/payment_methods/{id}" }, PaymentMethodBody, [404]);
      // Unknown or no longer attached to this customer: it can never be charged again.
      if (!r.ok || idOf(r.value.customer) !== i.customerId) return { status: "invalid", method: "directdebit", summary: null };
      return { status: "valid", method: METHOD_NAMES[r.value.type] ?? r.value.type, summary: stripeMandateSummary(r.value) };
    },

    async revokeMandate(i) {
      // Already detached or unknown: the goal is reached (erasure jobs retry).
      await call("mandates.revoke", { method: "POST", path: `/payment_methods/${enc(i.mandateId)}/detach`, digestPath: "/payment_methods/{id}/detach", form: {} }, PaymentMethodBody, [400, 404]);
    },

    async deleteCustomer(customerId) {
      await call("customers.delete", { method: "DELETE", path: `/customers/${enc(customerId)}`, digestPath: "/customers/{id}" }, CustomerBody, [404]);
    },

    async createRecurringPayment(i) {
      const r = await call(
        "payments.create_recurring",
        {
          method: "POST",
          path: "/payment_intents",
          digestPath: "/payment_intents",
          idempotencyKey: i.idempotencyKey,
          form: {
            amount: i.amountCents,
            currency: "eur",
            customer: i.customerId,
            payment_method: i.mandateId,
            automatic_payment_methods: { enabled: true, allow_redirects: "never" },
            off_session: true,
            confirm: true,
            description: i.description,
            metadata: i.metadata,
          },
        },
        PaymentIntentBody,
        [402],
      );
      if (r.ok) {
        const status = mapPaymentIntentStatus(r.value);
        // Off-session there is no customer to complete an extra step: that attempt failed.
        return { providerPaymentId: r.value.id, status: r.value.status === "requires_action" ? "failed" : status };
      }
      const declined = r.error?.payment_intent;
      if (declined) return { providerPaymentId: declined.id, status: "failed" };
      throw new IntegrationError({ provider: "stripe", operation: "payments.create_recurring", statusCode: r.status, retryable: false, code: r.error?.code ?? "declined", message: "stripe payments.create_recurring: declined" });
    },

    async cancelPayment(providerPaymentId) {
      if (providerPaymentId.startsWith("pi_")) {
        const r = await call("payments.cancel", { method: "POST", path: `/payment_intents/${enc(providerPaymentId)}/cancel`, digestPath: "/payment_intents/{id}/cancel", form: {} }, PaymentIntentBody, [400]);
        return { cancelled: r.ok && r.value.status === "canceled" };
      }
      // 400: the session is no longer open (paid or already expired): not cancelable.
      const r = await call("payments.cancel", { method: "POST", path: `/checkout/sessions/${enc(providerPaymentId)}/expire`, digestPath: "/checkout/sessions/{id}/expire", form: {} }, SessionBody, [400]);
      return { cancelled: r.ok && r.value.status === "expired" };
    },

    async createPaymentLink(i) {
      const s = await createSession("payment_links.create", {
        amountCents: i.amountCents,
        description: i.description,
        redirectUrl: i.redirectUrl,
        expiresAt: i.expiresAt,
        ...(i.idempotencyKey ? { idempotencyKey: i.idempotencyKey } : {}),
      });
      return { linkId: s.id, url: s.url ?? "" };
    },

    createTerminalPayment() {
      return Promise.reject(
        new IntegrationError({ provider: "stripe", operation: "payments.create_terminal", retryable: false, code: "not_supported", message: "not_supported: terminal payments are not offered through Stripe" }),
      );
    },

    verifyWebhook(req) {
      return verifyStripeSignature(options.webhookSecret, req.headers.get("stripe-signature"), req.rawBody, now());
    },
  };
}
