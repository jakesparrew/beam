/**
 * The `PaymentProvider` interface (architecture section 8, commerce spec section 6). Mollie is
 * the real adapter; Stripe and Viva are stubs; the fake covers tests and `beam_dev`. Commerce
 * extends this file additively. Adapters take credentials in the constructor, validate
 * responses with Zod, throw `IntegrationError { provider, retryable }` and report each call
 * through `onCall`. Every create call carries an `Idempotency-Key` equal to the job key.
 */
import type { Locale } from "@beam/core/i18n";

export const PAYMENT_STATUSES = [
  "open",
  "pending",
  "authorized",
  "paid",
  "failed",
  "expired",
  "cancelled",
  "refunded",
  "partially_refunded",
] as const;

/** Values of `payments_status`. */
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type PaymentProviderName = "mollie" | "stripe" | "viva" | "fake";

export type ProviderRefund = { providerRefundId: string; amountCents: number; status: "pending" | "refunded" | "failed" };

export type ProviderPayment = {
  providerPaymentId: string;
  status: PaymentStatus;
  method: string | null;
  amountCents: number;
  paidAt: Date | null;
  mandateId: string | null;
  customerId: string | null;
  refunds: ProviderRefund[];
  chargebackCents: number;
  /** Provider details with card and IBAN data scrubbed. */
  details: Record<string, unknown>;
};

export type CreatePaymentInput = {
  amountCents: number;
  description: string;
  redirectUrl: string;
  webhookUrl: string;
  locale: Locale;
  method?: string;
  customerId?: string;
  sequenceType: "oneoff" | "first";
  metadata: { orderId: string; paymentId: string };
  expiresAt?: Date;
  idempotencyKey: string;
};

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createPayment(i: CreatePaymentInput): Promise<{ providerPaymentId: string; checkoutUrl: string; status: PaymentStatus }>;
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;
  refund(i: { providerPaymentId: string; amountCents: number; description: string }): Promise<{
    providerRefundId: string;
    status: "pending" | "refunded" | "failed";
  }>;
  createCustomer(i: { name: string; email: string; locale: Locale }): Promise<{ customerId: string }>;
  createMandate(i: { customerId: string; method: "directdebit"; consumerName: string; iban: string }): Promise<{ mandateId: string; status: string }>;
  getMandate(i: { customerId: string; mandateId: string }): Promise<{ status: "pending" | "valid" | "invalid"; method: string; summary: string | null }>;
  revokeMandate(i: { customerId: string; mandateId: string }): Promise<void>;
  deleteCustomer(customerId: string): Promise<void>;
  createRecurringPayment(i: {
    customerId: string;
    mandateId: string;
    amountCents: number;
    description: string;
    webhookUrl: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ providerPaymentId: string; status: PaymentStatus }>;
  /** `cancelled: false` when the provider says the payment is not cancelable. */
  cancelPayment(providerPaymentId: string): Promise<{ cancelled: boolean }>;
  createPaymentLink(i: { amountCents: number; description: string; expiresAt: Date; redirectUrl: string; webhookUrl: string }): Promise<{
    linkId: string;
    url: string;
  }>;
  createTerminalPayment(i: {
    terminalId: string;
    amountCents: number;
    description: string;
    webhookUrl: string;
    metadata: Record<string, string>;
  }): Promise<{ providerPaymentId: string; status: PaymentStatus }>;
  /** Mollie posts only `id=<payment id>`; verification means the id is ours and well formed. */
  verifyWebhook(req: { headers: Headers; rawBody: string; url: URL }): boolean;
}

/** Terminal statuses: nothing moves a payment out of them except refunds and chargebacks. */
export const FINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = ["paid", "failed", "expired", "cancelled", "refunded", "partially_refunded"];

export function isPaymentStatus(value: string): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(value);
}
