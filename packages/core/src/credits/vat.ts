/**
 * VAT treatment of a grant (credits rules 4, 6, 20a, 46, 64 to 66, proposal question 7).
 * Pure: the ledger stores the result in `credit_grants.vat_treatment` at grant time.
 */
import type { CreditKind } from "./types";

export type VatTreatment = "single_purpose" | "multi_purpose" | "not_applicable";
export type GrantSource = "purchase" | "voucher" | "membership" | "bonus" | "import" | "manual" | "referral" | "transfer";

/**
 * - `purchase` (day, night) and `import` of day or night: `single_purpose` (VAT at sale, none at use).
 * - `voucher` (euro) and `import` of a legacy euro voucher: `multi_purpose` (VAT on what it buys).
 * - `manual` euro restoring a partial `credit_balance` refund (`refundId` set): `multi_purpose`.
 * - `bonus`, `referral`, `membership` and any other `manual`: `not_applicable` (no money received).
 * - `transfer`: the treatment of the source grant.
 * A combination the schema forbids (euro purchase, day or night voucher) throws a `RangeError`.
 */
export function vatTreatmentFor(i: {
  source: GrantSource;
  kind: CreditKind;
  refundId?: string | null;
  transferFromTreatment?: VatTreatment;
}): VatTreatment {
  switch (i.source) {
    case "purchase":
      if (i.kind === "euro") throw new RangeError("a purchase grant is day or night");
      return "single_purpose";
    case "voucher":
      if (i.kind !== "euro") throw new RangeError("a voucher grant is euro");
      return "multi_purpose";
    case "import":
      return i.kind === "euro" ? "multi_purpose" : "single_purpose";
    case "manual":
      return i.kind === "euro" && i.refundId ? "multi_purpose" : "not_applicable";
    case "transfer":
      if (!i.transferFromTreatment) throw new RangeError("a transfer takes the source grant's treatment");
      return i.transferFromTreatment;
    case "bonus":
    case "referral":
    case "membership":
      return "not_applicable";
  }
}

/**
 * `unit_value_cents` of a new grant: a euro unit is one cent of face value; staff, inclusion and
 * reward day/night units are worth 0; purchases, imports and transfers keep the value passed.
 */
export function unitValueFor(i: { source: GrantSource; kind: CreditKind; unitValueCents?: number | null }): number {
  if (i.kind === "euro") return 1;
  if (i.source === "bonus" || i.source === "manual" || i.source === "membership" || i.source === "referral") return 0;
  return i.unitValueCents ?? 0;
}

/** True when spending the grant creates VAT on the order lines it pays (`data.vat_at_redemption`). */
export function vatAtRedemption(kind: CreditKind): boolean {
  return kind === "euro";
}
