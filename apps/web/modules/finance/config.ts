/**
 * finance settings (02-data-model 5.4, finance spec section 8). Facade read by
 * `pnpm gen:indexes`. finance owns the key `finance`: the invoice-only issuer fields (register
 * court, IBAN, BIC, footer) and the finance switches; the issuer identity lives once, in
 * platform's `company` (cross-module D17). The schema is `FinanceSettingSchema` of
 * `@beam/core/finance` (footer and VAT notes complete in the three locales, IBAN mod-97, BIC
 * format) plus the production guard of rules 19a and 34: with `APP_ENV = production` a value with
 * `peppol_enabled = false` is refused. Staff edit the key through platform's `updateSetting`
 * at `/admin/settings/finance`; finance itself never writes it.
 */
import { FINANCE_SETTING_DEFAULT, FinanceSettingSchema } from "@beam/core/finance";
import { appEnv } from "@/lib/integrations";
import { defineSetting } from "@/lib/settings";

/** The `finance` key's schema, checked at parse time against the current `APP_ENV`. */
export const FinanceSettings = FinanceSettingSchema.superRefine((value, ctx) => {
  if (appEnv() === "production" && !value.peppol_enabled) {
    ctx.addIssue({ code: "custom", path: ["peppol_enabled"], message: "finance.settings.peppol_required_in_production" });
  }
});

export const settings = [
  defineSetting({
    key: "finance",
    schema: FinanceSettings,
    default: FINANCE_SETTING_DEFAULT,
    description: "Invoice issuer details, payment terms, Billit and Peppol switches, reconcile window and VAT notes",
  }),
] as const;

export const flags = [] as const;
