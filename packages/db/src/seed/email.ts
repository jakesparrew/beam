/**
 * email's `defaults` seed profile (runbook 3.4, BS-11; email spec sections 8 and 9), email-P3.
 *
 * - `retention_policies` rows for the email tables (keys `email.email_messages`,
 *   `email.email_events`, `email.campaign_recipients`, `email.email_ai_drafts`), inserted
 *   `on conflict (key) do nothing`, so a staff edit survives. The same rows are declared in
 *   `apps/web/modules/email/privacy.ts` (`retention`), whose `sweep` handlers use these keys.
 * - The writers of system templates: `insertSystemTemplate()` creates one `email_templates` row
 *   (`kind = transactional`, `is_system = true`) and its published version 1 for a registry key;
 *   `insertSeededTemplate()` does the same for a block-backed template (`seedTemplate()`).
 *   Both never touch an existing slug, so edited copy survives every reseed. The registry and the
 *   catalogues live in `@beam/email` and `@beam/core/i18n`; `apps/web/modules/email/seed.ts`
 *   walks the registry and calls `insertSystemTemplate()` (this package never imports apps/web).
 *
 * Settings defaults are the declared defaults of `apps/web/modules/email/config.ts`:
 * `getSetting()` returns them while no row exists. The one exception is `email_brand` (email-P10,
 * R4): the declared default is empty, so the seed writes BEAM's starting tone of voice,
 * guidelines, do-not-say list and sample phrases (`EMAIL_BRAND_DEFAULTS`) once,
 * `on conflict (key) do nothing`, and marketing edits it from there.
 */
import type { RetentionPolicySeed } from "@beam/core/privacy";
import type { BlockDocument } from "@beam/core/email";
import type { DbOrTx } from "../client";
import type { LocalizedText } from "../schema/_shared";
import { emailTemplates, emailTemplateVersions } from "../schema/email";
import { settings } from "../schema/platform";
import { eq } from "drizzle-orm";
import { insertRetentionPolicies } from "./ops";
import type { DefaultSeed } from "./run";

const ALL_LOCALES = ["nl-BE", "fr-BE", "en"] as const;

/** email's retention policies (email spec section 9; keys follow cross-module convention 4). */
export const EMAIL_RETENTION_POLICIES: readonly RetentionPolicySeed[] = [
  {
    key: "email.email_messages",
    tableName: "email_messages",
    days: 730,
    action: "delete",
    description: "Email messages after 2 years (campaign messages only once the campaign has a stats snapshot)",
    runOrder: 410,
    batchSize: 5000,
  },
  { key: "email.email_events", tableName: "email_events", days: 730, action: "delete", description: "Delivery, open and click events after 2 years", runOrder: 400, batchSize: 5000 },
  {
    key: "email.campaign_recipients",
    tableName: "campaign_recipients",
    days: 730,
    action: "delete",
    description: "Campaign audience snapshots 2 years after the campaign finished",
    runOrder: 405,
    batchSize: 5000,
  },
  { key: "email.email_ai_drafts", tableName: "email_ai_drafts", days: 365, action: "delete", description: "AI campaign drafts after 1 year", runOrder: 420, batchSize: 5000 },
];

/** `settings.email_brand` starting values for AI campaign drafts (email spec section 6). */
export const EMAIL_BRAND_DEFAULTS = {
  tone_of_voice:
    "Warm, encouraging and personal, like a coach who knows you. Short sentences, active verbs, no jargon. We say 'je' in Dutch, 'vous' in French and 'you' in English. Energetic but calm; never pushy.",
  guidelines:
    "Lead with the benefit for the reader, then the practical details (date, time, place). One clear call to action per email. Keep subjects under 50 characters and preheaders under 90. Mention member advantages only when they apply to the audience. No medical promises or health claims; speak about feeling stronger, fitter and more energetic. Write each language natively instead of translating word for word.",
  do_not_say: ["miracle", "guaranteed results", "lose weight fast", "cure", "last chance", "act now", "100% free"],
  sample_phrases: [
    { "nl-BE": "Klaar om je sterker te voelen?", "fr-BE": "Prêt à vous sentir plus fort ?", en: "Ready to feel stronger?" },
    { "nl-BE": "We zien je graag in BEAM.", "fr-BE": "Au plaisir de vous voir chez BEAM.", en: "We look forward to seeing you at BEAM." },
    { "nl-BE": "Reserveer je plek in de app of op onze website.", "fr-BE": "Réservez votre place dans l'app ou sur notre site.", en: "Book your spot in the app or on our website." },
  ],
} as const satisfies { tone_of_voice: string; guidelines: string; do_not_say: readonly string[]; sample_phrases: readonly LocalizedText[] };

/** Writes `settings.email_brand` unless a row exists (a staff edit survives every reseed). */
export async function insertEmailBrandDefaults(db: DbOrTx): Promise<void> {
  await db
    .insert(settings)
    .values({ key: "email_brand", value: { ...EMAIL_BRAND_DEFAULTS, do_not_say: [...EMAIL_BRAND_DEFAULTS.do_not_say], sample_phrases: EMAIL_BRAND_DEFAULTS.sample_phrases.map((p) => ({ ...p })) } })
    .onConflictDoNothing({ target: settings.key });
}

export type SystemTemplateInput = {
  /** The registry key `<module>.<name>`. */
  slug: string;
  name: string;
  description?: string | null;
  /** Version 1 copy per slot, from the owning module's catalogue. */
  copy: Record<string, LocalizedText>;
  /** The subject per locale (the `subject` slot). */
  subject: LocalizedText;
  preheader?: LocalizedText;
  locales?: readonly string[];
};

export type SeededTemplateInput = {
  slug: string;
  name: string;
  kind: "transactional" | "marketing";
  purpose: "newsletter" | "events" | "member_comms" | "b2b" | null;
  subject: LocalizedText;
  preheader: LocalizedText;
  document: BlockDocument;
};

async function existingTemplate(db: DbOrTx, slug: string): Promise<string | null> {
  const [row] = await db.select({ id: emailTemplates.id }).from(emailTemplates).where(eq(emailTemplates.slug, slug));
  return row?.id ?? null;
}

async function publishVersionOne(
  db: DbOrTx,
  templateId: string,
  version: Omit<typeof emailTemplateVersions.$inferInsert, "templateId" | "version" | "publishedAt">,
): Promise<void> {
  const [v] = await db
    .insert(emailTemplateVersions)
    .values({ ...version, templateId, version: 1, publishedAt: new Date() })
    .returning({ id: emailTemplateVersions.id });
  await db.update(emailTemplates).set({ currentVersionId: v!.id, status: "published", updatedAt: new Date() }).where(eq(emailTemplates.id, templateId));
}

/**
 * Creates the system row and published version 1 of a code-backed registry template; an
 * existing slug is left untouched (`created: false`).
 */
export async function insertSystemTemplate(db: DbOrTx, input: SystemTemplateInput): Promise<{ templateId: string; created: boolean }> {
  const existing = await existingTemplate(db, input.slug);
  if (existing) return { templateId: existing, created: false };
  const [row] = await db
    .insert(emailTemplates)
    .values({ slug: input.slug, name: input.name, description: input.description ?? null, kind: "transactional", purpose: null, isSystem: true, status: "draft" })
    .onConflictDoNothing({ target: emailTemplates.slug })
    .returning({ id: emailTemplates.id });
  if (!row) return { templateId: (await existingTemplate(db, input.slug))!, created: false };
  await publishVersionOne(db, row.id, {
    subject: input.subject,
    preheader: input.preheader ?? {},
    copy: input.copy,
    reactComponent: input.slug,
    document: null,
    locales: [...(input.locales ?? ALL_LOCALES)],
  });
  return { templateId: row.id, created: true };
}

/**
 * Creates a block-backed template with a published version 1 when the slug is absent (the
 * `seedTemplate()` api of automation and webinar); never touches an existing slug.
 */
export async function insertSeededTemplate(db: DbOrTx, input: SeededTemplateInput): Promise<{ templateId: string; created: boolean }> {
  const existing = await existingTemplate(db, input.slug);
  if (existing) return { templateId: existing, created: false };
  const [row] = await db
    .insert(emailTemplates)
    .values({
      slug: input.slug,
      name: input.name,
      kind: input.kind,
      purpose: input.kind === "marketing" ? input.purpose : null,
      isSystem: input.kind === "transactional",
      status: "draft",
    })
    .onConflictDoNothing({ target: emailTemplates.slug })
    .returning({ id: emailTemplates.id });
  if (!row) return { templateId: (await existingTemplate(db, input.slug))!, created: false };
  const locales = ALL_LOCALES.filter((l) => (input.document.locales[l]?.length ?? 0) > 0);
  await publishVersionOne(db, row.id, {
    subject: input.subject,
    preheader: input.preheader,
    document: input.document,
    copy: null,
    reactComponent: null,
    locales,
  });
  return { templateId: row.id, created: true };
}

export const seed: DefaultSeed = {
  after: ["platform", "ops"],
  run: async (db) => {
    await insertRetentionPolicies(db, EMAIL_RETENTION_POLICIES);
    await insertEmailBrandDefaults(db);
  },
};
