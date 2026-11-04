/**
 * `BillingDetailsInput` (finance spec 4.1, rule 17): the company-invoice fields of commerce's
 * checkout and POS, finance's reissue dialog and the portal request form. A company invoice
 * needs a legal name, an address and a valid VAT number; the VAT number is stored normalised
 * (`BE0123456749`). Messages are `finance.billing.*` catalogue keys.
 */
import { z } from "zod";
import { AddressSchema, type Address } from "./types";
import { normaliseVatNumber, peppolIdFromVatNumber } from "./vat-number";

export const BILLING_MESSAGES = {
  vatRequired: "finance.billing.vat_number_required",
  vatFormat: "finance.billing.vat_number_format",
  vatChecksum: "finance.billing.vat_number_checksum",
} as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const BillingDetailsInput = z
  .object({
    isCompany: z.boolean(),
    legalName: z.string().trim().min(2).max(200),
    vatNumber: optionalText(30),
    address: AddressSchema,
    billingEmail: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v.toLowerCase() : undefined))
      .pipe(z.string().email().max(254).optional()),
    purchaseOrderRef: optionalText(50),
    peppolId: optionalText(60).pipe(
      z
        .string()
        .regex(/^\d{4}:[0-9A-Za-z.\-_]{1,50}$/)
        .optional(),
    ),
  })
  .transform((value, ctx) => {
    if (value.isCompany && !value.vatNumber) {
      ctx.addIssue({ code: "custom", path: ["vatNumber"], message: BILLING_MESSAGES.vatRequired });
      return z.NEVER;
    }
    if (value.vatNumber) {
      const n = normaliseVatNumber(value.vatNumber);
      if (!n.ok) {
        ctx.addIssue({
          code: "custom",
          path: ["vatNumber"],
          message: n.reason === "checksum" ? BILLING_MESSAGES.vatChecksum : BILLING_MESSAGES.vatFormat,
        });
        return z.NEVER;
      }
      return { ...value, vatNumber: n.value };
    }
    return value;
  });

/** Billing identity of an order (`order_billing_details`, `invoice_requests.billing`): the parsed `BillingDetailsInput`. */
export type BillingDetails = {
  isCompany: boolean;
  legalName: string;
  /** Normalised (`BE0123456749`); required when `isCompany`. */
  vatNumber?: string;
  address: Address;
  billingEmail?: string;
  purchaseOrderRef?: string;
  peppolId?: string;
};

// The schema's output must stay assignable to the declared type.
const _billingDetailsOutput: (v: z.output<typeof BillingDetailsInput>) => BillingDetails = (v) => v;
void _billingDetailsOutput;

/** The Peppol id to use: the given one, else the one derived from a Belgian VAT number. */
export function billingPeppolId(details: Pick<BillingDetails, "isCompany" | "vatNumber" | "peppolId">): string | null {
  if (details.peppolId) return details.peppolId;
  return details.isCompany ? peppolIdFromVatNumber(details.vatNumber) : null;
}
