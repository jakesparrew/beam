import { describe, expect, it } from "vitest";
import { IMPORT_PRESETS, WEBINAR_PRESET_KEYS, presetTargetsValid, presetsFor, type ImportPreset } from "./import-presets";
import { IMPORT_KINDS, IMPORT_SOURCES, IMPORT_TARGETS, missingTargets } from "./import-targets";

const entries = Object.entries(IMPORT_PRESETS) as [string, ImportPreset][];

describe("IMPORT_PRESETS", () => {
  it("each preset maps only to targets of its kind", () => {
    for (const [key, preset] of entries) {
      const allowed: readonly string[] = IMPORT_TARGETS[preset.kind];
      for (const [header, target] of Object.entries(preset.columns)) {
        expect(allowed, `${key}: ${header} -> ${target}`).toContain(target);
      }
      expect(presetTargetsValid(preset), key).toBe(true);
    }
  });

  it("each preset maps a target at most once and uses a known kind and source", () => {
    for (const [key, preset] of entries) {
      const targets = Object.values(preset.columns);
      expect(new Set(targets).size, key).toBe(targets.length);
      expect(IMPORT_KINDS, key).toContain(preset.kind);
      expect(IMPORT_SOURCES, key).toContain(preset.source);
    }
  });

  it("each preset satisfies the required mapping of its kind (rule 43), history kind included", () => {
    for (const [key, preset] of entries) {
      const mapped = Object.values(preset.columns);
      const withFixedKind = preset.historyKind ? [...mapped, "history_kind"] : mapped;
      // Packages name a product by SKU column; tags read the TAGS column.
      expect(missingTargets(preset.kind, withFixedKind), key).toEqual([]);
    }
  });

  it("has the four webinar presets of webinar's V1 stopgap, all of kind history and source webinar_tool", () => {
    expect([...WEBINAR_PRESET_KEYS].sort()).toEqual(["webinargeek_attendees", "webinargeek_registrants", "zoom_attendees", "zoom_registrants"]);
    for (const k of WEBINAR_PRESET_KEYS) {
      const p: ImportPreset = IMPORT_PRESETS[k];
      expect(p.kind).toBe("history");
      expect(p.source).toBe("webinar_tool");
      expect(["webinar_registration", "webinar_attendance"]).toContain(p.historyKind);
      expect(p.provider).toBeDefined();
    }
  });

  it("has presets for SimplyBook, Lightspeed and Mailchimp", () => {
    expect(presetsFor("simplybook", "persons")).toEqual(["simplybook_clients"]);
    expect(presetsFor("lightspeed", "history")).toEqual(["lightspeed_sales"]);
    expect(presetsFor("mailchimp", "suppressions")).toEqual(["mailchimp_unsubscribed", "mailchimp_cleaned"]);
  });

  it("never maps a non-consent column into a consent import (rule 47)", () => {
    for (const [key, preset] of entries) {
      if (preset.kind !== "consents") continue;
      expect(Object.keys(preset.columns).some((h) => /rating/i.test(h)), key).toBe(false);
    }
  });
});

describe("missingTargets (rule 43)", () => {
  it("persons need email or phone and last name", () => {
    expect(missingTargets("persons", ["first_name"])).toEqual(["email|phone+last_name"]);
    expect(missingTargets("persons", ["phone", "last_name"])).toEqual([]);
    expect(missingTargets("persons", ["email"])).toEqual([]);
  });

  it("packages need a product column or option", () => {
    expect(missingTargets("packages", ["email", "units_remaining", "expires_on"])).toEqual(["product_sku|option:productId"]);
    expect(missingTargets("packages", ["email", "units_remaining", "expires_on"], { productId: "p" })).toEqual([]);
  });

  it("tags accept the tag option for the whole file", () => {
    expect(missingTargets("tags", ["email"])).toEqual(["tag_key|option:tagKey"]);
    expect(missingTargets("tags", ["email"], { tagKey: "vip" })).toEqual([]);
  });

  it("history needs email, occurred_at, history_kind and external_id", () => {
    expect(missingTargets("history", ["email"])).toEqual(["occurred_at", "history_kind", "external_id"]);
  });
});
