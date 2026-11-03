/**
 * finance settings (02-data-model 5.4, finance spec section 8). Facade read by
 * `pnpm gen:indexes`. Wave 0 by platform-P7; finance owns it from finance-P1 on. The issuer
 * identity lives once, in platform's `company`: this key has no `enterprise_number` or
 * `website` (cross-module D17).
 */
import { z } from "zod";
import { LocalizedTextSchema } from "@beam/core/i18n";
import { defineSetting } from "@/lib/settings";

const VAT_NOTE_CATEGORIES = ["voucher", "item", "session", "night", "package", "membership", "ticket"] as const;

export const FinanceSettings = z.object({
  issuer: z.object({
    register_court: z.string(),
    iban: z.string(),
    bic: z.string(),
    invoice_footer: LocalizedTextSchema,
  }),
  payment_terms_days: z.number().int().positive(),
  company_request_window_days: z.number().int().positive(),
  billit_enabled: z.boolean(),
  peppol_enabled: z.boolean(),
  alert_after_minutes: z.number().int().positive(),
  reconcile_lookback_days: z.number().int().positive(),
  vat_notes: z.partialRecord(z.enum(VAT_NOTE_CATEGORIES), LocalizedTextSchema),
});

export const settings = [
  defineSetting({
    key: "finance",
    schema: FinanceSettings,
    default: {
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
    },
    description: "Invoice issuer details, payment terms, Billit and Peppol switches, reconcile window and VAT notes",
  }),
] as const;

export const flags = [] as const;
