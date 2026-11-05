/**
 * The Billit fake (runbook section 1.5, finance spec section 6): in-memory parties and orders,
 * `billit_<n>` ids, used by every test (no network). Keeps the Wave 0 name and constructor
 * (`createBillitFake({ onCall?, now? })`) so other modules' tests keep compiling.
 *
 * Test controls: `failNext(operation, { status })` (the next call of that operation, or of any
 * operation with `null`, fails like the client would: 5xx/429 retryable, other 4xx permanent,
 * 401/403 `code = 'auth'`), `loseResponseNext('createOrder')` (creates, then throws a retryable
 * timeout), `markPaid(reference, paidOn, amountCents?)` (a bank transfer arrives; partial when
 * the amount is below the total), `setPeppolReachable(vat, boolean)` and `snapshot()`.
 * A duplicate `OrderNumber` is refused with 422, as Billit does.
 */
import { digestRequest } from "../_shared/digest";
import { IntegrationError } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type FakeCall, type OnCall } from "../_shared/types";
import { billitError } from "./client";
import type { BillitApi, BillitOrder, BillitOrderInput, BillitPartyInput } from "./types";

type FakePayment = { paidOn: string; amountCents: number; method: string; reference: string | null };
type FakeOrder = BillitOrder & { input: BillitOrderInput; paidCents: number; createdAt: Date; payments: FakePayment[]; PaymentMethod: string | null };
type FakeParty = BillitPartyInput & { PartyID: string; anonymised: boolean };

export type BillitFake = BillitApi & {
  readonly calls: FakeCall[];
  failNext(operation: keyof BillitApi | null, opts?: { status?: number }): void;
  /** `createOrder` creates the order, then throws a retryable timeout (a lost response). */
  loseResponseNext(operation: "createOrder"): void;
  /** Bank transfer received: paid when the amount covers the total (default: the total). */
  markPaid(reference: string, paidOn: string, amountCents?: number): void;
  setPeppolReachable(vatNumber: string, reachable: boolean): void;
  snapshot(): { parties: FakeParty[]; orders: FakeOrder[] };
  reset(): void;
};

const PAGE_SIZE = 50;

/** The operation names the real client logs (`integration_calls.operation`). */
const OPERATION: Record<keyof BillitApi, string> = {
  upsertParty: "parties.upsert",
  createOrder: "orders.create",
  findOrderByReference: "orders.find",
  getOrder: "orders.get",
  listOrdersSince: "orders.list",
  sendOrder: "orders.send",
  registerPayment: "orders.register_payment",
  anonymiseCustomer: "parties.anonymise",
};

/** Billit's total: per line `Quantity x UnitPriceExcl x (1 + VAT)`, rounded to the cent, summed. */
export function billitTotalInclCents(lines: BillitOrderInput["OrderLines"]): number {
  return lines.reduce((sum, l) => sum + Math.round(l.Quantity * l.UnitPriceExcl * (100 + l.VATPercentage)), 0);
}

export function createBillitFake(options: { onCall?: OnCall; now?: () => Date } = {}): BillitFake {
  const onCall = options.onCall ?? noopOnCall;
  const now = options.now ?? (() => new Date());
  const calls: FakeCall[] = [];
  let parties = new Map<string, FakeParty>();
  let orders = new Map<string, FakeOrder>();
  let failures: { operation: string | null; status: number }[] = [];
  let lose = 0;
  let unreachable = new Set<string>();
  let seq = 0;
  // A per-instance token keeps ids unique across processes: a re-seeded dev database already holds
  // the ids an earlier run handed out, and invoices.billit_id is unique.
  const token = Math.random().toString(36).slice(2, 8);

  function run<T>(operation: keyof BillitApi, input: unknown, work: () => T): Promise<T> {
    calls.push({ operation, input, at: now() });
    const name = OPERATION[operation];
    return trackCall(onCall, { provider: "billit", operation: name, requestDigest: digestRequest({ method: "POST", path: `/v1/${name}` }) }, () => {
      const index = failures.findIndex((f) => f.operation === null || f.operation === operation);
      if (index >= 0) {
        const [failure] = failures.splice(index, 1);
        throw billitError(name, failure!.status, "simulated failure");
      }
      return { value: work(), statusCode: 200 };
    });
  }

  const order = (orderId: string): FakeOrder => {
    const o = orders.get(orderId);
    if (!o) throw new IntegrationError({ provider: "billit", operation: "orders.get", retryable: false, statusCode: 404, message: `order ${orderId} not found` });
    return o;
  };
  const totalCents = (o: FakeOrder) => Math.round(o.TotalIncl * 100);
  const publicOrder = (o: FakeOrder): BillitOrder => ({
    OrderID: o.OrderID,
    OrderNumber: o.OrderNumber,
    OrderType: o.OrderType,
    Paid: o.Paid,
    PaidDate: o.PaidDate,
    TotalIncl: o.TotalIncl,
    ToPay: Math.max(0, totalCents(o) - o.paidCents) / 100,
    Status: o.Status,
    PeppolStatus: o.PeppolStatus ?? null,
    ...(o.LastModified ? { LastModified: o.LastModified } : {}),
    CustomerPartyID: o.input.Customer.PartyID,
  });

  const fake: BillitFake = {
    calls,
    upsertParty(input) {
      return run("upsertParty", { PartyID: input.PartyID ?? null, ExternalProviderID: input.ExternalProviderID ?? null }, () => {
        const existing =
          (input.PartyID && parties.get(input.PartyID)) ||
          (input.ExternalProviderID ? [...parties.values()].find((p) => p.ExternalProviderID === input.ExternalProviderID) : undefined);
        const partyId = existing?.PartyID ?? `billit_${token}_${++seq}`;
        parties.set(partyId, { ...existing, ...input, PartyID: partyId, anonymised: existing?.anonymised ?? false });
        return { partyId };
      });
    },
    async createOrder(input) {
      const result = await run("createOrder", { OrderNumber: input.OrderNumber }, () => {
        const found = [...orders.values()].find((o) => o.OrderNumber === input.OrderNumber);
        if (found) {
          throw new IntegrationError({ provider: "billit", operation: "orders.create", retryable: false, statusCode: 422, message: `OrderNumber ${input.OrderNumber} already exists` });
        }
        const orderId = `billit_${token}_${++seq}`;
        const total = billitTotalInclCents(input.OrderLines);
        orders.set(orderId, {
          OrderID: orderId,
          OrderNumber: input.OrderNumber,
          OrderType: input.OrderType,
          Paid: input.Paid === true,
          PaidDate: input.Paid ? (input.PaidDate ?? null) : null,
          TotalIncl: total / 100,
          Status: "ToSend",
          PeppolStatus: null,
          LastModified: now().toISOString(),
          input,
          paidCents: input.Paid ? total : 0,
          createdAt: now(),
          payments: [],
          PaymentMethod: input.Paid ? (input.PaymentMethod ?? null) : null,
        });
        return { orderId };
      });
      if (lose > 0) {
        lose -= 1;
        throw new IntegrationError({ provider: "billit", operation: "orders.create", retryable: true, code: "timeout", message: "billit orders.create timed out" });
      }
      return result;
    },
    findOrderByReference(reference) {
      return run("findOrderByReference", { reference }, () => {
        const o = [...orders.values()].find((x) => x.OrderNumber === reference);
        return o ? { orderId: o.OrderID } : null;
      });
    },
    getOrder(orderId) {
      return run("getOrder", { orderId }, () => publicOrder(order(orderId)));
    },
    listOrdersSince(since, page) {
      return run("listOrdersSince", { since: since.toISOString(), page }, () => {
        const all = [...orders.values()]
          .filter((o) => (o.LastModified ?? "") >= since.toISOString())
          .sort((a, b) => a.OrderID.localeCompare(b.OrderID, undefined, { numeric: true }));
        const items = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(publicOrder);
        return { items, hasMore: all.length > (page + 1) * PAGE_SIZE };
      });
    },
    sendOrder(orderId, transport) {
      return run("sendOrder", { orderId, transport }, () => {
        const o = order(orderId);
        const party = parties.get(o.input.Customer.PartyID);
        if (party?.VATNumber && unreachable.has(party.VATNumber)) {
          o.PeppolStatus = "failed";
          throw new IntegrationError({ provider: "billit", operation: "orders.send", retryable: false, statusCode: 422, message: "receiver not found on Peppol" });
        }
        o.Status = "Sent";
        o.PeppolStatus = "sent";
        o.LastModified = now().toISOString();
      });
    },
    registerPayment(orderId, p) {
      return run("registerPayment", { orderId, method: p.method }, () => {
        const o = order(orderId);
        o.payments.push({ ...p });
        o.paidCents = Math.max(o.paidCents, p.amountCents);
        o.Paid = o.paidCents >= totalCents(o);
        o.PaidDate = o.Paid ? p.paidOn : o.PaidDate;
        o.PaymentMethod = p.method;
        o.LastModified = now().toISOString();
      });
    },
    anonymiseCustomer(partyId) {
      return run("anonymiseCustomer", { partyId }, () => {
        const party = parties.get(partyId);
        if (!party) throw new IntegrationError({ provider: "billit", operation: "parties.anonymise", retryable: false, statusCode: 404, message: "party not found" });
        Object.assign(party, { Email: null, Phone: null, Mobile: null, anonymised: true });
      });
    },
    failNext(operation, opts) {
      failures.push({ operation, status: opts?.status ?? 500 });
    },
    loseResponseNext() {
      lose += 1;
    },
    markPaid(reference, paidOn, amountCents) {
      const o = [...orders.values()].find((x) => x.OrderNumber === reference);
      if (!o) throw new Error(`fake billit: no order ${reference}`);
      const total = totalCents(o);
      o.paidCents += amountCents ?? total - o.paidCents;
      o.Paid = o.paidCents >= total;
      o.PaidDate = o.Paid ? paidOn : null;
      o.LastModified = now().toISOString();
    },
    setPeppolReachable(vatNumber, reachable) {
      if (reachable) unreachable.delete(vatNumber);
      else unreachable.add(vatNumber);
    },
    snapshot() {
      return {
        parties: [...parties.values()].map((p) => ({ ...p })),
        orders: [...orders.values()].map((o) => ({ ...o, payments: o.payments.map((x) => ({ ...x })) })),
      };
    },
    reset() {
      parties = new Map();
      orders = new Map();
      failures = [];
      unreachable = new Set();
      lose = 0;
      seq = 0;
      calls.length = 0;
    },
  };
  return fake;
}
