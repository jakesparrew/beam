/**
 * email-P3: the system templates (email spec rule 15a, section 8 "Seed") and the email
 * retention rows of the `defaults` profile.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { emailTemplates, emailTemplateVersions, retentionPolicies } from "@beam/db/schema";
import { EMAIL_RETENTION_POLICIES, seed as emailDefaults } from "@beam/db/seed/email";
import { TEMPLATE_REGISTRY } from "@beam/email/templates/registry";
import { eq, inArray, sql } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { seedSystemTemplates } from "./seed";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const keys = Object.keys(TEMPLATE_REGISTRY).sort();

async function snapshot() {
  const rows = await h.db
    .select({ slug: emailTemplates.slug, updatedAt: emailTemplates.updatedAt, version: emailTemplateVersions.version, copy: emailTemplateVersions.copy, vUpdated: emailTemplateVersions.updatedAt })
    .from(emailTemplates)
    .innerJoin(emailTemplateVersions, eq(emailTemplateVersions.templateId, emailTemplates.id))
    .where(inArray(emailTemplates.slug, keys));
  return rows.sort((a, b) => (a.slug + a.version).localeCompare(b.slug + b.version));
}

describe("seedSystemTemplates", () => {
  it("creates one published system row per registry entry with copy from the owning catalogue", async () => {
    const first = await seedSystemTemplates(h.db);
    expect(first.created.sort()).toEqual(keys);
    const rows = await h.db.select().from(emailTemplates).where(inArray(emailTemplates.slug, keys));
    expect(rows).toHaveLength(keys.length);
    for (const r of rows) {
      expect(r).toMatchObject({ kind: "transactional", isSystem: true, status: "published", purpose: null });
      const [v] = await h.db.select().from(emailTemplateVersions).where(eq(emailTemplateVersions.id, r.currentVersionId!));
      expect(v).toMatchObject({ version: 1, reactComponent: r.slug, document: null });
      expect(v!.publishedAt).not.toBeNull();
    }
    const [magic] = await h.db.select().from(emailTemplateVersions).innerJoin(emailTemplates, eq(emailTemplates.id, emailTemplateVersions.templateId)).where(eq(emailTemplates.slug, "platform.magic_link"));
    expect(magic!.email_template_versions.copy?.subject).toEqual({ "nl-BE": expect.any(String), "fr-BE": expect.any(String), en: "Your sign-in link for BEAM" });
    expect(magic!.email_template_versions.locales).toEqual(["nl-BE", "fr-BE", "en"]);
  });

  it("a second run changes nothing", async () => {
    const before = await snapshot();
    const second = await seedSystemTemplates(h.db);
    expect(second.created).toEqual([]);
    expect(second.existing.sort()).toEqual(keys);
    expect(await snapshot()).toEqual(before);
  });

  it("edited copy survives a reseed", async () => {
    const [t] = await h.db.select().from(emailTemplates).where(eq(emailTemplates.slug, "platform.magic_link"));
    const edited = { subject: { "nl-BE": "Aangepast onderwerp", "fr-BE": "Objet modifié", en: "Edited subject" } };
    const [v2] = await h.db
      .insert(emailTemplateVersions)
      .values({ templateId: t!.id, version: 2, copy: edited, reactComponent: "platform.magic_link", locales: ["nl-BE", "fr-BE", "en"], publishedAt: new Date() })
      .returning();
    await h.db.update(emailTemplates).set({ currentVersionId: v2!.id }).where(eq(emailTemplates.id, t!.id));
    await seedSystemTemplates(h.db);
    const [after] = await h.db.select().from(emailTemplates).where(eq(emailTemplates.slug, "platform.magic_link"));
    expect(after!.currentVersionId).toBe(v2!.id);
    const [cur] = await h.db.select().from(emailTemplateVersions).where(eq(emailTemplateVersions.id, v2!.id));
    expect(cur!.copy).toEqual(edited);
  });
});

describe("email defaults seed", () => {
  it("inserts the retention rows once and keeps staff edits", async () => {
    await emailDefaults.run(h.db, {});
    await h.db.update(retentionPolicies).set({ days: 900 }).where(eq(retentionPolicies.key, "email.email_events"));
    await emailDefaults.run(h.db, {});
    const rows = await h.db.select().from(retentionPolicies).where(sql`${retentionPolicies.key} like 'email.%'`);
    expect(rows.map((r) => r.key).sort()).toEqual(EMAIL_RETENTION_POLICIES.map((p) => p.key).sort());
    expect(rows.find((r) => r.key === "email.email_events")!.days).toBe(900);
  });
});
