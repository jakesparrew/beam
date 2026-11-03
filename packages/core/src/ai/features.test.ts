import { describe, expect, it } from "vitest";
import { SENSITIVE_FIELD_KEYS } from "../privacy/sensitive-keys";
import { AI_ALLOWED_FIELDS } from "./context";
import {
  AI_FEATURE_KEYS,
  AI_FEATURES,
  BLUEPRINT_61_FIELDS,
  disallowedFields,
  isAiFeatureKey,
  modelIdFor,
} from "./features";

const entries = Object.entries(AI_FEATURES);

describe("AI_FEATURES", () => {
  it("has exactly the seven keys: the AI job kinds plus site's R4 audit", () => {
    expect(Object.keys(AI_FEATURES).sort()).toEqual([...AI_FEATURE_KEYS].sort());
    expect(Object.keys(AI_FEATURES).sort()).toEqual(
      ["ai.answer_question", "ai.classify", "ai.draft_email", "ai.draft_reply", "ai.weekly_summary", "site.audit_content", "site.propose_page"],
    );
  });

  it.each(entries)("%s: allowedFields is a subset of AI_ALLOWED_FIELDS", (_key, feature) => {
    for (const field of feature.allowedFields) expect(AI_ALLOWED_FIELDS as readonly string[]).toContain(field);
    for (const key of SENSITIVE_FIELD_KEYS) expect(feature.allowedFields as readonly string[]).not.toContain(key);
  });

  it.each(entries)("%s: all ten blueprint-61 fields are present and filled", (_key, feature) => {
    expect(BLUEPRINT_61_FIELDS).toHaveLength(10);
    for (const field of BLUEPRINT_61_FIELDS) {
      const value = feature[field];
      expect(value, field).toBeDefined();
      if (typeof value === "string") expect(value.trim(), field).not.toBe("");
    }
    expect(feature.provider).toBe("Anthropic");
    expect(feature.location).toBe(
      "Anthropic API, US processing under the EU-US DPF and SCCs; an EU endpoint is used once Anthropic offers one",
    );
    expect(feature.retention).toBe("30 days in ai_requests; Anthropic API retention per its commercial terms");
    expect(feature.trainingStatus).toBe("not_used_for_training");
    expect(feature.promptStorage).toBe("ai_requests.prompt");
    expect(feature.promptRetention).toBe("30 days");
    expect(feature.allowsSensitive).toBe(false);
  });

  it("site.propose_page and site.audit_content send no personal data", () => {
    expect(AI_FEATURES["site.propose_page"].allowedFields).toEqual([]);
    expect(AI_FEATURES["site.audit_content"].allowedFields).toEqual([]);
    expect(AI_FEATURES["site.propose_page"]).toMatchObject({ model: "opus", when: "V1" });
    expect(AI_FEATURES["site.audit_content"]).toMatchObject({ model: "haiku", when: "R4" });
    expect(AI_FEATURES["ai.classify"].model).toBe("haiku");
  });

  it("maps model aliases and checks fields sent (PL-53)", () => {
    expect(modelIdFor("opus")).toBe("claude-opus-5-5");
    expect(modelIdFor("haiku")).toBe("claude-haiku-5-5");
    expect(disallowedFields(AI_FEATURES["ai.draft_reply"], ["first_name", "locale"])).toEqual([]);
    expect(disallowedFields(AI_FEATURES["site.propose_page"], ["first_name"])).toEqual(["first_name"]);
    expect(disallowedFields(AI_FEATURES["ai.draft_reply"], ["health_note", "email"])).toEqual(["health_note", "email"]);
    expect(isAiFeatureKey("ai.classify")).toBe(true);
    expect(isAiFeatureKey("inbox_draft")).toBe(false);
  });
});
