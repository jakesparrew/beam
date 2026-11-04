/**
 * The Billit REST client against recorded sandbox responses (finance-P4): request shapes
 * (method, path, headers, OData filters, bodies), Zod parsing of the responses, the error mapping
 * (5xx/429 retryable, 4xx permanent, 401/403 the auth flag) and the call log. No network: a
 * recording `fetch` is injected.
 */
import { describe, expect, it } from "vitest";
import type { IntegrationCallEntry } from "../_shared/types";
import { createBillitClient, isBillitAuthError } from "./client";
import { billitTotalInclCents, createBillitFake } from "./fake";
import type { BillitOrderInput } from "./types";

/** Recorded from the Billit sandbox (ids and names replaced by demo values). */
const FIXTURES = {
  order: {
    OrderID: 418273,
    OrderNumber: "BEAM-2026-000123",
    OrderType: "Invoice",
    OrderDirection: "Income",
    OrderDate: "2026-11-03T00:00:00",
    ExpiryDate: "2026-11-17T00:00:00",
    Paid: true,
    PaidDate: "2026-11-05T00:00:00",
    TotalExcl: 82.64,
    TotalVAT: 17.36,
    TotalIncl: 100.0,
    ToPay: 0,
    OrderStatus: "Sent",
    PeppolStatus: "Delivered",
    LastModified: "2026-11-05T08:12:44.123",
    Customer: { PartyID: 99121, Name: "Acme Wellness BV", VATNumber: "BE0123456749" },
    OrderLines: [{ Description: "10-session card", Quantity: 1, UnitPriceExcl: 82.6446, VATPercentage: 21 }],
  },
  list: (items: unknown[], next: string | null = null) => ({ Items: items, NextPageLink: next }),
  created: 418274,
  partyCreated: 99122,
  error422: { Errors: [{ Code: "InvalidVATNumber", Description: "VAT number BE0000000000 is not valid for billing@example.com" }] },
};

type Recorded = { url: string; method: string; headers: Record<string, string>; body: unknown };

function recorder(responses: (Response | (() => Response))[]) {
  const requests: Recorded[] = [];
  const fetch = (input: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (!next) return Promise.reject(new Error("no recorded response"));
    return Promise.resolve(typeof next === "function" ? next() : next);
  };
  return { fetch, requests };
}

const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(responses: (Response | (() => Response))[], log: IntegrationCallEntry[] = []) {
  const r = recorder(responses);
  const api = createBillitClient({ baseUrl: "https://api.sandbox.billit.be/", apiKey: "sandbox-api-credential", partyId: "4711", onCall: (e) => void log.push(e), fetch: r.fetch });
  return { api, requests: r.requests, log };
}

const ORDER_INPUT: BillitOrderInput = {
  OrderType: "Invoice",
  OrderDirection: "Income",
  OrderNumber: "BEAM-2026-000124",
  Reference: "BEAM-2026-000124",
  OrderDate: "2026-11-04",
  Customer: { PartyID: "99121" },
  OrderLines: [{ Description: "Infrared session", Quantity: 2, UnitPriceExcl: 37.1901, VATPercentage: 21 }],
  Attachments: [{ FileName: "BEAM-2026-000124.pdf", MimeType: "application/pdf", FileContent: "JVBERi0=" }],
};

describe("request shapes and parsing", () => {
  it("getOrder sends ApiKey and PartyID headers and parses the recorded order", async () => {
    const { api, requests, log } = client([json(200, FIXTURES.order)]);
    const order = await api.getOrder("418273");
    expect(requests[0]).toMatchObject({ url: "https://api.sandbox.billit.be/v1/orders/418273", method: "GET" });
    expect(requests[0]!.headers).toMatchObject({ ApiKey: "sandbox-api-credential", PartyID: "4711", Accept: "application/json" });
    expect(order).toEqual({
      OrderID: "418273",
      OrderNumber: "BEAM-2026-000123",
      OrderType: "Invoice",
      Paid: true,
      PaidDate: "2026-11-05",
      TotalIncl: 100,
      ToPay: 0,
      Status: "Sent",
      PeppolStatus: "Delivered",
      LastModified: "2026-11-05T08:12:44.123",
      CustomerPartyID: "99121",
    });
    expect(log).toEqual([{ provider: "billit", operation: "orders.get", requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/), statusCode: 200, ok: true, durationMs: expect.any(Number), error: null }]);
  });

  it("createOrder posts the order body and returns the new id as text", async () => {
    const { api, requests } = client([json(200, FIXTURES.created)]);
    expect(await api.createOrder(ORDER_INPUT)).toEqual({ orderId: "418274" });
    expect(requests[0]).toMatchObject({ url: "https://api.sandbox.billit.be/v1/orders", method: "POST", body: ORDER_INPUT });
    expect(requests[0]!.headers["Content-Type"]).toBe("application/json");
  });

  it("findOrderByReference filters on OrderNumber with OData quoting", async () => {
    const { api, requests } = client([json(200, FIXTURES.list([FIXTURES.order])), json(200, FIXTURES.list([]))]);
    expect(await api.findOrderByReference("BEAM-2026-000123")).toEqual({ orderId: "418273" });
    expect(await api.findOrderByReference("O'Neil")).toBeNull();
    const first = new URL(requests[0]!.url);
    expect(first.pathname).toBe("/v1/orders");
    expect(first.searchParams.get("$filter")).toBe("OrderNumber eq 'BEAM-2026-000123'");
    expect(new URL(requests[1]!.url).searchParams.get("$filter")).toBe("OrderNumber eq 'O''Neil'");
  });

  it("listOrdersSince pages with $skip/$top and reports hasMore from NextPageLink", async () => {
    const { api, requests } = client([json(200, FIXTURES.list([FIXTURES.order], "https://api.sandbox.billit.be/v1/orders?$skip=100")), json(200, FIXTURES.list([]))]);
    const page = await api.listOrdersSince(new Date("2026-10-01T00:00:00Z"), 2);
    expect(page.hasMore).toBe(true);
    expect(page.items.map((o) => o.OrderNumber)).toEqual(["BEAM-2026-000123"]);
    const q = new URL(requests[0]!.url).searchParams;
    expect(q.get("$filter")).toBe("LastModified ge DateTime'2026-10-01T00:00:00' and OrderDirection eq 'Income'");
    expect([q.get("$skip"), q.get("$top")]).toEqual(["100", "50"]);
    expect((await api.listOrdersSince(new Date("2026-10-01T00:00:00Z"), 3)).hasMore).toBe(false);
  });

  it("upsertParty creates with POST and updates with PATCH; sendOrder, registerPayment and anonymiseCustomer send their bodies", async () => {
    const { api, requests } = client([json(200, FIXTURES.partyCreated), json(204, undefined), json(200, undefined), json(204, undefined), json(204, undefined)]);
    expect(await api.upsertParty({ Name: "Acme Wellness BV", PartyType: "Customer", VATNumber: "BE0123456749", ExternalProviderID: "vat:BE0123456749" })).toEqual({ partyId: "99122" });
    expect(await api.upsertParty({ PartyID: "99122", Name: "Acme Wellness BV", PartyType: "Customer" })).toEqual({ partyId: "99122" });
    await api.sendOrder("418273", "Peppol");
    await api.registerPayment("418273", { paidOn: "2026-11-05", amountCents: 10_000, method: "BankTransfer", reference: "+++260/0000/12395+++" });
    await api.anonymiseCustomer("99121");
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "POST /v1/parties",
      "PATCH /v1/parties/99122",
      "POST /v1/orders/commands/send",
      "PATCH /v1/orders/418273",
      "PATCH /v1/parties/99121",
    ]);
    expect(requests[0]!.body).toEqual({ Name: "Acme Wellness BV", PartyType: "Customer", VATNumber: "BE0123456749", ExternalProviderID: "vat:BE0123456749" });
    expect(requests[1]!.body).not.toHaveProperty("PartyID");
    expect(requests[2]!.body).toEqual({ Transporttype: "Peppol", OrderIDs: [418273] });
    expect(requests[3]!.body).toEqual({ Paid: true, PaidDate: "2026-11-05", PaymentMethod: "BankTransfer", PaymentReference: "+++260/0000/12395+++" });
    expect(requests[4]!.body).toEqual({ Email: null, Phone: null, Mobile: null, Contacts: [] });
  });

  it("an unexpected response is a permanent invalid_response error", async () => {
    const { api } = client([json(200, { OrderNumber: 12 }), new Response("<html>", { status: 200 })]);
    await expect(api.getOrder("1")).rejects.toMatchObject({ provider: "billit", retryable: false, code: "invalid_response" });
    await expect(api.getOrder("1")).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("error mapping", () => {
  it("5xx and 429 are retryable; network errors are retryable", async () => {
    const { api, log } = client([json(503, { Message: "maintenance" }), json(429, {}), () => {
      throw new TypeError("fetch failed");
    }]);
    await expect(api.getOrder("1")).rejects.toMatchObject({ retryable: true, statusCode: 503 });
    await expect(api.createOrder(ORDER_INPUT)).rejects.toMatchObject({ retryable: true, statusCode: 429 });
    await expect(api.getOrder("1")).rejects.toMatchObject({ retryable: true, code: "network" });
    expect(log.map((e) => [e.operation, e.ok, e.statusCode])).toEqual([
      ["orders.get", false, 503],
      ["orders.create", false, 429],
      ["orders.get", false, null],
    ]);
  });

  it("4xx is permanent and carries Billit's scrubbed validation message", async () => {
    const { api, log } = client([json(422, FIXTURES.error422), json(404, {})]);
    const err = await api.createOrder(ORDER_INPUT).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: false, statusCode: 422 });
    expect((err as Error).message).toContain("VAT number BE0000000000 is not valid for [email]");
    expect(isBillitAuthError(err)).toBe(false);
    await expect(api.getOrder("x")).rejects.toMatchObject({ retryable: false, statusCode: 404 });
    expect(log[0]!.error).not.toContain("billing@example.com");
  });

  it("401 and 403 are permanent and flagged as credential failures", async () => {
    const { api } = client([json(401, {}), json(403, {})]);
    const a = await api.getOrder("1").catch((e: unknown) => e);
    const b = await api.sendOrder("1", "Peppol").catch((e: unknown) => e);
    for (const e of [a, b]) {
      expect(e).toMatchObject({ retryable: false, code: "auth" });
      expect(isBillitAuthError(e)).toBe(true);
    }
    expect(JSON.stringify(a)).not.toContain("sandbox-api-credential");
  });
});

describe("fake", () => {
  it("follows the client contract: auth flag on 401, ToPay on partial payment, recorded payments", async () => {
    const fake = createBillitFake();
    fake.failNext("getOrder", { status: 401 });
    expect(isBillitAuthError(await fake.getOrder("x").catch((e: unknown) => e))).toBe(true);
    const { orderId } = await fake.createOrder({ ...ORDER_INPUT, OrderLines: [{ Description: "x", Quantity: 1, UnitPriceExcl: 82.6446, VATPercentage: 21 }] });
    fake.markPaid(ORDER_INPUT.OrderNumber, "2026-11-05", 4_000);
    expect(await fake.getOrder(orderId)).toMatchObject({ Paid: false, TotalIncl: 100, ToPay: 60, CustomerPartyID: "99121" });
    await fake.registerPayment(orderId, { paidOn: "2026-11-06", amountCents: 10_000, method: "BankTransfer", reference: null });
    expect(fake.snapshot().orders[0]).toMatchObject({ Paid: true, PaidDate: "2026-11-06", PaymentMethod: "BankTransfer", payments: [{ amountCents: 10_000 }] });
  });

  it("totals round per line like Billit", () => {
    expect(billitTotalInclCents([{ Description: "a", Quantity: 1, UnitPriceExcl: 8.2645, VATPercentage: 21 }, { Description: "b", Quantity: 3, UnitPriceExcl: 4.717, VATPercentage: 6 }])).toBe(1000 + 1500);
  });
});
