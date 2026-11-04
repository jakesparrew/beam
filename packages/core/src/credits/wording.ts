/**
 * Catalogue keys for how units are shown (credits rule 36, decision 25, spec section 8). The
 * portal never says "credits": a day unit is a session, a night unit a night, euro is money.
 * Pure: callers render the key with `t()` and the count or amount.
 */
import type { CreditKind } from "./types";
import type { GrantSource } from "./vat";

export type UnitsLabelKey = "credits.units.day" | "credits.units.night" | "credits.units.euro";

/** `credits.units.day` ("{count} sessions remaining"), `.night` ("{count} nights remaining"), `.euro` ("{amount} remaining"). */
export function unitsLabelKey(kind: CreditKind): UnitsLabelKey {
  return `credits.units.${kind}`;
}

/** The values for `unitsLabelKey`: `{ count }` for day and night, `{ amountCents }` for euro (format it with `formatMoney`). */
export function unitsLabelValues(kind: CreditKind, remaining: number): { count: number } | { amountCents: number } {
  return kind === "euro" ? { amountCents: remaining } : { count: remaining };
}

export type GrantLabelKey = "credits.labels.voucher" | "credits.labels.import" | "credits.labels.referral_reward" | "credits.labels.transfer";

/**
 * The catalogue label of a grant shown without a product name: vouchers "Gift voucher", imports
 * "Package from previous system", referral rewards "Thank-you session", transfers "Received from
 * {name}". `null` means: show the product name or the grant's own `label`.
 */
export function grantLabelKey(source: GrantSource): GrantLabelKey | null {
  switch (source) {
    case "voucher":
      return "credits.labels.voucher";
    case "import":
      return "credits.labels.import";
    case "referral":
      return "credits.labels.referral_reward";
    case "transfer":
      return "credits.labels.transfer";
    default:
      return null;
  }
}

export type CreditsEnumGroup = "kind" | "grant_status" | "source" | "entry_kind" | "membership_status" | "end_reason" | "benefit_kind";

/** Catalogue key of an enum value, e.g. `credits.enum.grant_status.active` (section 8). */
export function enumLabelKey(group: CreditsEnumGroup, value: string): string {
  return `credits.enum.${group}.${value}`;
}
