/**
 * finance types named in the cross-module contract (02-data-model sections 6.6 and 1.2.6).
 * Wave 0 skeleton by platform-P7; finance owns this file from finance-P1 on.
 */
export type Address = { street: string; postalCode: string; city: string; country: string };

/** `BillingDetailsInput` (finance rule 17), reused by commerce's checkout form. */
export type BillingDetails = {
  isCompany: boolean;
  legalName: string;
  vatNumber?: string;
  address: Address;
  billingEmail?: string;
  purchaseOrderRef?: string;
  peppolId?: string;
};

export type InvoiceSummary = {
  id: string;
  kind: "invoice" | "credit_note";
  number: string;
  issuedOn: string;
  status: "issued" | "paid" | "open" | "cancelled";
  totalCents: number;
  isCompany: boolean;
  pdfReady: boolean;
};

/** R4 KPIs for ops dashboards, weekly summary and NL questions. */
export type FinanceKpis = {
  from: string;
  to: string;
  invoicedCents: number;
  creditedCents: number;
  netRevenueCents: number;
  vatCents: number;
  openCents: number;
  overdueCents: number;
  invoices: number;
  creditNotes: number;
};
