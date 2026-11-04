/** forms' `defaults` seed (forms-P2): retention rows and the three system forms, idempotent. */
import { deriveVersionColumns, seedDefinitions, type SYSTEM_FORM_SLUGS } from "@beam/core/forms";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../client";
import { forms, formVersions } from "../schema/forms";
import { retentionPolicies } from "../schema/ops";
import { createTestDb } from "../testing";
import { FORMS_RETENTION_POLICIES, insertSeedForm, seed } from "./forms";
import { DEFAULT_SEEDS } from "./index.generated";
import { seedDefaults } from "./run";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  await seedDefaults(h.db);
});
afterAll(() => h.close());

describe("forms defaults seed", () => {
  it("is registered after platform and ops", () => {
    const order = (DEFAULT_SEEDS as readonly { module: string }[]).map((s) => s.module);
    expect(order).toContain("forms");
    expect(order.indexOf("forms")).toBeGreaterThan(order.indexOf("ops"));
    expect(seed.after).toEqual(["platform", "ops"]);
  });

  it("seeds the five forms retention rows; with ops' two, all seven forms keys exist", async () => {
    const rows = await h.db.select().from(retentionPolicies);
    const keys = rows.map((r) => r.key).filter((k) => k.startsWith("forms."));
    expect(keys.sort()).toEqual(
      [
        "forms.form_sensitive_answers",
        "forms.form_submissions",
        ...FORMS_RETENTION_POLICIES.map((p) => p.key),
      ].sort(),
    );
    const ip = rows.find((r) => r.key === "forms.form_submissions_ip_hash")!;
    expect(ip).toMatchObject({ tableName: "form_submissions", days: 30, action: "anonymise", runOrder: 33 });
    for (const k of keys) expect(k).toMatch(/^[a-z]+\.[a-z][a-z0-9_]*$/);
  });

  it("publishes contact and newsletter v1 and leaves health-declaration a draft", async () => {
    const rows = await h.db.select().from(forms).orderBy(asc(forms.slug));
    expect(rows.map((r) => [r.slug, r.kind, r.status])).toEqual([
      ["contact", "lead", "published"],
      ["health-declaration", "intake", "draft"],
      ["newsletter", "lead", "published"],
    ]);
    const versions = await h.db.select().from(formVersions);
    expect(versions).toHaveLength(3);
    for (const f of rows) {
      const v = versions.find((x) => x.formId === f.id)!;
      expect(v.version).toBe(1);
      expect(v.publishedByUserId).toBeNull();
      expect(v.createdByUserId).toBeNull();
      expect(v.locales).toEqual(["nl-BE", "fr-BE", "en"]);
      const def = seedDefinitions()[f.slug as (typeof SYSTEM_FORM_SLUGS)[number]];
      expect(v.definitionHash).toBe(deriveVersionColumns(def.definition, def.scoring).definitionHash);
      if (f.slug === "health-declaration") {
        expect(v.publishedAt).toBeNull();
        expect(f.currentVersionId).toBeNull();
        expect(v.sensitiveFieldKeys).toHaveLength(9);
        expect(v.consentPurposes).toEqual(["sensitive_processing"]);
      } else {
        expect(v.publishedAt).not.toBeNull();
        expect(f.currentVersionId).toBe(v.id);
        expect(v.sensitiveFieldKeys).toEqual([]);
        expect(v.consentPurposes).toEqual(["newsletter"]);
      }
    }
  });

  it("a second run changes nothing and never overwrites an existing form", async () => {
    const [contact] = await h.db.select().from(forms).where(eq(forms.slug, "contact"));
    await h.db.update(forms).set({ description: "staff note" }).where(eq(forms.id, contact!.id));
    const before = await h.db.select().from(formVersions);
    await seedDefaults(h.db);
    expect(await h.db.select().from(formVersions)).toEqual(before);
    const [again] = await h.db.select().from(forms).where(eq(forms.slug, "contact"));
    expect(again!.description).toBe("staff note");
    expect(await insertSeedForm(h.db, "contact", seedDefinitions().contact, { publish: true })).toBeNull();
  });

  it("refuses to publish a seed form with errors", async () => {
    const broken = seedDefinitions().contact;
    broken.definition.endings = [];
    await expect(insertSeedForm(h.db, "broken-seed", broken, { publish: true })).rejects.toThrow(/no_ending/);
  });
});
