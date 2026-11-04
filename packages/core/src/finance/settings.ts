/**
 * finance's settings key `finance` and the shape of platform's `company` key (finance spec
 * section 8). `apps/web/modules/finance/config.ts` declares the key with `FinanceSettingSchema`
 * (production adds `financeSettingSchemaFor('production')`, which refuses `peppol_enabled =
 * false`, rule 34); `packages/db/src/seed/finance.ts` seeds `FINANCE_SETTING_DEFAULT`.
 * Footer and VAT notes must be complete in the three locales; the IBAN, when filled in, must
 * pass the ISO 13616 mod-97 check. The issuer fields start empty: issuing never waits for them.
 */
import { z } from "zod";
import { LOCALES } from "../i18n/locales";
import { LocalizedTextSchema, missingLocales } from "../i18n/localized-text";
import { INVOICE_LINE_CATEGORIES } from "./types";

/** Categories that may carry a VAT note (printed on their 0 % lines, rule 7). */
export const VAT_NOTE_CATEGORIES = INVOICE_LINE_CATEGORIES;

/** ISO 13616 IBAN check: country, two check digits, BBAN; moved and mod 97 = 1. */
export function isValidIban(input: string): boolean {
  const s = input.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of moved) {
    const value = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const completeText = (what: string) =>
  LocalizedTextSchema.superRefine((text, ctx) => {
    const missing = missingLocales(text, LOCALES);
    if (missing.length) ctx.addIssue({ code: "custom", message: `missing_translation: ${what} lacks ${missing.join(", ")}` });
  });

export const FinanceIssuerSchema = z.object({
  register_court: z.string().trim().max(200),
  iban: z
    .string()
    .transform((v) => v.replace(/\s+/g, "").toUpperCase())
    .refine((v) => v === "" || isValidIban(v), { message: "finance.settings.iban_invalid" }),
  bic: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => v === "" || /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v), { message: "finance.settings.bic_invalid" }),
  invoice_footer: completeText("finance.issuer.invoice_footer"),
});

export const FinanceSettingSchema = z.object({
  issuer: FinanceIssuerSchema,
  payment_terms_days: z.number().int().min(1).max(120),
  company_request_window_days: z.number().int().min(1).max(366),
  billit_enabled: z.boolean(),
  peppol_enabled: z.boolean(),
  alert_after_minutes: z.number().int().min(5).max(1440),
  reconcile_lookback_days: z.number().int().min(1).max(366),
  vat_notes: z.partialRecord(z.enum(VAT_NOTE_CATEGORIES), completeText("finance.vat_notes")),
});
export type FinanceSetting = z.output<typeof FinanceSettingSchema>;

/** The schema of the `finance` key for an `APP_ENV`: production refuses `peppol_enabled = false` (rule 19a, 34). */
export function financeSettingSchemaFor(appEnv: string) {
  return appEnv === "production"
    ? FinanceSettingSchema.refine((v) => v.peppol_enabled, {
        path: ["peppol_enabled"],
        message: "finance.settings.peppol_required_in_production",
      })
    : FinanceSettingSchema;
}

/** The seeded value: empty issuer fields, the general-terms footer and the voucher VAT note. */
export const FINANCE_SETTING_DEFAULT: FinanceSetting = {
  issuer: {
    register_court: "",
    iban: "",
    bic: "",
    invoice_footer: {
      "nl-BE": "Onze algemene voorwaarden zijn van toepassing.",
      "fr-BE": "Nos conditions générales sont d'application.",
      en: "Our general terms and conditions apply.",
    },
  },
  payment_terms_days: 14,
  company_request_window_days: 30,
  billit_enabled: true,
  peppol_enabled: true,
  alert_after_minutes: 60,
  reconcile_lookback_days: 35,
  vat_notes: {
    voucher: {
      "nl-BE": "Btw verschuldigd bij inwisseling.",
      "fr-BE": "TVA due lors de l'utilisation.",
      en: "VAT due on redemption.",
    },
  },
};

/** Platform's `company` key as finance reads it (platform spec section 2; platform owns the schema). */
export const CompanySettingSchema = z.object({
  legal_name: z.string(),
  trade_name: z.string(),
  vat_number: z.string(),
  enterprise_number: z.string(),
  address: z.object({ street: z.string(), postal_code: z.string(), city: z.string(), country: z.string() }),
  support_email: z.string(),
  phone: z.string(),
  website: z.string(),
});
export type CompanySetting = z.output<typeof CompanySettingSchema>;
