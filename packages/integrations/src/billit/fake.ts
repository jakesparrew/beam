/**
 * The Billit fake (runbook section 1.5, finance spec section 6): accepts parties, invoices and
 * credit notes, returns `billit_<n>` ids, marks bank-transfer invoices paid on `markPaid`,
 * simulates Peppol status `sent`. finance-P4 extends it and keeps this name and constructor.
 */
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type FakeCall, type OnCall } from "../_shared/types";
import type { BillitApi, BillitOrder, BillitOrderInput, BillitPartyInput } from "./types";

type FakeOrder = BillitOrder & { input: BillitOrderInput; paidCents: number; createdAt: Date };
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

function totalInclCents(lines: BillitOrderInput["OrderLines"]): number {
  return Math.round(lines.reduce((sum, l) => sum + l.Quantity * l.UnitPriceExcl * (1 + l.VATPercentage / 100), 0) * 100);
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

  function run<T>(operation: keyof BillitApi, input: unknown, work: () => T): Promise<T> {
    calls.push({ operation, input, at: now() });
    return trackCall(onCall, { provider: "billit", operation: `billit.${operation}`, requestDigest: digestRequest({ method: "POST", path: `/v1/${operation}` }) }, () => {
      const index = failures.findIndex((f) => f.operation === null || f.operation === operation);
      if (index >= 0) {
        const [failure] = failures.splice(index, 1);
        throw errorFromStatus("billit", operation, failure!.status);
      }
      return { value: work(), statusCode: 200 };
    });
  }

  const order = (orderId: string): FakeOrder => {
    const o = orders.get(orderId);
    if (!o) throw new IntegrationError({ provider: "billit", operation: "getOrder", retryable: false, statusCode: 404, message: `order ${orderId} not found` });
    return o;
  };
  const publicOrder = (o: FakeOrder): BillitOrder => {
    const { input: _input, paidCents: _paid, createdAt: _at, ...rest } = o;
    return { ...rest };
  };

  const fake: BillitFake = {
    calls,
    upsertParty(input) {
      return run("upsertParty", { PartyID: input.PartyID ?? null }, () => {
        const existing =
          (input.PartyID && parties.get(input.PartyID)) ||
          (input.ExternalProviderID ? [...parties.values()].find((p) => p.ExternalProviderID === input.ExternalProviderID) : undefined);
        const partyId = existing?.PartyID ?? `billit_${++seq}`;
        parties.set(partyId, { ...existing, ...input, PartyID: partyId, anonymised: existing?.anonymised ?? false });
        return { partyId };
      });
    },
    async createOrder(input) {
      const result = await run("createOrder", { OrderNumber: input.OrderNumber }, () => {
        const found = [...orders.values()].find((o) => o.OrderNumber === input.OrderNumber);
        if (found) {
          throw new IntegrationError({ provider: "billit", operation: "createOrder", retryable: false, statusCode: 422, message: `OrderNumber ${input.OrderNumber} already exists` });
        }
        const orderId = `billit_${++seq}`;
        const total = totalInclCents(input.OrderLines);
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
        });
        return { orderId };
      });
      if (lose > 0) {
        lose -= 1;
        throw new IntegrationError({ provider: "billit", operation: "createOrder", retryable: true, code: "timeout", message: "billit createOrder timed out" });
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
          throw new IntegrationError({ provider: "billit", operation: "sendOrder", retryable: false, statusCode: 422, message: "receiver not found on Peppol" });
        }
        o.Status = "Sent";
        o.PeppolStatus = "sent";
        o.LastModified = now().toISOString();
      });
    },
    registerPayment(orderId, p) {
      return run("registerPayment", { orderId }, () => {
        const o = order(orderId);
        o.paidCents = Math.max(o.paidCents, p.amountCents);
        o.Paid = o.paidCents >= Math.round(o.TotalIncl * 100);
        o.PaidDate = o.Paid ? p.paidOn : o.PaidDate;
        o.LastModified = now().toISOString();
      });
    },
    anonymiseCustomer(partyId) {
      return run("anonymiseCustomer", { partyId }, () => {
        const party = parties.get(partyId);
        if (!party) throw new IntegrationError({ provider: "billit", operation: "anonymiseCustomer", retryable: false, statusCode: 404, message: "party not found" });
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
      const total = Math.round(o.TotalIncl * 100);
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
      return { parties: [...parties.values()].map((p) => ({ ...p })), orders: [...orders.values()].map((o) => ({ ...o })) };
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
