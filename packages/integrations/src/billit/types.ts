/**
 * Billit API types (finance spec section 6). Field names follow Billit's REST API v1
 * (`/v1/parties`, `/v1/orders`). finance-P4 owns this folder (cross-module D47): request shapes
 * are plain types, every response is parsed with the Zod schemas below, so an unexpected
 * response is a permanent `IntegrationError` (`invalid_response`) instead of bad data.
 *
 * The response shapes are those of the recorded sandbox fixtures in `client.test.ts`. Billit
 * returns numeric ids; the schemas turn them into strings, so the rest of BEAM (and the fake,
 * which returns `billit_<n>`) only ever sees string ids.
 */
import { z } from "zod";
import type { FetchLike, OnCall } from "../_shared/types";

export type BillitAddress = {
  AddressType: "InvoiceAddress" | "DeliveryAddress";
  Street: string;
  StreetNumber?: string;
  Zipcode: string;
  City: string;
  CountryCode: string;
};

export type BillitPartyInput = {
  /** Set to update an existing party (PATCH); absent to create one (POST). */
  PartyID?: string;
  Name: string;
  PartyType: "Customer";
  VATNumber?: string | null;
  Email?: string | null;
  Phone?: string | null;
  Mobile?: string | null;
  Language?: "NL" | "FR" | "EN";
  Addresses?: BillitAddress[];
  /** Peppol participant id (`0208:0123456789`) when known. */
  PeppolID?: string | null;
  /** Our party key (`person:<uuid>`, `company:<uuid>`, `vat:<number>`, `walk_in`), so a lost response does not create a second party. */
  ExternalProviderID?: string;
};

export type BillitOrderLine = { Description: string; Quantity: number; UnitPriceExcl: number; VATPercentage: number };

export type BillitOrderInput = {
  OrderType: "Invoice" | "CreditNote";
  OrderDirection: "Income";
  OrderNumber: string;
  Reference: string;
  OrderDate: string;
  ExpiryDate?: string;
  Customer: { PartyID: string };
  OrderLines: BillitOrderLine[];
  AboutInvoiceNumber?: string;
  PaymentReference?: string;
  Attachments?: { FileName: string; MimeType: string; FileContent: string }[];
  Paid?: boolean;
  PaidDate?: string;
  PaymentMethod?: string;
  Comments?: string;
};

/**
 * Billit's payment-method codes as recorded from the sandbox (`PaymentMethod` on orders).
 * `billit-mapping.ts` in `@beam/core/finance` maps BEAM's `payment_method` onto these values
 * (`BILLIT_PAYMENT_METHOD`); `billit-jobs.test.ts` asserts both tables agree.
 */
export const BILLIT_PAYMENT_METHOD_CODES = {
  card: "DebitCard",
  cash: "Cash",
  transfer: "BankTransfer",
  voucher: "Voucher",
} as const;
export type BillitPaymentMethodCode = (typeof BILLIT_PAYMENT_METHOD_CODES)[keyof typeof BILLIT_PAYMENT_METHOD_CODES];

/** Billit sends ids as integers; BEAM stores them as text. */
const BillitId = z.union([z.string().min(1), z.number().int()]).transform((v) => String(v));
/** Money in euros with up to two decimals (Billit sends numbers; some list endpoints send strings). */
const Euros = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);
const DateText = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v ? v.slice(0, 10) : null));

/** `GET /v1/orders/{id}` and the items of `GET /v1/orders`. Unknown fields are ignored. */
export const BillitOrderSchema = z
  .object({
    OrderID: BillitId,
    OrderNumber: z.string(),
    OrderType: z.enum(["Invoice", "CreditNote"]),
    Paid: z.boolean().default(false),
    PaidDate: DateText,
    TotalIncl: Euros,
    /** Amount still to be paid, in euros (absent on credit notes in older responses). */
    ToPay: Euros.nullable().optional(),
    /** Billit's `OrderStatus` (`ToSend`, `Sent`, ...); the fake and older fixtures call it `Status`. */
    Status: z.string().optional(),
    OrderStatus: z.string().optional(),
    PeppolStatus: z.string().nullable().optional(),
    LastModified: z.string().optional(),
    Customer: z.object({ PartyID: BillitId }).passthrough().nullable().optional(),
  })
  .transform(({ OrderStatus, Status, Customer, ToPay, ...rest }) => ({
    ...rest,
    Status: Status ?? OrderStatus ?? "Unknown",
    ...(ToPay !== undefined && ToPay !== null ? { ToPay } : {}),
    ...(Customer ? { CustomerPartyID: Customer.PartyID } : {}),
  }));

export type BillitOrder = {
  OrderID: string;
  OrderNumber: string;
  OrderType: "Invoice" | "CreditNote";
  Paid: boolean;
  PaidDate: string | null;
  TotalIncl: number;
  ToPay?: number;
  Status: string;
  PeppolStatus?: string | null;
  LastModified?: string;
  /** The order's customer party, when Billit returns it. */
  CustomerPartyID?: string;
};

/** `GET /v1/orders` (OData list): `Items` plus a `NextPageLink` while more pages exist. */
export const BillitOrderListSchema = z.object({
  Items: z.array(BillitOrderSchema),
  NextPageLink: z.string().nullable().optional(),
});

/** `POST /v1/parties` and `POST /v1/orders` answer with the new id: a bare number or `{ PartyID }` / `{ OrderID }`. */
export const BillitCreatedPartySchema = z.union([BillitId, z.object({ PartyID: BillitId }).transform((o) => o.PartyID)]);
export const BillitCreatedOrderSchema = z.union([BillitId, z.object({ OrderID: BillitId }).transform((o) => o.OrderID)]);

/** Billit's error body (`{ Errors: [{ Code, Description }] }`); only the descriptions are kept, scrubbed. */
export const BillitErrorSchema = z.object({
  Errors: z.array(z.object({ Code: z.string().optional(), Description: z.string().optional() }).passthrough()).optional(),
  Message: z.string().optional(),
});

export interface BillitApi {
  /** POST/PATCH /v1/parties */
  upsertParty(input: BillitPartyInput): Promise<{ partyId: string }>;
  /** POST /v1/orders (OrderType Invoice | CreditNote, OrderDirection Income) */
  createOrder(input: BillitOrderInput): Promise<{ orderId: string }>;
  /** GET /v1/orders?$filter=OrderNumber eq '<number>' */
  findOrderByReference(reference: string): Promise<{ orderId: string } | null>;
  /** GET /v1/orders/{id}: Paid, PaidDate, TotalIncl, Status */
  getOrder(orderId: string): Promise<BillitOrder>;
  listOrdersSince(since: Date, page: number): Promise<{ items: BillitOrder[]; hasMore: boolean }>;
  /** POST /v1/orders/commands/send */
  sendOrder(orderId: string, transport: "Peppol"): Promise<void>;
  /** PATCH /v1/orders/{id}: Paid, PaidDate, PaymentMethod */
  registerPayment(orderId: string, p: { paidOn: string; amountCents: number; method: string; reference: string | null }): Promise<void>;
  /** PATCH /v1/parties/{id}: clears Email, Phone, Mobile, Contacts; keeps Name, Addresses, VATNumber */
  anonymiseCustomer(partyId: string): Promise<void>;
}

export type BillitClientOptions = {
  baseUrl: string;
  apiKey: string;
  /** BEAM's own Billit party id (`BILLIT_PARTY_ID`), sent as the `PartyID` header. */
  partyId: string;
  onCall: OnCall;
  /** Tests inject a fetch; production uses the global one. */
  fetch?: FetchLike;
  /** Per-call timeout (default 20 s). */
  timeoutMs?: number;
};

/** Page size of `listOrdersSince` (`$top`). */
export const BILLIT_PAGE_SIZE = 50;
