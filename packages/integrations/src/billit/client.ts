/**
 * The Billit REST client (finance spec section 6, finance-P4; cross-module D47 hands the folder
 * from platform-P3's stub to finance). Billit authenticates with the `ApiKey` header and acts
 * for BEAM's own party (`PartyID` header). Every call goes through `trackCall`, so `onCall`
 * receives operation, request digest, status and duration (never bodies) for `integration_calls`.
 *
 * Failure mapping (`IntegrationError { provider: 'billit' }`): 5xx, 408, 425, 429, timeouts and
 * network errors are retryable; 400, 404, 409 and 422 are permanent and carry Billit's (scrubbed)
 * validation message; 401 and 403 are permanent with `code = 'auth'` (`isBillitAuthError`), which
 * the finance jobs turn into one High "Billit credentials rejected" alert. A response that does
 * not match the Zod schemas of `types.ts` is permanent (`code = 'invalid_response'`).
 */
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError, scrubError } from "../_shared/errors";
import { trackCall, withTimeout } from "../_shared/timeout";
import type { FetchLike } from "../_shared/types";
import {
  BILLIT_PAGE_SIZE,
  BillitCreatedOrderSchema,
  BillitCreatedPartySchema,
  BillitErrorSchema,
  BillitOrderListSchema,
  BillitOrderSchema,
  type BillitApi,
  type BillitClientOptions,
  type BillitOrder,
} from "./types";

type Method = "GET" | "POST" | "PATCH";
type Request = { operation: string; method: Method; path: string; query?: Record<string, string>; body?: unknown };
type ZodLike<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

/** True for the permanent 401/403 failure that means BEAM's Billit key or party id is wrong. */
export function isBillitAuthError(error: unknown): boolean {
  return error instanceof IntegrationError && error.provider === "billit" && error.code === "auth";
}

/** Billit's validation message from an error body, scrubbed, or null. */
function errorDetail(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = BillitErrorSchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      const parts = [...(parsed.data.Errors ?? []).map((e) => e.Description ?? e.Code ?? ""), parsed.data.Message ?? ""].filter(Boolean);
      if (parts.length) return scrubError(parts.join("; ")).slice(0, 300);
    }
  } catch {
    // not JSON: fall through to the raw text
  }
  return scrubError(text).slice(0, 300);
}

/** The `IntegrationError` for a failed Billit HTTP status (shared with the fake, so `failNext({ status: 401 })` behaves like the client). */
export function billitError(operation: string, status: number, detail?: string): IntegrationError {
  if (status === 401 || status === 403) {
    return new IntegrationError({
      provider: "billit",
      operation,
      statusCode: status,
      retryable: false,
      code: "auth",
      message: `billit ${operation} failed with ${status}: credentials rejected`,
    });
  }
  return errorFromStatus("billit", operation, status, detail);
}

const invalid = (operation: string, status: number) =>
  new IntegrationError({ provider: "billit", operation, retryable: false, statusCode: status, code: "invalid_response", message: `billit ${operation}: unexpected response` });

/** `2026-11-04T10:00:00.000Z` -> `DateTime'2026-11-04T10:00:00'` (OData filter literal). */
const odataDateTime = (d: Date) => `DateTime'${d.toISOString().slice(0, 19)}'`;
/** Single quotes doubled inside an OData string literal. */
const odataString = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function createBillitClient(opts: BillitClientOptions): BillitApi {
  const base = opts.baseUrl.replace(/\/$/, "");
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 20_000;

  async function call<T>(req: Request, parse: ZodLike<T> | null): Promise<T> {
    const digest = digestRequest({ method: req.method, path: req.path, params: req.query ?? {} });
    return trackCall(opts.onCall, { provider: "billit", operation: req.operation, requestDigest: digest }, () =>
      withTimeout(
        async (signal) => {
          const qs = req.query ? `?${new URLSearchParams(req.query).toString()}` : "";
          const headers: Record<string, string> = { ApiKey: opts.apiKey, PartyID: opts.partyId, Accept: "application/json" };
          if (req.body !== undefined) headers["Content-Type"] = "application/json";
          const res = await doFetch(`${base}${req.path}${qs}`, {
            method: req.method,
            headers,
            ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
            signal,
          });
          const text = await res.text().catch(() => "");
          if (!res.ok) throw billitError(req.operation, res.status, errorDetail(text));
          if (!parse) return { value: undefined as T, statusCode: res.status };
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            throw invalid(req.operation, res.status);
          }
          const parsed = parse.safeParse(json);
          if (!parsed.success) throw invalid(req.operation, res.status);
          return { value: parsed.data, statusCode: res.status };
        },
        timeoutMs,
        { provider: "billit", operation: req.operation },
      ),
    );
  }

  const listOrders = (operation: string, query: Record<string, string>) => call({ operation, method: "GET", path: "/v1/orders", query }, BillitOrderListSchema);

  return {
    async upsertParty(input) {
      const { PartyID, ...body } = input;
      if (PartyID) {
        await call({ operation: "parties.update", method: "PATCH", path: `/v1/parties/${encodeURIComponent(PartyID)}`, body }, null);
        return { partyId: PartyID };
      }
      const partyId = await call({ operation: "parties.create", method: "POST", path: "/v1/parties", body }, BillitCreatedPartySchema);
      return { partyId };
    },

    async createOrder(input) {
      const orderId = await call({ operation: "orders.create", method: "POST", path: "/v1/orders", body: input }, BillitCreatedOrderSchema);
      return { orderId };
    },

    async findOrderByReference(reference) {
      const page = await listOrders("orders.find", { $filter: `OrderNumber eq ${odataString(reference)}`, $top: "1" });
      const hit = page.Items.find((o) => o.OrderNumber === reference);
      return hit ? { orderId: hit.OrderID } : null;
    },

    async getOrder(orderId): Promise<BillitOrder> {
      return call({ operation: "orders.get", method: "GET", path: `/v1/orders/${encodeURIComponent(orderId)}` }, BillitOrderSchema);
    },

    async listOrdersSince(since, page) {
      const result = await listOrders("orders.list", {
        $filter: `LastModified ge ${odataDateTime(since)} and OrderDirection eq 'Income'`,
        $orderby: "OrderID",
        $skip: String(Math.max(0, page) * BILLIT_PAGE_SIZE),
        $top: String(BILLIT_PAGE_SIZE),
      });
      return { items: result.Items, hasMore: !!result.NextPageLink || result.Items.length >= BILLIT_PAGE_SIZE };
    },

    async sendOrder(orderId, transport) {
      await call({ operation: "orders.send", method: "POST", path: "/v1/orders/commands/send", body: { Transporttype: transport, OrderIDs: [Number.isNaN(Number(orderId)) ? orderId : Number(orderId)] } }, null);
    },

    async registerPayment(orderId, p) {
      const body: Record<string, unknown> = { Paid: true, PaidDate: p.paidOn, PaymentMethod: p.method };
      if (p.reference) body.PaymentReference = p.reference;
      await call({ operation: "orders.register_payment", method: "PATCH", path: `/v1/orders/${encodeURIComponent(orderId)}`, body }, null);
    },

    async anonymiseCustomer(partyId) {
      await call(
        { operation: "parties.anonymise", method: "PATCH", path: `/v1/parties/${encodeURIComponent(partyId)}`, body: { Email: null, Phone: null, Mobile: null, Contacts: [] } },
        null,
      );
    },
  };
}
