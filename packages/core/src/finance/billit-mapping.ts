/**
 * Billit mapping (finance spec section 6, rules 8a, 30, 30a; finance-P4). Pure: an issued
 * document and its customer snapshot become Billit's order and party payloads, so Billit's
 * totals equal ours to the cent.
 *
 * - Lines go to Billit with their own VAT rate. `UnitPriceExcl` is derived from the line's gross
 *   (VAT included, after discount) with 4 decimals: `gross / (1 + rate) / quantity`. Billit
 *   computes `Quantity x UnitPriceExcl x (1 + rate)` per line, rounded to the cent, which gives
 *   back exactly our gross (`billitOrderTotalCents`), so `TotalIncl = total_cents`.
 * - Credit notes are `OrderType = CreditNote` with positive quantities and amounts (Billit's sign
 *   convention) and `AboutInvoiceNumber` = the original's number.
 * - Euro credit (`credit_balance`) is a means of payment, never a discount or a negative line:
 *   a paid document is created with `Paid = true`, `PaidDate` and the method from
 *   `BILLIT_PAYMENT_METHOD` (`voucher` -> Billit's voucher code, `mixed` -> the method of the
 *   largest non-euro-credit payment), and `Comments` lists the split per provider.
 *
 * The payload types mirror `@beam/integrations/billit` (`BillitOrderInput`, `BillitPartyInput`);
 * `@beam/core` cannot import the integrations package (it depends on core), so they are declared
 * here structurally and checked against the client's types where the finance jobs pass them on.
 */
import { brusselsDateOf } from "./numbering";
import { isAnonymisedSnapshot } from "./snapshot";
import type { CustomerSnapshot, InvoiceLine, InvoicePaymentMethod, InvoiceRecord } from "./types";

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

export type BillitPartyInput = {
  PartyID?: string;
  Name: string;
  PartyType: "Customer";
  VATNumber?: string | null;
  Email?: string | null;
  Phone?: string | null;
  Mobile?: string | null;
  Addresses?: { AddressType: "InvoiceAddress" | "DeliveryAddress"; Street: string; StreetNumber?: string; Zipcode: string; City: string; CountryCode: string }[];
  PeppolID?: string | null;
  ExternalProviderID?: string;
};

/** Billit's payment-method codes (recorded from the sandbox; same values as `BILLIT_PAYMENT_METHOD_CODES` in `@beam/integrations/billit`). */
export const BILLIT_PAYMENT_METHOD_CODES = {
  card: "DebitCard",
  cash: "Cash",
  transfer: "BankTransfer",
  voucher: "Voucher",
} as const;

/** BEAM `payment_method` -> Billit code. `mixed` resolves to the largest non-euro-credit payment (`billitPaymentMethod`). */
export const BILLIT_PAYMENT_METHOD: Readonly<Record<Exclude<InvoicePaymentMethod, "mixed">, string>> = {
  bancontact: BILLIT_PAYMENT_METHOD_CODES.card,
  creditcard: BILLIT_PAYMENT_METHOD_CODES.card,
  terminal: BILLIT_PAYMENT_METHOD_CODES.card,
  cash: BILLIT_PAYMENT_METHOD_CODES.cash,
  bank_transfer: BILLIT_PAYMENT_METHOD_CODES.transfer,
  voucher: BILLIT_PAYMENT_METHOD_CODES.voucher,
};

/** One paid `payments` row of the document's order, as the mapping needs it. */
export type BillitPaymentPart = { provider: string; method: string | null; amountCents: number };

/** BEAM's `payment_method` of one payment (the same rule as the invoice snapshot, finance 2.2). */
export function paymentMethodOfPart(p: Pick<BillitPaymentPart, "provider" | "method">): string | null {
  switch (p.provider) {
    case "credit_balance":
      return "voucher";
    case "cash":
    case "terminal":
    case "bank_transfer":
      return p.provider;
    default: {
      const m = p.method?.trim().toLowerCase();
      if (!m) return null;
      return m === "card" || m === "credit_card" ? "creditcard" : m;
    }
  }
}

const codeOf = (method: string): string =>
  (BILLIT_PAYMENT_METHOD as Record<string, string | undefined>)[method] ?? BILLIT_PAYMENT_METHOD_CODES.card; // other online methods (ideal, paypal, ...) are card-like

/**
 * The Billit payment-method code for a document's `payment_method`. `mixed` takes the largest
 * payment that is not euro credit (`voucher` when there is none); `null` stays `null`.
 */
export function billitPaymentMethod(paymentMethod: string | null, payments: readonly BillitPaymentPart[] = []): string | null {
  if (!paymentMethod) return null;
  if (paymentMethod !== "mixed") return codeOf(paymentMethod);
  const main = [...payments].filter((p) => p.provider !== "credit_balance").sort((a, b) => b.amountCents - a.amountCents)[0];
  const method = main ? paymentMethodOfPart(main) : "voucher";
  return codeOf(method ?? "creditcard");
}

const SPLIT_LABEL: Readonly<Record<string, string>> = {
  voucher: "Euro credit",
  bancontact: "Bancontact",
  creditcard: "Credit card",
  terminal: "Terminal",
  cash: "Cash",
  bank_transfer: "Bank transfer",
};

const euros = (cents: number) => `${(Math.abs(cents) / 100).toFixed(2)} EUR`;

/**
 * `Comments` of a paid document settled with euro credit or several payments (rule 8a), for
 * example `Euro credit 30.00 EUR; Bancontact 70.00 EUR` (euro credit first, then by amount).
 * Accounting text in Billit, not customer-facing copy, so it is not localised. `null` for a
 * single non-credit payment.
 */
export function paymentSplitComment(payments: readonly BillitPaymentPart[]): string | null {
  if (payments.length === 0) return null;
  if (payments.length === 1 && payments[0]!.provider !== "credit_balance") return null;
  const ordered = [...payments].sort((a, b) => {
    const ca = a.provider === "credit_balance" ? 0 : 1;
    const cb = b.provider === "credit_balance" ? 0 : 1;
    return ca - cb || b.amountCents - a.amountCents;
  });
  return ordered
    .map((p) => {
      const method = paymentMethodOfPart(p);
      const label = (method && SPLIT_LABEL[method]) ?? (method ? method.charAt(0).toUpperCase() + method.slice(1) : p.provider);
      return `${label} ${euros(p.amountCents)}`;
    })
    .join("; ");
}

/** `UnitPriceExcl` with 4 decimals from a line's gross, rate and quantity (signs dropped). */
export function unitPriceExcl(lineTotalCents: number, quantity: number, ratePct: number): number {
  const q = Math.abs(quantity) || 1;
  const value = Math.abs(lineTotalCents) / 100 / (1 + ratePct / 100) / q;
  return Math.round(value * 10_000) / 10_000;
}

/** Billit's order lines of a document: positive quantities, unit price excl. VAT, own rate per line. */
export function toBillitOrderLines(lines: readonly InvoiceLine[]): BillitOrderLine[] {
  return lines.map((l) => ({
    Description: l.discount_label ? `${l.description} (${l.discount_label})` : l.description,
    Quantity: Math.abs(l.quantity) || 1,
    UnitPriceExcl: unitPriceExcl(l.line_total_cents, l.quantity, l.vat_rate_pct),
    VATPercentage: l.vat_rate_pct,
  }));
}

/** The total Billit computes for these lines, in cents (per line rounded, summed). */
export function billitOrderTotalCents(lines: readonly BillitOrderLine[]): number {
  return lines.reduce((sum, l) => sum + Math.round(l.Quantity * l.UnitPriceExcl * (100 + l.VATPercentage)), 0);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export type ToBillitOrderOptions = {
  /** The original invoice's number (credit notes: `AboutInvoiceNumber`). */
  originalNumber?: string;
  /** The order's paid payments (rule 8a: `mixed` method and the split comment). */
  payments?: readonly BillitPaymentPart[];
};

/** The Billit order of an issued document (section 6): our number is order number and reference. */
export function toBillitOrder(invoice: InvoiceRecord, partyId: string, pdf?: Uint8Array, opts: ToBillitOrderOptions = {}): BillitOrderInput {
  const input: BillitOrderInput = {
    OrderType: invoice.kind === "credit_note" ? "CreditNote" : "Invoice",
    OrderDirection: "Income",
    OrderNumber: invoice.number,
    Reference: invoice.number,
    OrderDate: invoice.issuedOn,
    Customer: { PartyID: partyId },
    OrderLines: toBillitOrderLines(invoice.lines),
  };
  if (invoice.dueOn) input.ExpiryDate = invoice.dueOn;
  if (invoice.kind === "credit_note" && opts.originalNumber) input.AboutInvoiceNumber = opts.originalNumber;
  if (invoice.paymentReference) input.PaymentReference = invoice.paymentReference;
  if (pdf) input.Attachments = [{ FileName: `${invoice.number}.pdf`, MimeType: "application/pdf", FileContent: base64(pdf) }];
  if (invoice.status === "paid") {
    input.Paid = true;
    input.PaidDate = brusselsDateOf(invoice.paidAt ?? invoice.issuedAt);
    const method = billitPaymentMethod(invoice.paymentMethod, opts.payments ?? []);
    if (method) input.PaymentMethod = method;
    const comment = paymentSplitComment(opts.payments ?? []);
    if (comment) input.Comments = comment;
  }
  return input;
}

/** `registerPayment` of a document settled in BEAM after its push (rule 30a). */
export function toBillitPayment(
  invoice: InvoiceRecord,
  payments: readonly BillitPaymentPart[] = [],
): { paidOn: string; amountCents: number; method: string; reference: string | null } {
  return {
    paidOn: brusselsDateOf(invoice.paidAt ?? invoice.issuedAt),
    amountCents: Math.abs(invoice.totalCents),
    method: billitPaymentMethod(invoice.paymentMethod, payments) ?? BILLIT_PAYMENT_METHOD_CODES.transfer,
    reference: invoice.paymentTransactionRef ?? invoice.paymentReference ?? null,
  };
}

/**
 * Billit's party for a customer snapshot. Email and phone are always present (null when the
 * snapshot has none), so a reduced snapshot after erasure clears them in Billit and hashes
 * differently from the full one. The anonymised form of the retention sweep keeps no name.
 */
export function toBillitParty(snapshot: CustomerSnapshot): BillitPartyInput {
  if (isAnonymisedSnapshot(snapshot)) return { Name: "Anonymised customer", PartyType: "Customer", Email: null, Phone: null, Mobile: null, VATNumber: null };
  const a = snapshot.address;
  return {
    Name: snapshot.name,
    PartyType: "Customer",
    VATNumber: snapshot.vat_number,
    Email: snapshot.email,
    Phone: snapshot.phone,
    Mobile: null,
    PeppolID: snapshot.peppol_id,
    ...(a
      ? { Addresses: [{ AddressType: "InvoiceAddress" as const, Street: a.line2 ? `${a.line1}, ${a.line2}` : a.line1, Zipcode: a.postal_code, City: a.city, CountryCode: a.country }] }
      : {}),
  };
}

/**
 * `billit_parties.party_key` of a document (section 2.6): the CRM company, else a company
 * snapshot's VAT number, else the person, else `walk_in` for an anonymous POS sale. `null` when
 * the document carries no identity any more (erased or anonymised without a VAT number).
 */
export function billitPartyKey(doc: Pick<InvoiceRecord, "personId" | "companyId" | "customerSnapshot">): string | null {
  const s = doc.customerSnapshot;
  if (isAnonymisedSnapshot(s)) return null;
  if (s.kind === "walk_in") return "walk_in";
  if (doc.companyId) return `company:${doc.companyId}`;
  if (s.kind === "company" && s.vat_number) return `vat:${s.vat_number.replace(/[^0-9A-Z+*]/gi, "").toUpperCase()}`;
  if (doc.personId) return `person:${doc.personId}`;
  return null;
}
