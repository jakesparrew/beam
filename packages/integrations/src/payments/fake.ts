/**
 * The payments fake (runbook section 1.5, BS-9). In-memory payments on
 * `globalThis.__beamFakePayments`, so the dev pay page (`/api/dev/fake-pay/<id>`) and the
 * webhook job of the same process see one store. Mandates are `valid` at once; recurring
 * payments settle `paid` unless `failNext()` was called. Tests drive outcomes with `settle`.
 */
import { randomUUID } from "node:crypto";
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type FakeCall, type OnCall } from "../_shared/types";
import type { PaymentProvider, PaymentStatus, ProviderPayment } from "./provider";

export type FakeOutcome = "paid" | "failed" | "expired" | "cancelled";

export type FakePaymentRecord = ProviderPayment & {
  description: string;
  redirectUrl: string;
  webhookUrl: string;
  kind: "checkout" | "recurring" | "terminal";
  metadata: Record<string, string>;
  createdAt: Date;
};

type Store = {
  payments: Map<string, FakePaymentRecord>;
  byKey: Map<string, string>;
  customers: Map<string, { name: string; email: string; deleted: boolean }>;
  mandates: Map<string, { customerId: string; status: "pending" | "valid" | "invalid"; revoked: boolean }>;
  links: Map<string, { url: string; amountCents: number }>;
  seq: number;
};

const g = globalThis as { __beamFakePayments?: Store };

function newStore(): Store {
  return { payments: new Map(), byKey: new Map(), customers: new Map(), mandates: new Map(), links: new Map(), seq: 0 };
}

/** The process-wide store (shared by every fake instance unless `isolated: true`). */
export function fakePaymentsStore(): Store {
  g.__beamFakePayments ??= newStore();
  return g.__beamFakePayments;
}

export type PaymentsFake = PaymentProvider & {
  readonly calls: FakeCall[];
  /** Set the outcome of a payment, as the pay page buttons do. */
  settle(providerPaymentId: string, outcome: FakeOutcome, at?: Date): FakePaymentRecord;
  chargeback(providerPaymentId: string, amountCents: number): FakePaymentRecord;
  /**
   * The next call of `operation` (or of any operation) fails with HTTP `status`. Without a
   * status, the next recurring payment is created `failed` (other operations get a 500).
   */
  failNext(operation?: string, opts?: { status?: number }): void;
  payment(providerPaymentId: string): FakePaymentRecord | undefined;
  reset(): void;
};

export type FakePaymentProvider = PaymentsFake;

export function createPaymentsFake(
  options: { appUrl?: string; onCall?: OnCall; now?: () => Date; isolated?: boolean } = {},
): PaymentsFake {
  const store = options.isolated ? newStore() : fakePaymentsStore();
  const onCall = options.onCall ?? noopOnCall;
  const now = options.now ?? (() => new Date());
  const appUrl = (options.appUrl ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const calls: FakeCall[] = [];
  /** `status: null` means "the default failure": a failed recurring payment, a 500 elsewhere. */
  const failures: { operation: string | null; status: number | null }[] = [];
  const id = (prefix: string) => `${prefix}_fake${++store.seq}${randomUUID().slice(0, 8)}`;

  function run<T>(operation: string, input: unknown, work: () => T): Promise<T> {
    calls.push({ operation, input, at: now() });
    return trackCall(onCall, { provider: "mollie", operation, requestDigest: digestRequest({ method: "POST", path: `/fake/${operation}` }) }, () => {
      const index = failures.findIndex((f) => f.operation === null || f.operation === operation);
      if (index >= 0) {
        const [failure] = failures.splice(index, 1);
        throw errorFromStatus("mollie", operation, failure!.status ?? 500);
      }
      return { value: work(), statusCode: 200 };
    });
  }

  function get(providerPaymentId: string): FakePaymentRecord {
    const p = store.payments.get(providerPaymentId);
    if (!p) throw new IntegrationError({ provider: "mollie", operation: "payments.get", retryable: false, statusCode: 404, message: `fake payment ${providerPaymentId} not found` });
    return p;
  }

  function insert(kind: FakePaymentRecord["kind"], input: { amountCents: number; description: string; redirectUrl?: string; webhookUrl: string; metadata: Record<string, string>; customerId?: string; mandateId?: string; method?: string }): FakePaymentRecord {
    const providerPaymentId = id("tr");
    const record: FakePaymentRecord = {
      providerPaymentId,
      status: "open",
      method: input.method ?? null,
      amountCents: input.amountCents,
      paidAt: null,
      mandateId: input.mandateId ?? null,
      customerId: input.customerId ?? null,
      refunds: [],
      chargebackCents: 0,
      details: {},
      description: input.description,
      redirectUrl: input.redirectUrl ?? "",
      webhookUrl: input.webhookUrl,
      kind,
      metadata: input.metadata,
      createdAt: now(),
    };
    store.payments.set(providerPaymentId, record);
    return record;
  }

  function apply(record: FakePaymentRecord, outcome: FakeOutcome, at: Date): FakePaymentRecord {
    record.status = outcome;
    record.paidAt = outcome === "paid" ? at : null;
    if (outcome === "paid") record.method ??= record.kind === "terminal" ? "pointofsale" : record.kind === "recurring" ? "directdebit" : "bancontact";
    return record;
  }

  const fake: PaymentsFake = {
    name: "fake",
    calls,
    createPayment(i) {
      return run("payments.create", i, () => {
        const existing = store.byKey.get(i.idempotencyKey);
        const record = existing ? get(existing) : insert("checkout", { ...i, metadata: { ...i.metadata } });
        store.byKey.set(i.idempotencyKey, record.providerPaymentId);
        return { providerPaymentId: record.providerPaymentId, checkoutUrl: `${appUrl}/api/dev/fake-pay/${record.providerPaymentId}`, status: record.status };
      });
    },
    getPayment(providerPaymentId) {
      return run("payments.get", { providerPaymentId }, () => {
        const p = get(providerPaymentId);
        return { ...p, refunds: p.refunds.map((r) => ({ ...r })), details: { ...p.details } };
      });
    },
    refund(i) {
      return run("refunds.create", i, () => {
        const p = get(i.providerPaymentId);
        if (p.status !== "paid" && p.status !== "partially_refunded") {
          throw new IntegrationError({ provider: "mollie", operation: "refunds.create", retryable: false, statusCode: 422, message: "payment is not refundable" });
        }
        const refunded = p.refunds.reduce((s, r) => s + r.amountCents, 0) + i.amountCents;
        if (refunded > p.amountCents) {
          throw new IntegrationError({ provider: "mollie", operation: "refunds.create", retryable: false, statusCode: 422, message: "refund exceeds payment" });
        }
        const refund = { providerRefundId: id("re"), amountCents: i.amountCents, status: "refunded" as const };
        p.refunds.push(refund);
        p.status = refunded === p.amountCents ? "refunded" : "partially_refunded";
        return { providerRefundId: refund.providerRefundId, status: refund.status };
      });
    },
    createCustomer(i) {
      return run("customers.create", { locale: i.locale }, () => {
        const customerId = id("cst");
        store.customers.set(customerId, { name: i.name, email: i.email, deleted: false });
        return { customerId };
      });
    },
    createMandate(i) {
      return run("mandates.create", { customerId: i.customerId }, () => {
        const mandateId = id("mdt");
        store.mandates.set(mandateId, { customerId: i.customerId, status: "valid", revoked: false });
        return { mandateId, status: "valid" };
      });
    },
    getMandate(i) {
      return run("mandates.get", i, () => {
        const m = store.mandates.get(i.mandateId);
        const status = !m || m.revoked || m.customerId !== i.customerId ? ("invalid" as const) : m.status;
        return { status, method: "directdebit", summary: m ? "BE** **** **** 0000" : null };
      });
    },
    revokeMandate(i) {
      return run("mandates.revoke", i, () => {
        const m = store.mandates.get(i.mandateId);
        if (m) m.revoked = true;
      });
    },
    deleteCustomer(customerId) {
      return run("customers.delete", { customerId }, () => {
        const c = store.customers.get(customerId);
        if (c) Object.assign(c, { deleted: true, name: "", email: "" });
      });
    },
    createRecurringPayment(i) {
      const soft = failures.findIndex((f) => f.status === null && (f.operation === null || f.operation === "payments.create_recurring"));
      const failThis = soft >= 0;
      if (failThis) failures.splice(soft, 1);
      return run("payments.create_recurring", { customerId: i.customerId, mandateId: i.mandateId }, () => {
        const existing = store.byKey.get(i.idempotencyKey);
        if (existing) return { providerPaymentId: existing, status: get(existing).status };
        const record = insert("recurring", { ...i, method: "directdebit" });
        store.byKey.set(i.idempotencyKey, record.providerPaymentId);
        const m = store.mandates.get(i.mandateId);
        apply(record, m && !m.revoked && !failThis ? "paid" : "failed", now());
        return { providerPaymentId: record.providerPaymentId, status: record.status };
      });
    },
    cancelPayment(providerPaymentId) {
      return run("payments.cancel", { providerPaymentId }, () => {
        const p = get(providerPaymentId);
        if (p.status !== "open" && p.status !== "pending") return { cancelled: false };
        apply(p, "cancelled", now());
        return { cancelled: true };
      });
    },
    createPaymentLink(i) {
      return run("payment_links.create", { amountCents: i.amountCents }, () => {
        const linkId = id("pl");
        const url = `${appUrl}/api/dev/fake-pay/${linkId}?kind=link`;
        store.links.set(linkId, { url, amountCents: i.amountCents });
        return { linkId, url };
      });
    },
    createTerminalPayment(i) {
      return run("payments.create_terminal", { terminalId: i.terminalId }, () => {
        const record = insert("terminal", { ...i, method: "pointofsale" });
        return { providerPaymentId: record.providerPaymentId, status: record.status };
      });
    },
    verifyWebhook(req) {
      const id = new URLSearchParams(req.rawBody).get("id");
      return !!id && store.payments.has(id);
    },
    settle(providerPaymentId, outcome, at) {
      return apply(get(providerPaymentId), outcome, at ?? now());
    },
    chargeback(providerPaymentId, amountCents) {
      const p = get(providerPaymentId);
      p.chargebackCents += amountCents;
      return p;
    },
    failNext(operation, opts) {
      failures.push({ operation: operation ?? null, status: opts?.status ?? null });
    },
    payment(providerPaymentId) {
      return store.payments.get(providerPaymentId);
    },
    reset() {
      const fresh = newStore();
      Object.assign(store, fresh);
      calls.length = 0;
      failures.length = 0;
    },
  };
  return fake;
}

export type { PaymentStatus };
