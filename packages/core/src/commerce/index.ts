/**
 * `@beam/core/commerce`: commerce's pure core (spec section 4.1). Pricing, VAT, the state
 * machines of section 3.1, refund and withdrawal plans, voucher codes, order references and
 * the Zod schemas (`CartItem`, `CommerceSettings`).
 *
 * The Wave 0 contract types of `./types.ts` are re-exported except the four that section 4.1
 * replaces (`CartItem`, `Quote`, `QuoteLine`, `QuoteInput`), which come from `./schemas.ts`.
 */
export type {
  Audience,
  CreditKind,
  OrderChannel,
  OrderStatus,
  OrderSummary,
  PaymentAttentionItem,
  ProductCard,
  ProductKind,
} from "./types";

export * from "./schemas";
export * from "./vat";
export * from "./pricing";
export * from "./state-machine";
export * from "./refunds";
export * from "./vouchers";
export * from "./references";
