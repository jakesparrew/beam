import { describe, expect, it } from "vitest";
import { TEMPLATE_REGISTRY } from "../registry.generated";
import type { TemplateDef } from "../define";
import { confirmResubscribeHref } from "./confirm-resubscribe";
import { templates } from "./index";

const REGISTRY = TEMPLATE_REGISTRY as unknown as Record<string, TemplateDef>;

describe("crm template registration (fix-w05-crm-1)", () => {
  it("registers confirm_resubscribe and preference_link under crm.<name>", () => {
    expect(templates.map((t) => t.name).sort()).toEqual(["confirm_resubscribe", "preference_link"]);
    expect(REGISTRY["crm.confirm_resubscribe"]?.name).toBe("confirm_resubscribe");
    expect(REGISTRY["crm.preference_link"]?.name).toBe("preference_link");
  });

  it("gives each template a sample that passes its props schema and a footer slot", () => {
    for (const t of templates) {
      expect(t.sample, t.name).toBeDefined();
      expect(t.props.safeParse(t.sample).success, t.name).toBe(true);
      expect(t.slots.subject).toBe(`crm.email.${t.name}.subject`);
      expect(t.slots.footer).toBe(`crm.email.${t.name}.footer`);
    }
  });

  it("builds the resubscribe confirmation link on the preference-centre URL", () => {
    expect(confirmResubscribeHref("https://beam.example.com/api/public/preferences?t=x", "newsletter")).toBe(
      "https://beam.example.com/api/public/preferences?t=x&confirm=resubscribe&purpose=newsletter",
    );
    expect(confirmResubscribeHref(undefined, "events")).toBe("{{preferences_url}}?confirm=resubscribe&purpose=events");
  });
});
