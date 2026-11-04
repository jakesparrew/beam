/**
 * Template lookups for other modules and for sending (email spec section 4 api, rules 15a, 39a).
 *
 * - `getTemplateInfo`, `getPublishedTemplateInfo`, `listPublishedTemplates`: the current
 *   published version of templates (automation's step editor and checks).
 * - `seedTemplate`: a block-backed template with published version 1 when the slug is absent.
 * - `systemTemplateInput(key)` / `ensureSystemTemplate(tx, key)`: the system row of a registry
 *   template, with version 1 copy from the owning module's catalogue (`<m>.email.<name>.<slot>`).
 *   Only plain messages are copied; a slot whose catalogue text uses ICU plural or select syntax
 *   stays on the catalogue (the editor's copy is plain text with simple `{name}` tokens).
 * - `loadSendTemplate(tx, ...)`: what `email.send` renders: the version row and its template, or
 *   the registry entry alone while the system row is not seeded.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { emailTemplates, emailTemplateVersions } from "@beam/db/schema";
import { insertSeededTemplate, insertSystemTemplate, type SystemTemplateInput } from "@beam/db/seed/email";
import type { MarketingPurpose, SeedTemplateInput, TemplateInfo } from "@beam/core/email";
import { isLocale, LOCALES, lookupMessage, MESSAGES, type Locale, type LocalizedText } from "@beam/core/i18n";
import type { TemplateDef } from "@beam/email/templates/define";
import { TEMPLATE_REGISTRY } from "@beam/email/templates/registry";
import { and, asc, eq, inArray, isNotNull, sql } from "@/lib/ctx";

export type TemplateRow = typeof emailTemplates.$inferSelect;
export type VersionRow = typeof emailTemplateVersions.$inferSelect;

/** The registry entry of a key, or null. */
export function registryTemplate(key: string): TemplateDef | null {
  return (TEMPLATE_REGISTRY as Readonly<Record<string, TemplateDef | undefined>>)[key] ?? null;
}

export function registryKeys(): string[] {
  return Object.keys(TEMPLATE_REGISTRY).sort();
}

const localesOf = (v: readonly string[]): Locale[] => v.filter(isLocale);

function infoOf(t: Pick<TemplateRow, "kind" | "purpose">, v: Pick<VersionRow, "id" | "locales">): TemplateInfo {
  return { templateVersionId: v.id, kind: t.kind, purpose: (t.purpose) ?? null, locales: localesOf(v.locales) };
}

async function currentRows(db: DbOrTx, slugs: readonly string[]) {
  if (!slugs.length) return [];
  return db
    .select({ template: emailTemplates, version: emailTemplateVersions })
    .from(emailTemplates)
    .innerJoin(emailTemplateVersions, eq(emailTemplateVersions.id, emailTemplates.currentVersionId))
    .where(and(inArray(emailTemplates.slug, [...slugs]), isNotNull(emailTemplateVersions.publishedAt)));
}

export async function getTemplateInfo(db: DbOrTx, slug: string): Promise<TemplateInfo | null> {
  const [row] = await currentRows(db, [slug]);
  return row && row.template.status !== "archived" ? infoOf(row.template, row.version) : null;
}

export async function getPublishedTemplateInfo(db: DbOrTx, slugs: string[]): Promise<Map<string, TemplateInfo>> {
  const out = new Map<string, TemplateInfo>();
  for (const row of await currentRows(db, [...new Set(slugs)])) {
    if (row.template.status !== "archived") out.set(row.template.slug, infoOf(row.template, row.version));
  }
  return out;
}

export async function listPublishedTemplates(
  db: DbOrTx,
  q?: string,
): Promise<{ slug: string; name: string; kind: TemplateRow["kind"]; purpose: MarketingPurpose | null; locales: Locale[] }[]> {
  const term = q?.trim();
  const rows = await db
    .select({ slug: emailTemplates.slug, name: emailTemplates.name, kind: emailTemplates.kind, purpose: emailTemplates.purpose, locales: emailTemplateVersions.locales })
    .from(emailTemplates)
    .innerJoin(emailTemplateVersions, eq(emailTemplateVersions.id, emailTemplates.currentVersionId))
    .where(
      and(
        eq(emailTemplates.status, "published"),
        isNotNull(emailTemplateVersions.publishedAt),
        term ? sql`(${emailTemplates.slug} ilike ${`%${term}%`} or ${emailTemplates.name} ilike ${`%${term}%`})` : undefined,
      ),
    )
    .orderBy(asc(emailTemplates.slug));
  return rows.map((r) => ({ slug: r.slug, name: r.name, kind: r.kind, purpose: (r.purpose) ?? null, locales: localesOf(r.locales) }));
}

export function seedTemplate(tx: Tx, input: SeedTemplateInput): Promise<{ templateId: string; created: boolean }> {
  return insertSeededTemplate(tx, input);
}

const ICU_COMPLEX = /\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*,\s*(plural|select|selectordinal)\s*,/;

/** The staff-facing name of a registry key (`booking.booking_confirmed` -> `Booking: booking confirmed`). */
export function systemTemplateName(key: string): string {
  const [m, name] = key.split(".", 2) as [string, string];
  return `${m.charAt(0).toUpperCase()}${m.slice(1)}: ${name.replace(/_/g, " ")}`;
}

/** Version 1 of a registry template's system row, from the owning catalogue. */
export function systemTemplateInput(key: string, def: TemplateDef): SystemTemplateInput {
  const copy: Record<string, LocalizedText> = {};
  const complete = new Set<Locale>(LOCALES);
  for (const [slot, messageKey] of Object.entries(def.slots)) {
    const text: LocalizedText = {};
    for (const locale of LOCALES) {
      const value = lookupMessage(MESSAGES, locale, messageKey);
      if (typeof value === "string" && value.trim() && !ICU_COMPLEX.test(value)) text[locale] = value;
      else if (!(typeof value === "string" && value.trim())) complete.delete(locale);
    }
    copy[slot] = text;
  }
  return {
    slug: key,
    name: systemTemplateName(key),
    copy,
    subject: copy.subject ?? {},
    preheader: copy.preheader ?? {},
    locales: LOCALES.filter((l) => complete.has(l)),
  };
}

/** The system row of a registry key, created from the catalogue when absent. */
export async function ensureSystemTemplate(tx: DbOrTx, key: string): Promise<{ templateId: string; created: boolean } | null> {
  const def = registryTemplate(key);
  if (!def) return null;
  return insertSystemTemplate(tx, systemTemplateInput(key, def));
}

export type SendTemplate = {
  /** The template slug or registry key. */
  key: string;
  kind: "transactional" | "marketing";
  purpose: MarketingPurpose | null;
  template: TemplateRow | null;
  version: VersionRow | null;
  /** The registry entry of a code-backed template. */
  def: TemplateDef | null;
};

/** The template of a message: its version row when set, else the registry entry of `key`. */
export async function loadSendTemplate(tx: DbOrTx, input: { templateVersionId: string | null; key: string }): Promise<SendTemplate | null> {
  if (input.templateVersionId) {
    const [row] = await tx
      .select({ template: emailTemplates, version: emailTemplateVersions })
      .from(emailTemplateVersions)
      .innerJoin(emailTemplates, eq(emailTemplates.id, emailTemplateVersions.templateId))
      .where(eq(emailTemplateVersions.id, input.templateVersionId));
    if (!row) return null;
    const def = row.version.reactComponent ? registryTemplate(row.version.reactComponent) : null;
    if (row.version.reactComponent && !def) return null;
    return { key: row.template.slug, kind: row.template.kind, purpose: (row.template.purpose) ?? null, template: row.template, version: row.version, def };
  }
  const def = registryTemplate(input.key);
  if (!def) return null;
  return { key: input.key, kind: "transactional", purpose: null, template: null, version: null, def };
}

/** The current published version of a slug (any kind), or null. */
export async function currentVersionOf(tx: DbOrTx, slug: string): Promise<{ template: TemplateRow; version: VersionRow } | null> {
  const [row] = await currentRows(tx, [slug]);
  return row && row.template.status !== "archived" ? row : null;
}
