/**
 * The Mollie adapter (commerce spec section 6): Payments API v2 over `fetch`, so tests inject a
 * `fetch` that returns recorded Mollie JSON (no network, no SDK transport).
 *
 * Calls: `POST /payments` (one-off, first, recurring and point-of-sale), `GET /payments/{id}`
 * with embedded refunds and chargebacks, `DELETE /payments/{id}` (cancel), `POST
 * /payments/{id}/refunds`, `POST /customers`, `DELETE /customers/{id}`, `POST|GET|DELETE
 * /customers/{id}/mandates[/{id}]`, `POST /payment-links`. Every create call sends
 * `Idempotency-Key` (the job key). Responses are validated with Zod; a malformed body is a
 * permanent `IntegrationError` (code `invalid_response`). 5xx, 429 and timeouts (10 s) are
 * retryable; other 4xx are permanent. Each call is reported through `onCall` with operation,
 * request digest (method and path only), status and duration; never bodies.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Locale } from "@beam/core/i18n";
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError } from "../_shared/errors";
import { trackCall, withTimeout } from "../_shared/timeout";
import { noopOnCall, type FetchLike, type OnCall } from "../_shared/types";
import type { PaymentProvider, PaymentStatus, ProviderPayment, ProviderRefund } from "./provider";

export type MollieProviderOptions = {
  apiKey: string;
  /** The public base URL of the app; relative webhook and redirect URLs resolve against it. */
  webhookBaseUrl: string;
  onCall?: OnCall;
  fetch?: FetchLike;
  /** `MOLLIE_WEBHOOK_SECRET`: when set, `verifyWebhook` requires query `t` or `X-Mollie-Signature` to match. */
  webhookSecret?: string;
  baseUrl?: string;
  timeoutMs?: number;
};

const MOLLIE_LOCALES: Record<Locale, string> = { "nl-BE": "nl_BE", "fr-BE": "fr_BE", en: "en_US" };

/** `4500` -> `"45.00"`. */
export function centsToMollieValue(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError(`amount must be a non-negative integer of cents, got ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** `"45.00"` -> `4500`, exact (no floating point). */
export function mollieValueToCents(value: string): number {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(value);
  if (!m) throw new RangeError(`not a Mollie amount: ${value}`);
  const cents = Number(m[2]) * 100 + Number(m[3]);
  return m[1] ? -cents : cents;
}

const Amount = z.object({ value: z.string().regex(/^-?\d+\.\d{2}$/), currency: z.literal("EUR") });
const cents = Amount.transform((a) => mollieValueToCents(a.value));

const MOLLIE_PAYMENT_STATUSES = ["open", "canceled", "pending", "authorized", "expired", "failed", "paid"] as const;

const RefundBody = z.object({
  resource: z.literal("refund").optional(),
  id: z.string().regex(/^re_/),
  amount: cents,
  status: z.enum(["queued", "pending", "processing", "refunded", "failed", "canceled"]),
});

const ChargebackBody = z.object({ id: z.string(), amount: cents });

const PaymentBody = z.object({
  resource: z.literal("payment").optional(),
  id: z.string().regex(/^tr_/),
  status: z.enum(MOLLIE_PAYMENT_STATUSES),
  amount: cents,
  amountRefunded: cents.optional(),
  amountChargedBack: cents.optional(),
  method: z.string().nullable().optional(),
  paidAt: z.string().datetime({ offset: true }).nullable().optional(),
  mandateId: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  details: z.record(z.string(), z.unknown()).nullable().optional(),
  _links: z.object({ checkout: z.object({ href: z.string().url() }).optional() }).passthrough().optional(),
  _embedded: z
    .object({ refunds: z.array(RefundBody).optional(), chargebacks: z.array(ChargebackBody).optional() })
    .passthrough()
    .optional(),
});
type PaymentBody = z.infer<typeof PaymentBody>;

const CustomerBody = z.object({ id: z.string().regex(/^cst_/) });
const MandateBody = z.object({
  id: z.string().regex(/^mdt_/),
  status: z.enum(["pending", "valid", "invalid"]),
  method: z.string(),
  details: z.record(z.string(), z.unknown()).nullable().optional(),
});
const PaymentLinkBody = z.object({
  id: z.string().regex(/^pl_/),
  _links: z.object({ paymentLink: z.object({ href: z.string().url() }) }).passthrough(),
});

const REFUND_STATUS: Record<z.infer<typeof RefundBody>["status"], ProviderRefund["status"]> = {
  queued: "pending",
  pending: "pending",
  processing: "pending",
  refunded: "refunded",
  failed: "failed",
  canceled: "failed",
};

/**
 * Mollie's payment status in BEAM's `payments_status`. Mollie keeps a refunded payment `paid`
 * with `amountRefunded`; BEAM reads it as `refunded` (all) or `partially_refunded`.
 */
export function mapMollieStatus(status: (typeof MOLLIE_PAYMENT_STATUSES)[number], amountCents: number, refundedCents = 0): PaymentStatus {
  if (status === "canceled") return "cancelled";
  if (status === "paid" && refundedCents > 0) return refundedCents >= amountCents ? "refunded" : "partially_refunded";
  return status;
}

/** Detail keys that carry no card number, IBAN, holder name or fingerprint. */
const SAFE_DETAIL_KEYS = new Set(["cardLabel", "cardCountryCode", "cardSecurity", "cardAudience", "feeRegion", "failureReason", "terminalId", "bankReasonCode", "dueDate", "receipt"]);

/** Payment details with card and IBAN data removed (`ProviderPayment.details`). */
export function scrubDetails(details: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details ?? {})) {
    if (!SAFE_DETAIL_KEYS.has(k)) continue;
    if (k === "receipt" && v && typeof v === "object") {
      const r = v as Record<string, unknown>;
      out.receipt = Object.fromEntries(Object.entries(r).filter(([rk]) => ["authorizationCode", "applicationIdentifier", "cardReadMethod", "cardVerificationMethod"].includes(rk)));
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** A masked mandate summary such as `BE** **** **** 7034` or `Visa **** 4242`; never the full account. */
export function mandateSummary(method: string, details: Record<string, unknown> | null | undefined): string | null {
  const d = details ?? {};
  const account = typeof d.consumerAccount === "string" ? d.consumerAccount.replace(/\s+/g, "") : null;
  if (account && account.length >= 6) return `${account.slice(0, 2)}** **** **** ${account.slice(-4)}`;
  const card = typeof d.cardNumber === "string" ? d.cardNumber.slice(-4) : null;
  if (card) return `${typeof d.cardLabel === "string" ? d.cardLabel : method} **** ${card}`;
  return null;
}

function toProviderPayment(p: PaymentBody): ProviderPayment {
  const refunds: ProviderRefund[] = (p._embedded?.refunds ?? []).map((r) => ({ providerRefundId: r.id, amountCents: r.amount, status: REFUND_STATUS[r.status] }));
  const chargebackCents = p.amountChargedBack ?? (p._embedded?.chargebacks ?? []).reduce((s, c) => s + c.amount, 0);
  return {
    providerPaymentId: p.id,
    status: mapMollieStatus(p.status, p.amount, p.amountRefunded ?? 0),
    method: p.method ?? null,
    amountCents: p.amount,
    paidAt: p.paidAt ? new Date(p.paidAt) : null,
    mandateId: p.mandateId ?? null,
    customerId: p.customerId ?? null,
    refunds,
    chargebackCents,
    details: scrubDetails(p.details),
  };
}

/** Mollie cannot reach a local machine and rejects such webhook URLs; they are left out. */
function isLocalHost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname.endsWith(".local");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** A Mollie webhook delivery names a payment `tr_<alphanumeric>`. */
const WEBHOOK_ID = /^tr_[A-Za-z0-9]{4,64}$/;

export function createMollieProvider(options: MollieProviderOptions): PaymentProvider {
  const onCall = options.onCall ?? noopOnCall;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = (options.baseUrl ?? "https://api.mollie.com/v2").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const appBase = options.webhookBaseUrl.replace(/\/$/, "");

  const absolute = (url: string) => new URL(url, `${appBase}/`);
  const webhookField = (url: string) => {
    const u = absolute(url);
    return isLocalHost(u) ? {} : { webhookUrl: u.toString() };
  };

  /** One tracked HTTP call. `accept` lets listed statuses through as `null` (404 of a delete, 422 of a cancel). */
  function call<S extends z.ZodTypeAny>(
    operation: string,
    req: { method: "GET" | "POST" | "DELETE"; path: string; digestPath: string; query?: string; body?: unknown; idempotencyKey?: string | undefined },
    schema: S | null,
    accept: readonly number[] = [],
  ): Promise<z.output<S> | null> {
    return trackCall(onCall, { provider: "mollie", operation, requestDigest: digestRequest({ method: req.method, path: req.digestPath }) }, () =>
      withTimeout(
        async (signal) => {
          const res = await doFetch(`${base}${req.path}${req.query ? `?${req.query}` : ""}`, {
            method: req.method,
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              accept: "application/hal+json",
              ...(req.body === undefined ? {} : { "content-type": "application/json" }),
              ...(req.idempotencyKey ? { "idempotency-key": req.idempotencyKey } : {}),
            },
            ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
            signal,
          });
          if (accept.includes(res.status)) return { value: null, statusCode: res.status };
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            let detail = text;
            try {
              const parsed = JSON.parse(text) as { detail?: unknown; title?: unknown };
              if (typeof parsed.detail === "string") detail = parsed.detail;
              else if (typeof parsed.title === "string") detail = parsed.title;
            } catch {
              // not JSON: keep the text (scrubbed by errorFromStatus)
            }
            throw errorFromStatus("mollie", operation, res.status, detail);
          }
          if (!schema) return { value: null, statusCode: res.status };
          const json: unknown = res.status === 204 ? null : await res.json().catch(() => undefined);
          const parsed = schema.safeParse(json);
          if (!parsed.success) {
            throw new IntegrationError({
              provider: "mollie",
              operation,
              statusCode: res.status,
              retryable: false,
              code: "invalid_response",
              message: `mollie ${operation}: unexpected response (${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")})`,
            });
          }
          return { value: parsed.data as z.output<S>, statusCode: res.status };
        },
        timeoutMs,
        { provider: "mollie", operation },
      ),
    );
  }

  const must = <T>(v: T | null): T => v as T;
  const amount = (c: number) => ({ currency: "EUR", value: centsToMollieValue(c) });
  const enc = encodeURIComponent;

  return {
    name: "mollie",

    async createPayment(i) {
      const p = must(
        await call(
          "payments.create",
          {
            method: "POST",
            path: "/payments",
            digestPath: "/payments",
            idempotencyKey: i.idempotencyKey,
            body: {
              amount: amount(i.amountCents),
              description: i.description,
              redirectUrl: absolute(i.redirectUrl).toString(),
              ...webhookField(i.webhookUrl),
              locale: MOLLIE_LOCALES[i.locale],
              ...(i.method ? { method: i.method } : {}),
              ...(i.customerId ? { customerId: i.customerId } : {}),
              sequenceType: i.sequenceType,
              metadata: { orderId: i.metadata.orderId, paymentId: i.metadata.paymentId },
            },
          },
          PaymentBody,
        ),
      );
      const checkoutUrl = p._links?.checkout?.href;
      if (!checkoutUrl && p.status === "open") {
        throw new IntegrationError({ provider: "mollie", operation: "payments.create", retryable: false, code: "invalid_response", message: "mollie payments.create: no checkout link" });
      }
      return { providerPaymentId: p.id, checkoutUrl: checkoutUrl ?? "", status: mapMollieStatus(p.status, p.amount) };
    },

    async getPayment(providerPaymentId) {
      const p = must(
        await call(
          "payments.get",
          { method: "GET", path: `/payments/${enc(providerPaymentId)}`, digestPath: "/payments/{id}", query: "embed=refunds,chargebacks" },
          PaymentBody,
        ),
      );
      return toProviderPayment(p);
    },

    async refund(i) {
      const r = must(
        await call(
          "refunds.create",
          {
            method: "POST",
            path: `/payments/${enc(i.providerPaymentId)}/refunds`,
            digestPath: "/payments/{id}/refunds",
            idempotencyKey: i.idempotencyKey,
            body: { amount: amount(i.amountCents), description: i.description },
          },
          RefundBody,
        ),
      );
      return { providerRefundId: r.id, status: REFUND_STATUS[r.status] };
    },

    async createCustomer(i) {
      const c = must(
        await call(
          "customers.create",
          { method: "POST", path: "/customers", digestPath: "/customers", idempotencyKey: i.idempotencyKey, body: { name: i.name, email: i.email, locale: MOLLIE_LOCALES[i.locale] } },
          CustomerBody,
        ),
      );
      return { customerId: c.id };
    },

    async createMandate(i) {
      const m = must(
        await call(
          "mandates.create",
          {
            method: "POST",
            path: `/customers/${enc(i.customerId)}/mandates`,
            digestPath: "/customers/{id}/mandates",
            idempotencyKey: i.idempotencyKey,
            body: { method: i.method, consumerName: i.consumerName, consumerAccount: i.iban.replace(/\s+/g, "") },
          },
          MandateBody,
        ),
      );
      return { mandateId: m.id, status: m.status };
    },

    async getMandate(i) {
      const m = await call(
        "mandates.get",
        { method: "GET", path: `/customers/${enc(i.customerId)}/mandates/${enc(i.mandateId)}`, digestPath: "/customers/{id}/mandates/{id}" },
        MandateBody,
        [404, 410],
      );
      // A mandate the provider no longer knows can never be charged again.
      if (!m) return { status: "invalid", method: "directdebit", summary: null };
      return { status: m.status, method: m.method, summary: mandateSummary(m.method, m.details) };
    },

    async revokeMandate(i) {
      // Already revoked or unknown at the provider: the goal is reached (erasure jobs retry).
      await call(
        "mandates.revoke",
        { method: "DELETE", path: `/customers/${enc(i.customerId)}/mandates/${enc(i.mandateId)}`, digestPath: "/customers/{id}/mandates/{id}" },
        null,
        [404, 410],
      );
    },

    async deleteCustomer(customerId) {
      await call("customers.delete", { method: "DELETE", path: `/customers/${enc(customerId)}`, digestPath: "/customers/{id}" }, null, [404, 410]);
    },

    async createRecurringPayment(i) {
      const p = must(
        await call(
          "payments.create_recurring",
          {
            method: "POST",
            path: "/payments",
            digestPath: "/payments",
            idempotencyKey: i.idempotencyKey,
            body: {
              amount: amount(i.amountCents),
              description: i.description,
              customerId: i.customerId,
              mandateId: i.mandateId,
              sequenceType: "recurring",
              ...webhookField(i.webhookUrl),
              metadata: i.metadata,
            },
          },
          PaymentBody,
        ),
      );
      return { providerPaymentId: p.id, status: mapMollieStatus(p.status, p.amount) };
    },

    async cancelPayment(providerPaymentId) {
      const p = await call("payments.cancel", { method: "DELETE", path: `/payments/${enc(providerPaymentId)}`, digestPath: "/payments/{id}" }, PaymentBody, [422]);
      // 422: Mollie says the payment is not cancelable (rule 22c).
      return { cancelled: p !== null && p.status === "canceled" };
    },

    async createPaymentLink(i) {
      const l = must(
        await call(
          "payment_links.create",
          {
            method: "POST",
            path: "/payment-links",
            digestPath: "/payment-links",
            idempotencyKey: i.idempotencyKey,
            body: {
              amount: amount(i.amountCents),
              description: i.description,
              expiresAt: i.expiresAt.toISOString().replace(/\.\d{3}Z$/, "+00:00"),
              redirectUrl: absolute(i.redirectUrl).toString(),
              ...webhookField(i.webhookUrl),
            },
          },
          PaymentLinkBody,
        ),
      );
      return { linkId: l.id, url: l._links.paymentLink.href };
    },

    async createTerminalPayment(i) {
      const p = must(
        await call(
          "payments.create_terminal",
          {
            method: "POST",
            path: "/payments",
            digestPath: "/payments",
            idempotencyKey: i.idempotencyKey,
            body: {
              amount: amount(i.amountCents),
              description: i.description,
              method: "pointofsale",
              terminalId: i.terminalId,
              ...webhookField(i.webhookUrl),
              metadata: i.metadata,
            },
          },
          PaymentBody,
        ),
      );
      return { providerPaymentId: p.id, status: mapMollieStatus(p.status, p.amount) };
    },

    verifyWebhook(req) {
      const id = new URLSearchParams(req.rawBody).get("id");
      if (!id || !WEBHOOK_ID.test(id)) return false;
      const secret = options.webhookSecret;
      if (!secret) return true; // the fetch by id is the real verification (rule 30)
      const token = req.url.searchParams.get("t");
      if (token && safeEqual(token, secret)) return true;
      const signature = req.headers.get("x-mollie-signature");
      if (!signature) return false;
      const expected = createHmac("sha256", secret).update(req.rawBody).digest("hex");
      return safeEqual(signature.trim().toLowerCase().replace(/^sha256=/, ""), expected);
    },
  };
}
