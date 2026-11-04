/**
 * The template store's writes and reads (email spec rules 5, 9 to 15b, 21, 22, 60; actions
 * `createTemplate`, `saveTemplateDraft`, `publishTemplateVersion`, `archiveTemplate`,
 * `duplicateTemplate`, `sendTestEmail`; queries `listTemplates`, `getTemplate`), email-P5.
 *
 * - A template has at most one draft (`published_at is null`). The first save of a published
 *   template inserts the draft `version = max + 1` copied from the current version; a published
 *   row is never updated (`assertDraftVersion()` runs before every write).
 * - Saving checks `draftUpdatedAt` against the draft (or, while no draft exists, against the
 *   current version the editor read) and answers `conflict` when stale.
 * - Publishing requires subject, preheader and every text slot in all three locales (the
 *   validation lists `locale:path` items), known tokens and merge fields only, and for marketing
 *   templates the legal footer data of rule 5. Block-backed versions are compiled with MJML strict
 *   once per locale and dynamic variant into `html_by_locale` and `text_by_locale`;
 *   accessibility, size, card and image warnings are returned and never block.
 * - Archiving refuses system templates and templates a scheduled, sending or paused campaign or
 *   an active automation version references.
 * - A test send writes one `kind = test` message per locale and address (staff addresses only,
 *   no link token, no timeline event) and sets `campaigns.test_sent_at` when a campaign is named.
 */
import type { DbOrTx } from "@beam/db";
import { campaigns, emailTemplates, emailTemplateVersions, files, persons, users } from "@beam/db/schema";
import { ForbiddenError, NotImplementedError } from "@beam/core/errors";
import {
  assertDraftVersion,
  completenessIssues,
  draftCopyOf,
  draftIsCurrent,
  emptyDocument,
  fromDomainOf,
  MARKETING_SLUG_PATTERN,
  nextVersionNumber,
  templateCompleteness,
  validateDocument,
  walkBlocks,
  type BlockDocument,
  type CreateTemplateInput,
  type DuplicateTemplateInput,
  type LocaleCompleteness,
  type MarketingPurpose,
  type SaveTemplateDraftInput,
  type SendTestEmailInput,
} from "@beam/core/email";
import { LOCALES, lookupMessage, MESSAGES, type Locale, type LocalizedText } from "@beam/core/i18n";
import { footerProblems } from "@beam/email";
import { CompileError, compileMarketing, type Warning } from "@beam/email/blocks";
import { actorHasPermission, and, ConflictError, desc, eq, inArray, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { isTemplateInUse } from "@/modules/automation/api";
import { loadSendSettings } from "./context";
import { mergeFieldNames, mergeFieldProblems } from "./merge-fields";
import { resolveCardsFor, templateFooter, type PreviewWarning } from "./preview";
import { queueMessage, SEND_PRIORITY } from "./send";
import { registryTemplate, type TemplateRow, type VersionRow } from "./templates-info";

/** A referenced image above this size adds a publish warning (rule 22). */
export const IMAGE_WARN_BYTES = 1024 * 1024;

/** Campaign states that keep a template from being archived (rule 15). */
export const ACTIVE_CAMPAIGN_STATUSES = ["scheduled", "sending", "paused"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function lockTemplate(tx: DbOrTx, templateId: string): Promise<TemplateRow> {
  const [row] = await tx.select().from(emailTemplates).where(eq(emailTemplates.id, templateId)).for("update");
  if (!row) throw new NotFoundError("template_not_found");
  return row;
}

export async function draftVersionOf(tx: DbOrTx, templateId: string): Promise<VersionRow | null> {
  const [row] = await tx
    .select()
    .from(emailTemplateVersions)
    .where(and(eq(emailTemplateVersions.templateId, templateId), sql`${emailTemplateVersions.publishedAt} is null`));
  return row ?? null;
}

export async function versionById(tx: DbOrTx, versionId: string | null): Promise<VersionRow | null> {
  if (!versionId) return null;
  const [row] = await tx.select().from(emailTemplateVersions).where(eq(emailTemplateVersions.id, versionId));
  return row ?? null;
}

/** `Hello World!` -> `hello-world`; at least three characters (`tpl-...` otherwise). */
export function slugFromName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/g, "");
  return base.length >= 3 && MARKETING_SLUG_PATTERN.test(base) ? base : `tpl-${base || "template"}`.slice(0, 70);
}

/** The first free slug of `base`, `base-2`, `base-3`, ... */
async function uniqueSlug(tx: DbOrTx, base: string): Promise<string> {
  const rows = await tx
    .select({ slug: emailTemplates.slug })
    .from(emailTemplates)
    .where(sql`${emailTemplates.slug} = ${base} or ${emailTemplates.slug} like ${`${base}-%`}`);
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** A draft's `updated_at` moves strictly forward, so a client holding the old value always gets `conflict`. */
function nextUpdatedAt(previous: Date, now: Date): Date {
  return now.getTime() > previous.getTime() ? now : new Date(previous.getTime() + 1);
}

function staffUserId(ctx: Ctx): string | null {
  return ctx.actor.kind === "staff" ? ctx.actor.userId : null;
}

/** The registry slots of a code-backed version (`subject` and `preheader` slots are the columns). */
export function slotKeysOf(version: Pick<VersionRow, "reactComponent">): string[] {
  const def = version.reactComponent ? registryTemplate(version.reactComponent) : null;
  return def ? Object.keys(def.slots).sort() : [];
}

/** The catalogue default of each slot per locale (`<m>.email.<name>.<slot>`). */
export function slotDefaults(version: Pick<VersionRow, "reactComponent">): Record<string, LocalizedText> {
  const def = version.reactComponent ? registryTemplate(version.reactComponent) : null;
  const out: Record<string, LocalizedText> = {};
  for (const [slot, key] of Object.entries(def?.slots ?? {})) {
    const text: LocalizedText = {};
    for (const locale of LOCALES) {
      const value = lookupMessage(MESSAGES, locale, key);
      if (typeof value === "string" && value.trim()) text[locale] = value;
    }
    out[slot] = text;
  }
  return out;
}

/** Edited copy over the catalogue defaults: what a code-backed version renders. */
function effectiveCopy(version: Pick<VersionRow, "reactComponent" | "copy">): Record<string, LocalizedText> {
  const defaults = slotDefaults(version);
  const out: Record<string, LocalizedText> = {};
  for (const slot of new Set([...Object.keys(defaults), ...Object.keys(version.copy ?? {})])) {
    const edited = version.copy?.[slot] ?? {};
    const merged: LocalizedText = { ...defaults[slot] };
    for (const locale of LOCALES) if (edited[locale]?.trim()) merged[locale] = edited[locale];
    out[slot] = merged;
  }
  return out;
}

/** Completeness of a version in `locales` (rule 10); code-backed slots count their catalogue default. */
export function versionCompleteness(version: Pick<VersionRow, "subject" | "preheader" | "document" | "copy" | "reactComponent">, locales: readonly Locale[] = LOCALES): LocaleCompleteness[] {
  if (version.reactComponent) {
    return templateCompleteness({ subject: version.subject, preheader: version.preheader, copy: effectiveCopy(version) }, locales, { slots: slotKeysOf(version) });
  }
  return templateCompleteness({ subject: version.subject, preheader: version.preheader, document: version.document ?? emptyDocument() }, locales);
}

/** Every text of a version that may hold tokens (rule 13). */
export function versionTexts(version: Pick<VersionRow, "subject" | "preheader" | "document" | "copy">): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.includes("{{")) out.push(v);
  };
  for (const t of [version.subject, version.preheader, ...Object.values(version.copy ?? {})]) for (const v of Object.values(t ?? {})) push(v);
  for (const blocks of Object.values(version.document?.locales ?? {})) {
    walkBlocks(blocks ?? [], (b) => {
      if (b.type === "heading") push(b.text);
      else if (b.type === "text") push(b.markdown);
      else if (b.type === "button") {
        push(b.label);
        push(b.href);
      } else if (b.type === "image") {
        push(b.alt);
        push(b.href);
      }
      else if (b.type === "product" || b.type === "event") push(b.ctaLabel);
    });
  }
  return out;
}

/** The image file ids of a document (every locale and variant). */
export function documentImageIds(doc: BlockDocument | null | undefined): string[] {
  const ids = new Set<string>();
  for (const blocks of Object.values(doc?.locales ?? {})) walkBlocks(blocks ?? [], (b) => void (b.type === "image" && ids.add(b.fileId)));
  return [...ids];
}

function issuesToFields(items: readonly string[], value: string): Record<string, string> {
  return Object.fromEntries(items.map((i) => [i, value]));
}

// ---------------------------------------------------------------------------
// createTemplate, saveTemplateDraft
// ---------------------------------------------------------------------------

/** A marketing template with an empty draft version 1 (status `draft` until the first publish). */
export async function createTemplateRecord(ctx: Ctx, input: CreateTemplateInput): Promise<{ templateId: string; draftVersionId: string }> {
  const tx = ctx.tx;
  const slug = input.slug ?? (await uniqueSlug(tx, slugFromName(input.name)));
  if (input.slug) {
    const [taken] = await tx.select({ id: emailTemplates.id }).from(emailTemplates).where(eq(emailTemplates.slug, input.slug));
    if (taken) throw new ValidationError("slug_taken", { slug: "slug_taken" });
  }
  const createdByUserId = staffUserId(ctx);
  const [template] = await tx
    .insert(emailTemplates)
    .values({ slug, name: input.name, kind: "marketing", purpose: input.purpose, status: "draft", isSystem: false, createdByUserId })
    .returning({ id: emailTemplates.id });
  const [draft] = await tx
    .insert(emailTemplateVersions)
    .values({ templateId: template!.id, version: 1, subject: {}, preheader: {}, document: emptyDocument(), copy: null, reactComponent: null, locales: [], createdByUserId })
    .returning({ id: emailTemplateVersions.id });
  await ctx.audit({ action: "email.template_create", entityType: "email_template", entityId: template!.id, newValue: { slug, name: input.name, kind: "marketing", purpose: input.purpose } });
  return { templateId: template!.id, draftVersionId: draft!.id };
}

/** The editable draft of a locked template: the existing one, or a copy of the current version (rule 11). */
async function ensureDraft(ctx: Ctx, template: TemplateRow, draftUpdatedAt: Date): Promise<VersionRow> {
  const tx = ctx.tx;
  const draft = await draftVersionOf(tx, template.id);
  if (draft) {
    if (!draftIsCurrent(draft, draftUpdatedAt)) throw new ConflictError("draft_changed");
    return draft;
  }
  const current = await versionById(tx, template.currentVersionId);
  if (!current) throw new NotFoundError("version_not_found");
  if (!draftIsCurrent(current, draftUpdatedAt)) throw new ConflictError("draft_changed");
  const numbers = await tx.select({ version: emailTemplateVersions.version }).from(emailTemplateVersions).where(eq(emailTemplateVersions.templateId, template.id));
  const copy = draftCopyOf(current, nextVersionNumber(numbers.map((n) => n.version)));
  const [row] = await tx
    .insert(emailTemplateVersions)
    .values({
      templateId: template.id,
      version: copy.version,
      subject: copy.subject,
      preheader: copy.preheader,
      document: copy.document,
      copy: copy.copy,
      reactComponent: copy.reactComponent,
      locales: [],
      createdByUserId: staffUserId(ctx),
      createdAt: ctx.now,
      updatedAt: current.updatedAt,
    })
    .returning();
  return row!;
}

export type SaveDraftResult = { draftVersionId: string; updatedAt: Date; completeness: LocaleCompleteness[] };

export async function saveTemplateDraftRecord(ctx: Ctx, input: SaveTemplateDraftInput): Promise<SaveDraftResult> {
  const tx = ctx.tx;
  const template = await lockTemplate(tx, input.templateId);
  if (template.status === "archived") throw new ValidationError("template_archived", { templateId: "template_archived" });
  const draft = await ensureDraft(ctx, template, input.draftUpdatedAt);
  assertDraftVersion(draft);

  const patch: Partial<typeof emailTemplateVersions.$inferInsert> = { subject: input.subject, preheader: input.preheader };
  if (draft.reactComponent) {
    if (input.document) throw new ValidationError("code_backed_template", { document: "not_block_backed" });
    const slots = slotKeysOf(draft);
    const unknown = Object.keys(input.copy ?? {}).filter((k) => !slots.includes(k));
    if (unknown.length) throw new ValidationError("unknown_slot", issuesToFields(unknown.map((k) => `copy.${k}`), "unknown_slot"));
    const copy: Record<string, LocalizedText> = { ...(draft.copy ?? {}), ...(input.copy ?? {}) };
    // The `subject` and `preheader` slots are the version's columns.
    if (slots.includes("subject")) copy.subject = input.subject;
    if (slots.includes("preheader")) copy.preheader = input.preheader;
    patch.copy = copy;
  } else {
    if (input.copy && Object.keys(input.copy).length) throw new ValidationError("block_backed_template", { copy: "not_code_backed" });
    if (input.document) {
      const checked = validateDocument(input.document);
      if (!checked.ok) {
        throw new ValidationError("invalid_document", Object.fromEntries(checked.issues.map((i) => [`${i.locale ?? "document"}:${i.blockId ?? i.path.join(".")}`, i.code])));
      }
      patch.document = input.document;
    }
  }
  const updatedAt = nextUpdatedAt(draft.updatedAt, ctx.now);
  const [saved] = await tx
    .update(emailTemplateVersions)
    .set({ ...patch, updatedAt })
    .where(and(eq(emailTemplateVersions.id, draft.id), sql`${emailTemplateVersions.publishedAt} is null`))
    .returning();
  if (!saved) throw new ConflictError("draft_changed");
  await tx.update(emailTemplates).set({ updatedAt: ctx.now }).where(eq(emailTemplates.id, template.id));
  return { draftVersionId: saved.id, updatedAt: saved.updatedAt, completeness: versionCompleteness(saved) };
}

// ---------------------------------------------------------------------------
// publishTemplateVersion (rules 5, 10, 12, 13, 15b, 21, 22)
// ---------------------------------------------------------------------------

export type PublishResult = { versionId: string; version: number; warnings: PreviewWarning[] };

/** Compiles every locale of a block-backed draft; MJML errors become a `validation` per locale. */
async function compileForPublish(
  tx: DbOrTx,
  template: TemplateRow,
  draft: VersionRow,
  now: Date,
): Promise<{ htmlByLocale: Record<string, Record<string, string>>; textByLocale: Record<string, Record<string, string>>; warnings: Warning[] }> {
  const purpose: MarketingPurpose | "transactional" = template.kind === "marketing" && template.purpose ? template.purpose : "transactional";
  const settings = await loadSendSettings(tx);
  const htmlByLocale: Record<string, Record<string, string>> = {};
  const textByLocale: Record<string, Record<string, string>> = {};
  const warnings: Warning[] = [];
  const errors: Record<string, string> = {};
  for (const locale of LOCALES) {
    // Links stay `{{preferences_url}}` / `{{unsubscribe_url}}` placeholders; each message fills its own.
    const { footer } = await templateFooter(tx, { settings, locale, purpose, personId: null, links: null });
    if (!footer) throw new ValidationError("footer_incomplete", { [`footer:${locale}`]: "footer_incomplete" });
    try {
      const subject = draft.subject[locale]?.trim();
      const preheader = draft.preheader[locale]?.trim();
      const result = await compileMarketing(draft.document!, locale, {
        footer,
        resolveCards: resolveCardsFor(tx, locale, now),
        ...(subject ? { subject } : {}),
        ...(preheader ? { preheader } : {}),
      });
      htmlByLocale[locale] = Object.fromEntries(Object.entries(result.variants).map(([k, v]) => [k, v.html]));
      textByLocale[locale] = Object.fromEntries(Object.entries(result.variants).map(([k, v]) => [k, v.text]));
      warnings.push(...result.warnings);
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      error.issues.forEach((issue, i) => (errors[`compile:${locale}:${i + 1}`] = `${issue.tagName} line ${issue.line}: ${issue.message}`.slice(0, 300)));
    }
  }
  if (Object.keys(errors).length) throw new ValidationError("compile_failed", errors);
  return { htmlByLocale, textByLocale, warnings };
}

export async function publishTemplateRecord(ctx: Ctx, input: { templateId: string; draftUpdatedAt: Date }): Promise<PublishResult> {
  const tx = ctx.tx;
  const template = await lockTemplate(tx, input.templateId);
  if (template.status === "archived") throw new ValidationError("template_archived", { templateId: "template_archived" });
  const draft = await draftVersionOf(tx, template.id);
  if (!draft) throw new ValidationError("no_draft", { templateId: "no_draft" });
  if (!draftIsCurrent(draft, input.draftUpdatedAt)) throw new ConflictError("draft_changed");
  assertDraftVersion(draft);
  if (template.kind === "marketing" && !draft.document) throw new ValidationError("marketing_requires_blocks", { document: "required" });

  // Rule 10: every locale complete; the validation lists `locale:path` items.
  const missing = completenessIssues(versionCompleteness(draft));
  if (missing.length) throw new ValidationError("template_incomplete", issuesToFields(missing, "missing"));

  // Rule 13: tokens are EMAIL_TOKENS members or registered merge fields.
  const unknown = mergeFieldProblems(versionTexts(draft));
  if (unknown.length) throw new ValidationError("unknown_token", issuesToFields(unknown.map((n) => `token:${n}`), "unknown_token"));

  // Rule 5: the legal footer data of a marketing template, in every locale.
  if (template.kind === "marketing" && template.purpose) {
    const settings = await loadSendSettings(tx);
    const problems = footerProblems({ company: settings.company, footerSettings: settings.footer, purpose: template.purpose, locales: LOCALES });
    if (problems.length) throw new ValidationError("footer_incomplete", issuesToFields(problems.map((p) => `footer:${p}`), "footer_incomplete"));
  }

  const warnings: PreviewWarning[] = [];
  let compiled: { htmlByLocale: Record<string, Record<string, string>> | null; textByLocale: Record<string, Record<string, string>> | null } = { htmlByLocale: null, textByLocale: null };
  if (draft.document) {
    const result = await compileForPublish(tx, template, draft, ctx.now);
    compiled = { htmlByLocale: result.htmlByLocale, textByLocale: result.textByLocale };
    warnings.push(...result.warnings);
    const imageIds = documentImageIds(draft.document);
    if (imageIds.length) {
      const big = await tx.select({ id: files.id, sizeBytes: files.sizeBytes }).from(files).where(and(inArray(files.id, imageIds), sql`${files.sizeBytes} > ${IMAGE_WARN_BYTES}`));
      for (const f of big) warnings.push({ code: "image_too_large", locale: "en", detail: `${f.id}:${Math.round(f.sizeBytes / 1024)} KB` });
    }
  }

  const [published] = await tx
    .update(emailTemplateVersions)
    .set({ publishedAt: ctx.now, locales: [...LOCALES], htmlByLocale: compiled.htmlByLocale, textByLocale: compiled.textByLocale, updatedAt: ctx.now })
    .where(and(eq(emailTemplateVersions.id, draft.id), sql`${emailTemplateVersions.publishedAt} is null`))
    .returning({ id: emailTemplateVersions.id, version: emailTemplateVersions.version });
  if (!published) throw new ConflictError("draft_changed");
  await tx.update(emailTemplates).set({ currentVersionId: published.id, status: "published", updatedAt: ctx.now }).where(eq(emailTemplates.id, template.id));
  await ctx.audit({
    action: "email.template_publish",
    entityType: "email_template",
    entityId: template.id,
    oldValue: { versionId: template.currentVersionId },
    newValue: { versionId: published.id, version: published.version, warnings: warnings.length },
  });
  return { versionId: published.id, version: published.version, warnings };
}

// ---------------------------------------------------------------------------
// archiveTemplate, duplicateTemplate
// ---------------------------------------------------------------------------

/** Campaigns that keep a template live (scheduled, sending, paused). */
async function activeCampaignsOf(tx: DbOrTx, templateId: string): Promise<{ id: string; name: string; status: string }[]> {
  return tx
    .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status })
    .from(campaigns)
    .where(and(eq(campaigns.templateId, templateId), inArray(campaigns.status, [...ACTIVE_CAMPAIGN_STATUSES])));
}

/** `automation.isTemplateInUse`; while automation's stub throws, the template counts as in use (rule 15). */
export async function usedByAutomation(tx: DbOrTx, slug: string): Promise<boolean> {
  try {
    return await isTemplateInUse(tx, slug);
  } catch (error) {
    if (error instanceof NotImplementedError) return true;
    throw error;
  }
}

export async function archiveTemplateRecord(ctx: Ctx, input: { templateId: string }): Promise<{ ok: true }> {
  const tx = ctx.tx;
  const template = await lockTemplate(tx, input.templateId);
  if (template.isSystem) throw new ValidationError("system_template", { templateId: "system_template" });
  if (template.status === "archived") return { ok: true };
  const active = await activeCampaignsOf(tx, template.id);
  if (active.length) throw new ValidationError("template_in_use", { campaigns: active.map((c) => c.name).join(", ") });
  if (await usedByAutomation(tx, template.slug)) throw new ValidationError("template_in_use", { automations: "in_use" });
  await tx.update(emailTemplates).set({ status: "archived", updatedAt: ctx.now }).where(eq(emailTemplates.id, template.id));
  await ctx.audit({ action: "email.template_archive", entityType: "email_template", entityId: template.id, oldValue: { status: template.status }, newValue: { status: "archived" } });
  return { ok: true };
}

/** A new marketing template whose draft version 1 copies the source's draft (or current) content. */
export async function duplicateTemplateRecord(ctx: Ctx, input: DuplicateTemplateInput): Promise<{ templateId: string }> {
  const tx = ctx.tx;
  const [source] = await tx.select().from(emailTemplates).where(eq(emailTemplates.id, input.templateId));
  if (!source) throw new NotFoundError("template_not_found");
  if (source.kind !== "marketing" || !source.purpose) throw new ValidationError("not_duplicable", { templateId: "transactional_template" });
  const content = (await draftVersionOf(tx, source.id)) ?? (await versionById(tx, source.currentVersionId));
  if (!content) throw new NotFoundError("version_not_found");
  const slug = await uniqueSlug(tx, slugFromName(input.name));
  const createdByUserId = staffUserId(ctx);
  const [template] = await tx
    .insert(emailTemplates)
    .values({ slug, name: input.name, description: source.description, kind: "marketing", purpose: source.purpose, status: "draft", createdByUserId })
    .returning({ id: emailTemplates.id });
  const copy = draftCopyOf(content, 1);
  await tx.insert(emailTemplateVersions).values({
    templateId: template!.id,
    version: 1,
    subject: copy.subject,
    preheader: copy.preheader,
    document: copy.document ?? emptyDocument(),
    copy: null,
    reactComponent: null,
    locales: [],
    createdByUserId,
  });
  await ctx.audit({ action: "email.template_create", entityType: "email_template", entityId: template!.id, newValue: { slug, name: input.name, duplicatedFrom: source.id } });
  return { templateId: template!.id };
}

// ---------------------------------------------------------------------------
// sendTestEmail (rule 60)
// ---------------------------------------------------------------------------

/** The addresses of `to` that are not `users.email` of an active staff user. */
export async function nonStaffAddresses(tx: DbOrTx, to: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(to.map((a) => a.trim().toLowerCase()))];
  if (!wanted.length) return [];
  const rows = await tx
    .select({ email: sql<string>`lower(${users.email})` })
    .from(users)
    .where(and(eq(users.audience, "staff"), eq(users.status, "active"), inArray(sql`lower(${users.email})`, wanted)));
  const staff = new Set(rows.map((r) => r.email));
  return wanted.filter((a) => !staff.has(a));
}

/** The persona of a test send, kept in the message's `context` for the renderer (ids and sample keys only). */
function personaContext(as: SendTestEmailInput["as"]): Record<string, string> {
  if ("personId" in as) return { test_as_person_id: as.personId };
  return { test_sample: as.sample, ...(as.assessmentOutcome ? { test_outcome: as.assessmentOutcome } : {}) };
}

export async function sendTestEmailRecord(ctx: Ctx, input: SendTestEmailInput): Promise<{ messageIds: string[] }> {
  const tx = ctx.tx;
  if ("personId" in input.as) {
    if (!actorHasPermission(ctx.actor, "persons.read")) throw new ForbiddenError("forbidden: persons.read", "persons.read");
    const [p] = await tx.select({ id: persons.id, erasedAt: persons.erasedAt }).from(persons).where(eq(persons.id, input.as.personId));
    if (!p || p.erasedAt) throw new NotFoundError("person_not_found");
  }
  const outsiders = await nonStaffAddresses(tx, input.to);
  if (outsiders.length) throw new ValidationError("not_staff_address", { to: "not_staff_address" });

  const [template] = await tx.select().from(emailTemplates).where(eq(emailTemplates.id, input.templateId));
  if (!template) throw new NotFoundError("template_not_found");
  const version = input.use === "draft" ? await draftVersionOf(tx, template.id) : await versionById(tx, template.currentVersionId);
  if (!version) throw new ValidationError(input.use === "draft" ? "no_draft" : "not_published", { use: input.use === "draft" ? "no_draft" : "not_published" });

  // A locale without subject or content cannot render (no fallback language, rule 41).
  const empty = input.locales.filter((l) => {
    const missing = versionCompleteness(version, [l])[0]?.missing ?? [];
    return missing.includes("subject") || missing.includes("document");
  });
  if (empty.length) throw new ValidationError("missing_translation", issuesToFields(empty.map((l) => `${l}:content`), "missing"));

  let campaignId: string | null = null;
  if (input.campaignId) {
    const [c] = await tx.select({ id: campaigns.id, templateId: campaigns.templateId }).from(campaigns).where(eq(campaigns.id, input.campaignId)).for("update");
    if (!c) throw new NotFoundError("campaign_not_found");
    if (c.templateId !== template.id) throw new ValidationError("campaign_template_mismatch", { campaignId: "campaign_template_mismatch" });
    campaignId = c.id;
  }

  const def = version.reactComponent ? registryTemplate(version.reactComponent) : null;
  const context = personaContext(input.as);
  const recipients = [...new Set(input.to.map((a) => a.trim().toLowerCase()))];
  const messageIds: string[] = [];
  let n = 0;
  for (const locale of input.locales) {
    for (const to of recipients) {
      n += 1;
      const queued = await queueMessage(
        ctx,
        {
          personId: null,
          toEmail: to,
          kind: "test",
          purpose: template.purpose ?? null,
          fromDomain: fromDomainOf(template.kind),
          templateVersionId: version.id,
          campaignId,
          locale,
          props: def?.sample ?? {},
          context,
          attachments: [],
          idempotencyKey: `test:${version.id}:${ctx.requestId}:${n}`,
          status: "queued",
        },
        { template: template.slug, priority: SEND_PRIORITY.transactional },
      );
      messageIds.push(queued.emailMessageId);
    }
  }
  if (campaignId) await tx.update(campaigns).set({ testSentAt: ctx.now, updatedAt: ctx.now }).where(eq(campaigns.id, campaignId));
  await ctx.audit({
    action: "email.test_send",
    entityType: campaignId ? "campaign" : "email_template",
    entityId: campaignId ?? template.id,
    newValue: { templateId: template.id, versionId: version.id, use: input.use, locales: input.locales, recipients: recipients.length, as: "personId" in input.as ? "person" : input.as.sample },
  });
  return { messageIds };
}

// ---------------------------------------------------------------------------
// Reads: listTemplates, getTemplate
// ---------------------------------------------------------------------------

export const TEMPLATES_PAGE_SIZE = 50;

export type TemplateListRow = {
  id: string;
  slug: string;
  name: string;
  kind: TemplateRow["kind"];
  purpose: MarketingPurpose | null;
  status: TemplateRow["status"];
  isSystem: boolean;
  module: string | null;
  currentVersion: number | null;
  locales: Locale[];
  lastPublishedAt: Date | null;
  hasDraft: boolean;
  updatedAt: Date;
};

export async function listTemplateRows(
  db: DbOrTx,
  input: { kind?: TemplateRow["kind"]; status?: TemplateRow["status"]; q?: string; module?: string; page?: number } = {},
): Promise<{ items: TemplateListRow[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const term = input.q?.trim();
  const where = and(
    input.kind ? eq(emailTemplates.kind, input.kind) : undefined,
    input.status ? eq(emailTemplates.status, input.status) : sql`${emailTemplates.status} <> 'archived'`,
    term ? sql`(${emailTemplates.name} ilike ${`%${term}%`} or ${emailTemplates.slug} ilike ${`%${term}%`})` : undefined,
    input.module ? sql`${emailTemplates.slug} like ${`${input.module}.%`}` : undefined,
  );
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(emailTemplates).where(where);
  const rows = await db
    .select({
      t: emailTemplates,
      currentVersion: emailTemplateVersions.version,
      locales: emailTemplateVersions.locales,
      publishedAt: emailTemplateVersions.publishedAt,
      hasDraft: sql<boolean>`exists (select 1 from email_template_versions d where d.template_id = ${emailTemplates.id} and d.published_at is null)`,
    })
    .from(emailTemplates)
    .leftJoin(emailTemplateVersions, eq(emailTemplateVersions.id, emailTemplates.currentVersionId))
    .where(where)
    .orderBy(emailTemplates.kind, emailTemplates.name, emailTemplates.id)
    .limit(TEMPLATES_PAGE_SIZE)
    .offset((page - 1) * TEMPLATES_PAGE_SIZE);
  const items = rows.map((r) => ({
    id: r.t.id,
    slug: r.t.slug,
    name: r.t.name,
    kind: r.t.kind,
    purpose: r.t.purpose ?? null,
    status: r.t.status,
    isSystem: r.t.isSystem,
    module: r.t.kind === "transactional" ? (r.t.slug.split(".")[0] ?? null) : null,
    currentVersion: r.currentVersion ?? null,
    locales: (r.locales ?? []).filter((l): l is Locale => (LOCALES as readonly string[]).includes(l)),
    lastPublishedAt: r.publishedAt ?? null,
    hasDraft: !!r.hasDraft,
    updatedAt: r.t.updatedAt,
  }));
  return { items, total: Number(total), page, pageSize: TEMPLATES_PAGE_SIZE };
}

/** The owning modules of transactional templates (the list's module filter). */
export async function transactionalModules(db: DbOrTx): Promise<string[]> {
  const rows = await db
    .selectDistinct({ m: sql<string>`split_part(${emailTemplates.slug}, '.', 1)` })
    .from(emailTemplates)
    .where(eq(emailTemplates.kind, "transactional"));
  return rows.map((r) => r.m).sort();
}

export type TemplateDetail = {
  template: TemplateRow;
  draft: VersionRow | null;
  current: VersionRow | null;
  /** The version the editor opens: the draft, else the current version. */
  editing: VersionRow | null;
  /** The `draftUpdatedAt` the next save must send. */
  draftUpdatedAt: Date | null;
  completeness: LocaleCompleteness[];
  references: { campaigns: { id: string; name: string; status: string }[]; automations: boolean | null };
  versions: { id: string; version: number; publishedAt: Date | null; createdAt: Date; createdByUserId: string | null }[];
  slots: string[];
  slotDefaults: Record<string, LocalizedText>;
  mergeFields: string[];
};

export async function loadTemplateDetail(db: DbOrTx, templateId: string): Promise<TemplateDetail | null> {
  const [template] = await db.select().from(emailTemplates).where(eq(emailTemplates.id, templateId));
  if (!template) return null;
  const [draft, current] = await Promise.all([draftVersionOf(db, template.id), versionById(db, template.currentVersionId)]);
  const editing = draft ?? current;
  let automations: boolean | null;
  try {
    automations = await isTemplateInUse(db, template.slug);
  } catch (error) {
    if (!(error instanceof NotImplementedError)) throw error;
    automations = null;
  }
  const versions = await db
    .select({
      id: emailTemplateVersions.id,
      version: emailTemplateVersions.version,
      publishedAt: emailTemplateVersions.publishedAt,
      createdAt: emailTemplateVersions.createdAt,
      createdByUserId: emailTemplateVersions.createdByUserId,
    })
    .from(emailTemplateVersions)
    .where(eq(emailTemplateVersions.templateId, template.id))
    .orderBy(desc(emailTemplateVersions.version));
  return {
    template,
    draft,
    current,
    editing,
    draftUpdatedAt: editing?.updatedAt ?? null,
    completeness: editing ? versionCompleteness(editing) : [],
    references: { campaigns: await activeCampaignsOf(db, template.id), automations },
    versions,
    slots: editing ? slotKeysOf(editing) : [],
    slotDefaults: editing ? slotDefaults(editing) : {},
    mergeFields: mergeFieldNames(),
  };
}

/** One version of a template (version history, read-only). */
export async function loadTemplateVersion(db: DbOrTx, templateId: string, versionId: string): Promise<VersionRow | null> {
  const [row] = await db
    .select()
    .from(emailTemplateVersions)
    .where(and(eq(emailTemplateVersions.id, versionId), eq(emailTemplateVersions.templateId, templateId)));
  return row ?? null;
}

