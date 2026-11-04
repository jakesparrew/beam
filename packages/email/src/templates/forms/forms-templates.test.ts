/** forms-P4: `forms.result` and `forms.result_link` (forms spec section 8, rules C1, C4, SE4). */
import { describe, expect, it } from "vitest";
import { FORM_RESULT_LINK_SAMPLE, FORM_RESULT_SAMPLE } from "@beam/core/forms";
import { LOCALES, t } from "@beam/core/i18n";
import { renderEmail } from "../../render";
import type { TemplateDef } from "../define";
import { TEMPLATE_REGISTRY } from "../registry.generated";
import { templates } from "./index";

const byName = (name: string) => templates.find((tpl) => tpl.name === name) as TemplateDef;
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("forms templates (forms-P4)", () => {
  it("are registered as forms.result and forms.result_link with samples that pass their schemas", () => {
    expect(templates.map((tpl) => tpl.name)).toEqual(["result", "result_link"]);
    const registry = TEMPLATE_REGISTRY as unknown as Record<string, TemplateDef>;
    expect(registry["forms.result"]?.name).toBe("result");
    expect(registry["forms.result_link"]?.name).toBe("result_link");
    for (const tpl of templates) {
      expect(tpl.props.safeParse(tpl.sample).success, tpl.name).toBe(true);
      expect((tpl as { loadProps?: unknown }).loadProps).toBeUndefined();
    }
  });

  it("every slot is a forms.email.<name>.* key present in all three locales", () => {
    for (const tpl of templates) {
      for (const key of Object.values(tpl.slots)) {
        expect(key.startsWith(`forms.email.${tpl.name}.`), key).toBe(true);
        for (const locale of LOCALES) expect(t.has(locale, key), `${locale} ${key}`).toBe(true);
      }
    }
  });

  it.each(LOCALES)("both samples render in %s with their copy", async (locale) => {
    const result = await renderEmail(byName("result"), { locale, props: FORM_RESULT_SAMPLE });
    expect(result.html).toContain(`lang="${locale}"`);
    expect(result.html).not.toMatch(/⟦/);
    expect(result.subject).toBe(t(locale, "forms.email.result.subject", { formTitle: FORM_RESULT_SAMPLE.formTitle }));
    const text = flat(result.text);
    expect(text).toContain(FORM_RESULT_SAMPLE.outcomeLabel!);
    expect(text).toContain(FORM_RESULT_SAMPLE.scoreLine!);
    expect(text).toContain(FORM_RESULT_SAMPLE.resultUrl);
    expect(result.links).toEqual(expect.arrayContaining([FORM_RESULT_SAMPLE.resultUrl, FORM_RESULT_SAMPLE.ctas[0]!.url]));

    const link = await renderEmail(byName("result_link"), { locale, props: FORM_RESULT_LINK_SAMPLE });
    expect(link.html).toContain(`lang="${locale}"`);
    expect(link.html).not.toMatch(/⟦/);
    expect(link.subject).toBe(t(locale, "forms.email.result_link.subject", { formTitle: FORM_RESULT_LINK_SAMPLE.formTitle }));
    expect(flat(link.text)).toContain(flat(t(locale, "forms.email.result_link.body", { formTitle: FORM_RESULT_LINK_SAMPLE.formTitle })));
    expect(link.text).toContain(FORM_RESULT_LINK_SAMPLE.resultUrl);
  });

  it("pendingConfirmation adds the confirmation line, and only then", async () => {
    for (const locale of LOCALES) {
      const line = t(locale, "forms.email.result.pending_confirmation");
      const off = await renderEmail(byName("result"), { locale, props: FORM_RESULT_SAMPLE });
      const on = await renderEmail(byName("result"), { locale, props: { ...FORM_RESULT_SAMPLE, pendingConfirmation: true } });
      expect(flat(off.text)).not.toContain(line);
      expect(flat(on.text)).toContain(line);
    }
  });

  it("SE4: the result email never contains a sensitive dimension value or a raw answer", async () => {
    // The props are strict: there is no slot for dimension values or answers, so they cannot be passed.
    const withDimensions = { ...FORM_RESULT_SAMPLE, dimensions: { sleep: { value: 3 } } };
    expect(byName("result").props.safeParse(withDimensions).success).toBe(false);
    expect(byName("result").props.safeParse({ ...FORM_RESULT_SAMPLE, answers: { sleep_hours: "5_6" } }).success).toBe(false);
    const out = await renderEmail(byName("result"), { locale: "en", props: { ...FORM_RESULT_SAMPLE, scoreLine: null } });
    expect(out.text).not.toContain(FORM_RESULT_SAMPLE.scoreLine!);
    expect(out.text).not.toMatch(/sleep_hours|stress_level|score:/);
  });

  it("greets without a name when the first name is unknown", async () => {
    const out = await renderEmail(byName("result_link"), { locale: "nl-BE", props: { ...FORM_RESULT_LINK_SAMPLE, firstName: null } });
    expect(flat(out.text)).toContain(`${t("nl-BE", "forms.email.result_link.greeting")},`);
  });
});
