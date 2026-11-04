/**
 * finance-P5 `config.ts` (finance spec section 8, rules 19a and 34): the schema of the `finance`
 * settings key refuses an invoice footer or a VAT note that is not complete in the three locales
 * and, with `APP_ENV = production`, `peppol_enabled = false`; outside production the switch may be
 * off. The registered setting uses the same schema and the seeded default passes it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FINANCE_SETTING_DEFAULT } from "@beam/core/finance";
import { FinanceSettings, settings } from "./config";

const valid = () => structuredClone(FINANCE_SETTING_DEFAULT);
const paths = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) => (r.error?.issues ?? []).map((i) => i.path.map(String).join("."));

afterEach(() => vi.unstubAllEnvs());

describe("the finance settings key", () => {
  it("accepts the seeded default and is the schema of the registered key", () => {
    expect(FinanceSettings.safeParse(valid()).success).toBe(true);
    const def = settings.find((s) => s.key === "finance");
    expect(def?.schema).toBe(FinanceSettings);
    expect(def?.default).toEqual(FINANCE_SETTING_DEFAULT);
  });

  it("refuses an invoice footer missing a locale", () => {
    const value = valid();
    value.issuer.invoice_footer = { "nl-BE": "Onze voorwaarden gelden.", en: "Our terms apply." };
    const r = FinanceSettings.safeParse(value);
    expect(r.success).toBe(false);
    expect(paths(r).some((p) => p.startsWith("issuer.invoice_footer"))).toBe(true);
  });

  it("refuses a VAT note missing a locale or left blank", () => {
    const missing = valid();
    missing.vat_notes = { voucher: { "nl-BE": "Btw verschuldigd bij inwisseling.", "fr-BE": "TVA due lors de l'utilisation." } };
    const r1 = FinanceSettings.safeParse(missing);
    expect(r1.success).toBe(false);
    expect(paths(r1).some((p) => p.startsWith("vat_notes.voucher"))).toBe(true);

    const blank = valid();
    blank.vat_notes = { voucher: { "nl-BE": "Btw verschuldigd bij inwisseling.", "fr-BE": "TVA due lors de l'utilisation.", en: "  " } };
    expect(FinanceSettings.safeParse(blank).success).toBe(false);
  });

  it("refuses peppol_enabled = false in production only", () => {
    const value = { ...valid(), peppol_enabled: false };
    vi.stubEnv("APP_ENV", "staging");
    expect(FinanceSettings.safeParse(value).success).toBe(true);
    vi.stubEnv("APP_ENV", "production");
    const r = FinanceSettings.safeParse(value);
    expect(r.success).toBe(false);
    expect(paths(r)).toContain("peppol_enabled");
    expect(FinanceSettings.safeParse(valid()).success).toBe(true);
  });
});
