/**
 * finance-P2 `config.ts`: the `finance` key is registered with its default, the schema refuses an
 * incomplete footer or VAT note, and `peppol_enabled = false` only in production (rules 19a, 34).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FINANCE_SETTING_DEFAULT } from "@beam/core/finance";
import { SETTINGS } from "@/registry/settings.generated";
import { FinanceSettings, settings } from "../../config";

afterEach(() => vi.unstubAllEnvs());

describe("the finance settings key", () => {
  it("is declared once with the seeded default", () => {
    expect(settings.map((s) => s.key)).toEqual(["finance"]);
    expect((SETTINGS as Record<string, { default: unknown }>).finance?.default).toEqual(FINANCE_SETTING_DEFAULT);
    expect(FinanceSettings.safeParse(FINANCE_SETTING_DEFAULT).success).toBe(true);
  });

  it("refuses an incomplete footer or VAT note", () => {
    const footer = { ...FINANCE_SETTING_DEFAULT, issuer: { ...FINANCE_SETTING_DEFAULT.issuer, invoice_footer: { "nl-BE": "Voorwaarden", en: "Terms" } } };
    expect(FinanceSettings.safeParse(footer).success).toBe(false);
    const note = { ...FINANCE_SETTING_DEFAULT, vat_notes: { voucher: { "nl-BE": "Btw bij inwisseling" } } };
    expect(FinanceSettings.safeParse(note).success).toBe(false);
  });

  it("refuses peppol_enabled = false in production only", () => {
    const off = { ...FINANCE_SETTING_DEFAULT, peppol_enabled: false };
    vi.stubEnv("APP_ENV", "local");
    expect(FinanceSettings.safeParse(off).success).toBe(true);
    vi.stubEnv("APP_ENV", "production");
    const parsed = FinanceSettings.safeParse(off);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("finance.settings.peppol_required_in_production");
    expect(FinanceSettings.safeParse(FINANCE_SETTING_DEFAULT).success).toBe(true);
  });
});
