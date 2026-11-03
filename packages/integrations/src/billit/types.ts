/**
 * Billit API types (finance spec section 6). Field names follow Billit's REST API. Wave 0
 * (platform-P3) ships these with the fake; finance-P4 takes the folder over and refines the
 * Zod schemas against recorded sandbox responses.
 */
import { z } from "zod";
import type { OnCall } from "../_shared/types";

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
  /** Our person or company id, so a lost response does not create a second party. */
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

export const BillitOrderSchema = z.object({
  OrderID: z.string(),
  OrderNumber: z.string(),
  OrderType: z.enum(["Invoice", "CreditNote"]),
  Paid: z.boolean(),
  PaidDate: z.string().nullable(),
  TotalIncl: z.number(),
  Status: z.string(),
  PeppolStatus: z.string().nullable().optional(),
  LastModified: z.string().optional(),
});

export type BillitOrder = z.infer<typeof BillitOrderSchema>;

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

export type BillitClientOptions = { baseUrl: string; apiKey: string; partyId: string; onCall: OnCall };
