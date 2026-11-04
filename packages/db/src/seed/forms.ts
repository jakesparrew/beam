/**
 * forms's `defaults` seed profile (runbook 3.4, BS-11, forms-P2; forms spec sections 9 and 12),
 * also run in production. Idempotent: every insert is `on conflict do nothing`, an existing form
 * is never touched (P13: system slugs are never renamed; content changes only through new
 * published versions), so staff edits survive a re-run.
 *
 * - the five `retention_policies` rows forms seeds (ops seeds `forms.form_sensitive_answers` and
 *   `forms.form_submissions` itself);
 * - `contact` and `newsletter` with a published version 1 (publisher null = the seed; neither
 *   has sensitive fields, so the DPIA gate of rule P7 does not apply);
 * - `health-declaration` as form `draft` with an unpublished version 1 draft: it has sensitive
 *   fields, so staff publish it once the DPIA is decided (cross-module D39).
 */
import { deriveVersionColumns, isPublishable, seedDefinitions, validateForPublish, type SeedForm, type SystemFormSlug } from "@beam/core/forms";
import type { RetentionPolicySeed } from "@beam/core/privacy";
import { eq } from "drizzle-orm";
import type { DbOrTx } from "../client";
import { forms, formVersions, type FormDefinitionJson, type FormScoringJson } from "../schema/forms";
import { insertRetentionPolicies } from "./ops";
import type { DefaultSeed } from "./run";

/** Forms spec section 9: the retention rows forms seeds (run_order 31 to 35). */
export const FORMS_RETENTION_POLICIES: readonly RetentionPolicySeed[] = [
  { runOrder: 31, key: "forms.form_submissions_anonymous_abandoned", tableName: "form_submissions", days: 30, action: "delete", description: "Abandoned anonymous form submissions (no person) after 30 days" },
  { runOrder: 32, key: "forms.form_sensitive_answers_unlinked", tableName: "form_sensitive_answers", days: 30, action: "delete", description: "Sensitive answers of unlinked, uncompleted submissions after 30 days" },
  { runOrder: 33, key: "forms.form_submissions_ip_hash", tableName: "form_submissions", days: 30, action: "anonymise", description: "IP hashes of form submissions removed after 30 days" },
  { runOrder: 34, key: "forms.form_import_events", tableName: "form_import_events", days: 90, action: "delete", description: "Raw ScoreApp and Typeform import payloads after 90 days" },
  { runOrder: 35, key: "forms.form_views_daily", tableName: "form_views_daily", days: 1095, action: "delete", description: "Daily form view counters after 3 years" },
];

/** Which system forms the seed publishes (the others stay a draft until staff publish them). */
export const SEED_PUBLISHED: Readonly<Record<SystemFormSlug, boolean>> = { contact: true, newsletter: true, "health-declaration": false };

/**
 * Inserts a form with its version 1 unless the slug exists. `publish` stamps the version and
 * makes it current. Returns the new ids, or null when the slug already existed.
 */
export async function insertSeedForm(db: DbOrTx, slug: string, form: SeedForm, opts: { publish: boolean; now?: Date }): Promise<{ formId: string; versionId: string } | null> {
  if (opts.publish) {
    const errors = validateForPublish(form.kind, form.definition, form.scoring, form.locales).filter((i) => i.level === "error");
    if (!isPublishable(errors)) throw new Error(`seed form ${slug} is not publishable: ${errors.map((e) => `${e.code} ${e.path}`).join("; ")}`);
  }
  const [created] = await db
    .insert(forms)
    .values({ slug, kind: form.kind, name: form.name, status: "draft", createdByUserId: null })
    .onConflictDoNothing({ target: forms.slug })
    .returning({ id: forms.id });
  if (!created) return null;
  const now = opts.now ?? new Date();
  const derived = deriveVersionColumns(form.definition, form.scoring);
  const [version] = await db
    .insert(formVersions)
    .values({
      formId: created.id,
      version: 1,
      definition: form.definition as unknown as FormDefinitionJson,
      scoring: form.scoring as unknown as FormScoringJson,
      locales: form.locales,
      ...derived,
      changeNote: "Version 1 (seed)",
      publishedAt: opts.publish ? now : null,
      publishedByUserId: null,
      createdByUserId: null,
    })
    .returning({ id: formVersions.id });
  if (opts.publish) await db.update(forms).set({ status: "published", currentVersionId: version!.id, updatedAt: now }).where(eq(forms.id, created.id));
  return { formId: created.id, versionId: version!.id };
}

async function run(db: DbOrTx): Promise<void> {
  await insertRetentionPolicies(db, FORMS_RETENTION_POLICIES);
  const defs = seedDefinitions();
  for (const slug of Object.keys(defs) as SystemFormSlug[]) await insertSeedForm(db, slug, defs[slug], { publish: SEED_PUBLISHED[slug] });
}

export const seed: DefaultSeed = { after: ["platform", "ops"], run };
