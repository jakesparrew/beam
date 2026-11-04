import { describe, expect, it } from "vitest";
import { LOCALES, t } from "@beam/core/i18n";
import { renderEmail } from "../../render";
import type { TemplateDef } from "../define";
import { TEMPLATE_REGISTRY } from "../registry.generated";
import { PDF_ATTACHMENT, PDF_ATTACHMENT_TEMPLATES, templates } from "./index";

const portalUrl = "https://beam.example.com/nl/account/invoices";

/**
 * The `data` shapes `finance.send_invoice_email` builds (issued paid company invoice, open
 * bank-transfer invoice, credit note, reminder; the Peppol courtesy copy) and the one the
 * company request decision builds.
 */
const FIXTURES: Record<string, Array<{ label: string; data: Record<string, unknown> }>> = {
  invoice: [
    { label: "paid company invoice", data: { number: "BEAM-2026-000001", totalFormatted: "€ 121,00", portalUrl } },
    { label: "Peppol courtesy copy", data: { number: "BEAM-2026-000002", totalFormatted: "€ 121,00", portalUrl, isCourtesyCopy: true } },
    {
      label: "open bank transfer",
      data: { number: "BEAM-2026-000003", totalFormatted: "€ 90,00", dueOn: "18 november 2026", paymentReference: "+++260/0000/00397+++", iban: "BE71 0961 2345 6769", portalUrl },
    },
  ],
  credit_note: [
    { label: "refund", data: { number: "CN-2026-000001", totalFormatted: "€ -45,00", reason: "Customer request", portalUrl } },
    { label: "Peppol courtesy copy", data: { number: "CN-2026-000002", totalFormatted: "€ -45,00", reason: "Reissued to company", portalUrl, isCourtesyCopy: true } },
  ],
  invoice_reminder: [
    {
      label: "overdue",
      data: { number: "BEAM-2026-000003", totalFormatted: "€ 90,00", dueOn: "18 november 2026", paymentReference: "+++260/0000/00397+++", iban: "BE71 0961 2345 6769", portalUrl },
    },
  ],
  company_request_decided: [
    { label: "approved", data: { number: "BEAM-2026-000004", totalFormatted: "€ 60,00", decision: "approved", portalUrl } },
    { label: "rejected with note", data: { number: "BEAM-2026-000004", totalFormatted: "€ 60,00", decision: "rejected", note: "Wrong VAT number", portalUrl } },
  ],
};

const byName = (name: string) => templates.find((tpl) => tpl.name === name) as TemplateDef;

describe("finance templates (finance-P3)", () => {
  it("are registered as finance.<name>", () => {
    const keys = templates.map((tpl) => `finance.${tpl.name}`);
    expect(keys).toEqual(["finance.invoice", "finance.credit_note", "finance.invoice_reminder", "finance.company_request_decided"]);
    for (const key of keys) expect(Object.keys(TEMPLATE_REGISTRY)).toContain(key);
  });

  it("the three document templates declare the PDF attachment, the decision does not", () => {
    expect([...PDF_ATTACHMENT_TEMPLATES].sort()).toEqual(["credit_note", "invoice", "invoice_reminder"]);
    expect(PDF_ATTACHMENT_TEMPLATES).not.toContain("company_request_decided" as never);
    expect(PDF_ATTACHMENT).toMatchObject({ kind: "invoice_pdf", mime: "application/pdf" });
    expect(PDF_ATTACHMENT.filename({ number: "BEAM-2026-000001" })).toBe("BEAM-2026-000001.pdf");
  });

  it("every slot is a finance.email.<name>.* key present in all three locales", () => {
    for (const tpl of templates) {
      for (const key of Object.values(tpl.slots)) {
        expect(key.startsWith(`finance.email.${tpl.name}.`)).toBe(true);
        for (const locale of LOCALES) expect(t.has(locale, key), `${locale} ${key}`).toBe(true);
      }
    }
  });

  it("the props schemas accept the data the sender and the decision build, and refuse incomplete data", () => {
    for (const [name, variants] of Object.entries(FIXTURES)) for (const v of variants) expect(byName(name).props.safeParse(v.data).success, `${name} ${v.label}`).toBe(true);
    expect(byName("invoice").props.safeParse({ number: "BEAM-2026-000001", totalFormatted: "€ 1,00" }).success).toBe(false);
    expect(byName("invoice").props.safeParse({ number: "X-1", totalFormatted: "€ 1,00", portalUrl }).success).toBe(false);
    expect(byName("company_request_decided").props.safeParse({ number: "BEAM-2026-000001", totalFormatted: "€ 1,00", portalUrl }).success).toBe(false);
  });

  for (const [name, variants] of Object.entries(FIXTURES)) {
    for (const v of variants) {
      it.each(LOCALES)(`${name} (${v.label}) renders in %s with copy from finance.email.*`, async (locale) => {
        const out = await renderEmail(byName(name), { locale, props: v.data });
        expect(out.html).toContain(`lang="${locale}"`);
        expect(out.html).not.toMatch(/⟦/);
        expect(out.subject).toBe(t(locale, `finance.email.${name}.subject`, { number: v.data.number as string }));
        expect(out.text.replace(/\s+/g, " ").toLowerCase()).toContain(t(locale, `finance.email.${name}.heading`).toLowerCase());
        expect(out.text.replace(/\s+/g, " ")).toContain(t(locale, `finance.email.${name}.body`, { number: v.data.number as string, totalFormatted: v.data.totalFormatted as string }).replace(/\s+/g, " "));
        expect(out.text).toContain(portalUrl);
        const courtesyKey = `finance.email.${name}.courtesy_copy`;
        if (t.has(locale, courtesyKey)) {
          const line = t(locale, courtesyKey);
          if (v.data.isCourtesyCopy) expect(out.text.replace(/\s+/g, " ")).toContain(line);
          else expect(out.text.replace(/\s+/g, " ")).not.toContain(line);
        }
        if (v.data.paymentReference) expect(out.text).toContain(v.data.paymentReference as string);
        if (name === "company_request_decided") {
          expect(out.text.replace(/\s+/g, " ")).toContain(t(locale, `finance.email.company_request_decided.${v.data.decision as string}`));
          if (v.data.note) expect(out.text).toContain("Wrong VAT number");
        }
      });
    }
  }
});
