"use server";
/**
 * forms Server Actions (forms spec section 4 "Server actions", `audience: 'staff'` unless stated):
 * create, edit, save drafts, publish, archive, unarchive, delete and duplicate forms, and manage
 * tracked links (forms-P5); reveal sensitive answers, resend the result email, revoke the result
 * link, delete a submission, start a staff-assisted entry and the public `requestResultLink`
 * (forms-P6). The status machine is rule P12 and the system slugs rule P13. Every handler
 * writes its own audit row with the spec's audit name (`forms.created`, `forms.draft_saved`, ...),
 * so the wrapper's automatic row is off: one audit row per staff action. Draft and publish audits
 * carry definition hashes and version numbers only, never the definition JSON. Version writes go
 * through `service/versions.ts`, which never updates a published row.
 */
import { z } from "zod";
import { formLinks, forms, formSubmissions, formVersions, formViewsDaily } from "@beam/db/schema";
import {
  defaultSettings,
  FORM_KINDS,
  findRange,
  FORM_LINK_CHANNELS,
  FormDefinition as FormDefinitionSchema,
  FormResultProps,
  FormScoring as FormScoringSchema,
  SYSTEM_FORM_SLUGS,
  validateForPublish,
  type FormDefinition,
  type FormKind,
  type FormScoring,
  type PublishIssue,
} from "@beam/core/forms";
import { formatNumber, LOCALES, LocalizedTextSchema, type Locale, type LocalizedText } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { and, ConflictError, eq, isNotNull, isNull, NotFoundError, sql, ValidationError, type Ctx, type DbOrTx } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getPersonPrefill } from "@/modules/crm/api";
import { sendTransactional } from "@/modules/email/api";
import { countResends, linkLocale, resendKeyPrefix } from "./queries";
import { answerText } from "./service/export-csv";
import { newLinkKey, trackedLinkUrl } from "./service/qr";
import { readSubmissionAnswers } from "./service/sensitive";
import { createStaffEntryUrl, requestResultLink as requestResultLinkService } from "./service/submissions";
import { createResultToken, ctaRedirectUrl, hashToken, RESULT_TOKEN_DAYS, resultPageUrl } from "./service/tokens";
import { copyToDraft, insertDraftVersion, parseVersion, publishVersion as publishService, updateDraftVersion } from "./service/versions";

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED_SLUGS = ["result", "import"];
const isSystemSlug = (slug: string) => (SYSTEM_FORM_SLUGS as readonly string[]).includes(slug);

const Slug = z
  .string()
  .trim()
  .max(64, "too_long")
  .regex(SLUG_RE, "invalid_slug")
  .refine((s) => !RESERVED_SLUGS.includes(s), "reserved_slug");
const Locales = z.array(z.enum(LOCALES)).min(1).max(3).transform((l) => [...new Set(l)] as Locale[]);
const Name = LocalizedTextSchema;
const Uuid = z.uuid();
const Utm = z
  .object({ source: z.string().max(100), medium: z.string().max(100), campaign: z.string().max(100), term: z.string().max(100), content: z.string().max(100) })
  .partial()
  .strict();

const staffUserId = (ctx: Ctx): string | null => (ctx.actor.kind === "staff" ? ctx.actor.userId : null);

async function lockForm(tx: DbOrTx, formId: string) {
  const [form] = await tx.select().from(forms).where(eq(forms.id, formId)).for("update");
  if (!form) throw new NotFoundError("form_not_found");
  return form;
}

async function assertSlugFree(tx: DbOrTx, slug: string, field = "slug"): Promise<void> {
  const [taken] = await tx.select({ id: forms.id }).from(forms).where(eq(forms.slug, slug));
  if (taken) throw new ValidationError("slug_taken", { [field]: "slug_taken" });
}

async function everPublished(tx: DbOrTx, formId: string): Promise<boolean> {
  const [row] = await tx.select({ id: formVersions.id }).from(formVersions).where(and(eq(formVersions.formId, formId), isNotNull(formVersions.publishedAt))).limit(1);
  return !!row;
}

/** The starting content of a new form (`template`), with texts from the catalogue in each locale. */
function starterContent(kind: FormKind, template: "blank" | "lead" | "assessment", name: LocalizedText, locales: Locale[]): { definition: FormDefinition; scoring: FormScoring } {
  const L = (key: string): LocalizedText => Object.fromEntries(locales.map((l) => [l, translator(l)(`forms.builder.starter.${key}`)]));
  const settings = defaultSettings(kind, L("submit"));
  const thankYou = { key: "thank_you", kind: "thank_you" as const, title: L("thanks_title"), body: L("thanks_body"), showScore: false, showDimensions: [], ctas: [] };
  const base: FormDefinition = { title: { ...name }, settings, sections: [{ key: "s1", fieldKeys: [] }], fields: {}, logic: [], endings: [thankYou] };
  if (template === "blank") return { definition: { ...base, settings: { ...settings, sendResultEmail: false } }, scoring: { dimensions: [], outcomes: [] } };
  base.fields = {
    email: { key: "email", type: "email", label: L("email"), required: true, sensitive: false, mapsTo: "person.email" },
    first_name: { key: "first_name", type: "short_text", label: L("first_name"), required: false, sensitive: false, mapsTo: "person.first_name" },
  };
  base.sections[0]!.fieldKeys = ["email", "first_name"];
  if (template === "lead") {
    base.fields.newsletter = { key: "newsletter", type: "consent", purpose: "newsletter", label: L("newsletter_label"), wording: L("newsletter_wording"), required: false, sensitive: false };
    base.sections[0]!.fieldKeys.push("newsletter");
    return { definition: { ...base, settings: { ...settings, sendResultEmail: false } }, scoring: { dimensions: [], outcomes: [] } };
  }
  base.fields.q1 = { key: "q1", type: "rating", scale: 5, label: L("question"), required: true, sensitive: false, weights: { score: 1 } };
  base.sections.push({ key: "s2", title: L("questions"), fieldKeys: ["q1"] });
  base.endings = [
    {
      key: "result",
      kind: "result",
      title: L("result_title"),
      body: L("result_body"),
      showScore: true,
      showDimensions: ["score"],
      ctas: [],
      email: { subject: L("email_subject"), intro: L("email_intro") },
    },
  ];
  const scoring: FormScoring = {
    dimensions: [
      {
        key: "score",
        label: L("dimension"),
        kind: "sum",
        ranges: [
          { key: "low", from: 0, to: 3, label: L("range_low") },
          { key: "high", from: 3, to: 5, label: L("range_high") },
        ],
      },
    ],
    outcomes: [],
  };
  return { definition: { ...base, settings: { ...settings, sendResultEmail: true } }, scoring };
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

const CreateFormInput = z
  .object({ slug: Slug, kind: z.enum(FORM_KINDS), name: Name, locales: Locales, template: z.enum(["blank", "lead", "assessment"]).optional() })
  .strict();

/** P12 `(none) -> draft`: a new draft form with version 1 from a template. */
export const createForm = action(
  { name: "forms.create", audience: "staff", permission: "forms.write", input: CreateFormInput, audit: false },
  async (ctx, i): Promise<{ formId: string; versionId: string }> => {
    await assertSlugFree(ctx.tx, i.slug);
    const userId = staffUserId(ctx);
    const [form] = await ctx.tx
      .insert(forms)
      .values({ slug: i.slug, kind: i.kind, name: i.name, status: "draft", createdByUserId: userId })
      .onConflictDoNothing({ target: forms.slug })
      .returning({ id: forms.id });
    if (!form) throw new ValidationError("slug_taken", { slug: "slug_taken" });
    const content = starterContent(i.kind, i.template ?? "blank", i.name, i.locales);
    const v = await insertDraftVersion(ctx.tx, { formId: form.id, version: 1, ...content, locales: i.locales, createdByUserId: userId });
    await ctx.audit({ action: "forms.created", entityType: "form", entityId: form.id, newValue: { slug: i.slug, kind: i.kind, locales: i.locales, template: i.template ?? "blank", definitionHash: v.definitionHash } });
    return { formId: form.id, versionId: v.versionId };
  },
);

const UpdateFormMetaInput = z
  .object({ formId: Uuid, slug: Slug.optional(), name: Name.optional(), description: z.string().trim().max(2000).nullable().optional() })
  .strict();

/** Name, internal note and (P13: only while never published and never for a system form) slug. */
export const updateFormMeta = action(
  { name: "forms.update_meta", audience: "staff", permission: "forms.write", input: UpdateFormMetaInput, audit: false },
  async (ctx, i): Promise<{ ok: true }> => {
    const form = await lockForm(ctx.tx, i.formId);
    const patch: Partial<typeof forms.$inferInsert> = {};
    if (i.slug !== undefined && i.slug !== form.slug) {
      if (isSystemSlug(form.slug)) throw new ConflictError("system_form_slug");
      if (await everPublished(ctx.tx, form.id)) throw new ConflictError("slug_locked_after_publish");
      await assertSlugFree(ctx.tx, i.slug);
      patch.slug = i.slug;
    }
    if (i.name !== undefined) patch.name = i.name;
    if (i.description !== undefined) patch.description = i.description || null;
    if (!Object.keys(patch).length) return { ok: true };
    await ctx.tx.update(forms).set({ ...patch, updatedAt: ctx.now }).where(eq(forms.id, form.id));
    await ctx.audit({
      action: "forms.updated",
      entityType: "form",
      entityId: form.id,
      oldValue: { slug: form.slug, name: form.name, description: form.description },
      newValue: { slug: patch.slug ?? form.slug, name: patch.name ?? form.name, description: patch.description !== undefined ? patch.description : form.description },
    });
    return { ok: true };
  },
);

const SaveDraftInput = z
  .object({
    formId: Uuid,
    versionId: Uuid,
    definition: FormDefinitionSchema,
    scoring: FormScoringSchema,
    locales: Locales,
    changeNote: z.string().trim().max(500).nullable().optional(),
    expectedHash: z.string().min(1),
  })
  .strict();

/** Saves the draft (autosave). `conflict` when another editor saved since `expectedHash`. */
export const saveDraft = action(
  { name: "forms.save_draft", audience: "staff", permission: "forms.write", input: SaveDraftInput, audit: false },
  async (ctx, i): Promise<{ definitionHash: string; issues: PublishIssue[] }> => {
    const [form] = await ctx.tx.select().from(forms).where(eq(forms.id, i.formId));
    if (!form) throw new NotFoundError("form_not_found");
    const [row] = await ctx.tx.select({ id: formVersions.id, publishedAt: formVersions.publishedAt }).from(formVersions).where(and(eq(formVersions.id, i.versionId), eq(formVersions.formId, i.formId)));
    if (!row) throw new NotFoundError("version_not_found");
    if (row.publishedAt) throw new ConflictError("version_published");
    const r = await updateDraftVersion(ctx.tx, {
      versionId: i.versionId,
      definition: i.definition,
      scoring: i.scoring,
      locales: i.locales,
      expectedHash: i.expectedHash,
      ...(i.changeNote !== undefined ? { changeNote: i.changeNote } : {}),
    });
    await ctx.tx.update(forms).set({ updatedAt: ctx.now }).where(eq(forms.id, i.formId));
    if (r.definitionHash !== i.expectedHash) {
      await ctx.audit({ action: "forms.draft_saved", entityType: "form_version", entityId: i.versionId, oldValue: { definitionHash: i.expectedHash }, newValue: { definitionHash: r.definitionHash } });
    }
    return { definitionHash: r.definitionHash, issues: validateForPublish(form.kind, i.definition, i.scoring, i.locales) };
  },
);

/** P9: a new draft copied from a version (default: the current one); `conflict` when a draft exists. */
export const createDraft = action(
  { name: "forms.create_draft", audience: "staff", permission: "forms.write", input: z.object({ formId: Uuid, fromVersionId: Uuid.optional() }).strict(), audit: false },
  async (ctx, i): Promise<{ versionId: string }> => {
    await lockForm(ctx.tx, i.formId);
    const r = await copyToDraft(ctx.tx, { formId: i.formId, fromVersionId: i.fromVersionId, createdByUserId: staffUserId(ctx) });
    await ctx.audit({ action: "forms.draft_created", entityType: "form_version", entityId: r.versionId, newValue: { version: r.version, fromVersionId: i.fromVersionId ?? null } });
    return { versionId: r.versionId };
  },
);

/** Drops the draft of a published form (a never-published form is deleted instead). */
export const discardDraft = action(
  { name: "forms.discard_draft", audience: "staff", permission: "forms.write", input: z.object({ formId: Uuid, versionId: Uuid }).strict(), audit: false },
  async (ctx, i): Promise<{ ok: true }> => {
    await lockForm(ctx.tx, i.formId);
    if (!(await everPublished(ctx.tx, i.formId))) throw new ConflictError("only_version_delete_form_instead");
    const deleted = await ctx.tx
      .delete(formVersions)
      .where(and(eq(formVersions.id, i.versionId), eq(formVersions.formId, i.formId), isNull(formVersions.publishedAt)))
      .returning({ version: formVersions.version, hash: formVersions.definitionHash });
    if (!deleted.length) throw new NotFoundError("draft_not_found");
    await ctx.audit({ action: "forms.draft_discarded", entityType: "form_version", entityId: i.versionId, oldValue: { version: deleted[0]!.version, definitionHash: deleted[0]!.hash } });
    return { ok: true };
  },
);

/**
 * P12 `draft -> published` and `published -> published`: P1 to P7 (with the CTA, tag and DPIA
 * checks of the service), `validation` listing the issues by path otherwise. The input is strict:
 * no caller can pass the demo seed's `skipDpiaCheck`.
 */
export const publishVersion = action(
  {
    name: "forms.publish",
    audience: "staff",
    permission: "forms.publish",
    input: z.object({ formId: Uuid, versionId: Uuid, changeNote: z.string().trim().min(1).max(500) }).strict(),
    audit: false,
  },
  async (ctx, i): Promise<{ version: number }> => {
    const r = await publishService(ctx.tx, ctx, i);
    const [v] = await ctx.tx.select({ hash: formVersions.definitionHash }).from(formVersions).where(eq(formVersions.id, i.versionId));
    await ctx.audit({ action: "forms.published", entityType: "form", entityId: i.formId, newValue: { versionId: i.versionId, version: r.version, definitionHash: v?.hash ?? null } });
    return r;
  },
);

/** P10 and P12 `published -> archived`; a draft form is deleted instead; never a system form (P13). */
export const archiveForm = action(
  { name: "forms.archive", audience: "staff", permission: "forms.publish", input: z.object({ formId: Uuid }).strict(), audit: false },
  async (ctx, i): Promise<{ ok: true }> => {
    const form = await lockForm(ctx.tx, i.formId);
    if (isSystemSlug(form.slug)) throw new ConflictError("system_form");
    if (form.status === "draft") throw new ConflictError("form_is_draft_delete_instead");
    if (form.status === "archived") throw new ConflictError("form_archived");
    await ctx.tx.update(forms).set({ status: "archived", archivedAt: ctx.now, updatedAt: ctx.now }).where(eq(forms.id, form.id));
    await ctx.audit({ action: "forms.archived", entityType: "form", entityId: form.id, oldValue: { status: form.status }, newValue: { status: "archived" } });
    return { ok: true };
  },
);

/** P10 and P12 `archived -> published` (the current version is served again). */
export const unarchiveForm = action(
  { name: "forms.unarchive", audience: "staff", permission: "forms.publish", input: z.object({ formId: Uuid }).strict(), audit: false },
  async (ctx, i): Promise<{ ok: true }> => {
    const form = await lockForm(ctx.tx, i.formId);
    if (form.status !== "archived") throw new ConflictError("form_not_archived");
    if (!form.currentVersionId) throw new ConflictError("no_current_version");
    await ctx.tx.update(forms).set({ status: "published", archivedAt: null, updatedAt: ctx.now }).where(eq(forms.id, form.id));
    await ctx.audit({ action: "forms.unarchived", entityType: "form", entityId: form.id, oldValue: { status: "archived" }, newValue: { status: "published" } });
    return { ok: true };
  },
);

/** P11 and P12 `draft -> (deleted)`: only while no version was ever published; never a system form. */
export const deleteForm = action(
  { name: "forms.delete", audience: "staff", permission: "forms.publish", input: z.object({ formId: Uuid }).strict(), audit: false },
  async (ctx, i): Promise<{ ok: true }> => {
    const form = await lockForm(ctx.tx, i.formId);
    if (isSystemSlug(form.slug)) throw new ConflictError("system_form");
    if (form.status !== "draft" || form.currentVersionId || (await everPublished(ctx.tx, form.id))) throw new ConflictError("form_was_published");
    await ctx.tx.delete(formLinks).where(eq(formLinks.formId, form.id));
    await ctx.tx.delete(formViewsDaily).where(eq(formViewsDaily.formId, form.id));
    await ctx.tx.delete(formVersions).where(eq(formVersions.formId, form.id));
    await ctx.tx.delete(forms).where(eq(forms.id, form.id));
    await ctx.audit({ action: "forms.deleted", entityType: "form", entityId: form.id, oldValue: { slug: form.slug, kind: form.kind } });
    return { ok: true };
  },
);

/** P12 `(none) -> draft`: a copy of the current version (else the draft) under a new slug. */
export const duplicateForm = action(
  { name: "forms.duplicate", audience: "staff", permission: "forms.write", input: z.object({ formId: Uuid, newSlug: Slug, name: Name }).strict(), audit: false },
  async (ctx, i): Promise<{ formId: string }> => {
    const [src] = await ctx.tx.select().from(forms).where(eq(forms.id, i.formId));
    if (!src) throw new NotFoundError("form_not_found");
    const [from] = src.currentVersionId
      ? await ctx.tx.select().from(formVersions).where(eq(formVersions.id, src.currentVersionId))
      : await ctx.tx.select().from(formVersions).where(and(eq(formVersions.formId, src.id), isNull(formVersions.publishedAt)));
    if (!from) throw new ConflictError("no_version_to_copy");
    await assertSlugFree(ctx.tx, i.newSlug, "newSlug");
    const userId = staffUserId(ctx);
    const [form] = await ctx.tx
      .insert(forms)
      .values({ slug: i.newSlug, kind: src.kind, name: i.name, description: src.description, status: "draft", createdByUserId: userId })
      .onConflictDoNothing({ target: forms.slug })
      .returning({ id: forms.id });
    if (!form) throw new ValidationError("slug_taken", { newSlug: "slug_taken" });
    const v = await insertDraftVersion(ctx.tx, { formId: form.id, version: 1, ...parseVersion(from), createdByUserId: userId, changeNote: null });
    await ctx.audit({
      action: "forms.created",
      entityType: "form",
      entityId: form.id,
      newValue: { slug: i.newSlug, kind: src.kind, duplicatedFrom: { formId: src.id, versionId: from.id, version: from.version }, definitionHash: v.definitionHash },
    });
    return { formId: form.id };
  },
);

// ---------------------------------------------------------------------------
// Tracked links
// ---------------------------------------------------------------------------

const CreateLinkInput = z
  .object({
    formId: Uuid,
    name: z.string().trim().min(1).max(120),
    channel: z.enum(FORM_LINK_CHANNELS).default("link"),
    utm: Utm.optional(),
    partnerCompanyId: Uuid.nullable().optional(),
    referrerPersonId: Uuid.nullable().optional(),
  })
  .strict();

async function linkUrl(tx: DbOrTx, formId: string, slug: string, key: string): Promise<string> {
  return trackedLinkUrl({ slug, locale: await linkLocale(tx, formId), key });
}

/** A tracked link `?l=<key>` (8 characters `[a-z0-9]`, unique). */
export const createLink = action(
  { name: "forms.create_link", audience: "staff", permission: "forms.write", input: CreateLinkInput, audit: false },
  async (ctx, i): Promise<{ linkId: string; key: string; url: string }> => {
    const [form] = await ctx.tx.select({ slug: forms.slug }).from(forms).where(eq(forms.id, i.formId));
    if (!form) throw new NotFoundError("form_not_found");
    const userId = staffUserId(ctx);
    if (!userId) throw new ConflictError("staff_only");
    for (let attempt = 0; attempt < 5; attempt++) {
      const key = newLinkKey();
      const [row] = await ctx.tx
        .insert(formLinks)
        .values({
          formId: i.formId,
          key,
          name: i.name,
          channel: i.channel,
          utm: i.utm ?? {},
          partnerCompanyId: i.partnerCompanyId ?? null,
          referrerPersonId: i.referrerPersonId ?? null,
          createdByUserId: userId,
        })
        .onConflictDoNothing({ target: formLinks.key })
        .returning({ id: formLinks.id });
      if (!row) continue;
      await ctx.audit({ action: "forms.link_created", entityType: "form_link", entityId: row.id, newValue: { formId: i.formId, key, name: i.name, channel: i.channel, utm: i.utm ?? {}, partnerCompanyId: i.partnerCompanyId ?? null } });
      return { linkId: row.id, key, url: await linkUrl(ctx.tx, i.formId, form.slug, key) };
    }
    throw new ConflictError("link_key_collision");
  },
);

const UpdateLinkInput = z
  .object({
    linkId: Uuid,
    name: z.string().trim().min(1).max(120).optional(),
    channel: z.enum(FORM_LINK_CHANNELS).optional(),
    utm: Utm.optional(),
    partnerCompanyId: Uuid.nullable().optional(),
    referrerPersonId: Uuid.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

/** Renames, re-tags or (de)activates a link; its key never changes. */
export const updateLink = action(
  { name: "forms.update_link", audience: "staff", permission: "forms.write", input: UpdateLinkInput, audit: false },
  async (ctx, i): Promise<{ linkId: string; key: string; url: string }> => {
    const [link] = await ctx.tx.select().from(formLinks).where(eq(formLinks.id, i.linkId)).for("update");
    if (!link) throw new NotFoundError("link_not_found");
    const [form] = await ctx.tx.select({ slug: forms.slug }).from(forms).where(eq(forms.id, link.formId));
    const { linkId: _id, ...rest } = i;
    const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<typeof formLinks.$inferInsert>;
    if (Object.keys(patch).length) {
      await ctx.tx.update(formLinks).set({ ...patch, updatedAt: ctx.now }).where(eq(formLinks.id, link.id));
      const old = Object.fromEntries(Object.keys(patch).map((k) => [k, (link as Record<string, unknown>)[k]]));
      await ctx.audit({ action: "forms.link_updated", entityType: "form_link", entityId: link.id, oldValue: old, newValue: patch });
    }
    return { linkId: link.id, key: link.key, url: await linkUrl(ctx.tx, link.formId, form!.slug, link.key) };
  },
);

// ---------------------------------------------------------------------------
// Submissions (forms-P6): reveal, resend, revoke, delete, result link, staff entry
// ---------------------------------------------------------------------------

const SubmissionInput = z.object({ submissionId: Uuid }).strict();

async function loadSubmission(tx: DbOrTx, submissionId: string, lock = false) {
  const q = tx
    .select({ s: formSubmissions, v: formVersions, slug: forms.slug })
    .from(formSubmissions)
    .innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
    .innerJoin(forms, eq(forms.id, formSubmissions.formId))
    .where(eq(formSubmissions.id, submissionId));
  const [row] = lock ? await q.for("update", { of: formSubmissions }) : await q;
  if (!row) throw new NotFoundError("submission_not_found");
  return { sub: row.s, slug: row.slug, version: row.v, content: parseVersion(row.v) };
}

const localized = (t: LocalizedText | undefined, locale: Locale): string | null => (t ? (t[locale] ?? null) : null);

/**
 * SE3: the sensitive answers of one submission, decrypted through `readSensitive(ctx, personId,
 * 'staff_view', { submissionIds: [id] })`, which checks `persons.sensitive_read` and writes the
 * `sensitive.read` audit row with keys only; labels come from the pinned version. The action
 * writes no audit row of its own (the read is the audited fact).
 */
export const revealSensitiveAnswers = action(
  { name: "forms.reveal_sensitive", audience: "staff", permission: "persons.sensitive_read", input: SubmissionInput, audit: false },
  async (ctx, i): Promise<{ answers: { fieldKey: string; label: string; value: string }[] }> => {
    const { sub, content } = await loadSubmission(ctx.tx, i.submissionId);
    if (!sub.personId) throw new ConflictError("anonymous_submission");
    const rows = await readSubmissionAnswers(ctx, sub.personId, "staff_view", [sub.id]);
    const def = content.definition;
    const order = Object.keys(def.fields);
    const answers = rows
      .filter((r) => r.submissionId === sub.id)
      .map((r) => {
        if (r.fieldKey.startsWith("score:")) {
          const key = r.fieldKey.slice("score:".length);
          const d = content.scoring.dimensions.find((x) => x.key === key);
          const raw = r.value as { value?: unknown } | number | null;
          const n = typeof raw === "number" ? raw : typeof raw?.value === "number" ? raw.value : null;
          const range = d && n !== null ? findRange(d.ranges, n) : null;
          const value = n === null ? "" : `${formatNumber(n, ctx.locale)}${range ? ` (${localized(range.label, ctx.locale) ?? range.key})` : ""}`;
          return { fieldKey: r.fieldKey, label: (d ? localized(d.label, ctx.locale) : null) ?? key, value, at: order.length + 1 };
        }
        const f = def.fields[r.fieldKey];
        const value = f ? answerText(f, r.value, ctx.locale) : typeof r.value === "string" ? r.value : JSON.stringify(r.value);
        return { fieldKey: r.fieldKey, label: (f ? localized(f.label, ctx.locale) : null) ?? r.fieldKey, value: value ?? "", at: order.indexOf(r.fieldKey) };
      })
      .sort((a, b) => a.at - b.at)
      .map(({ at: _at, ...a }) => a);
    return { answers };
  },
);

/** A result token valid now: the current one, or a renewed one (version + 1, 180 more days) when it expired. */
async function liveResultToken(ctx: Ctx, sub: typeof formSubmissions.$inferSelect): Promise<string> {
  if (sub.resultTokenExpiresAt && sub.resultTokenExpiresAt.getTime() > ctx.now.getTime() && sub.resultTokenHash) return createResultToken(sub.id, sub.resultTokenVersion);
  const version = sub.resultTokenVersion + 1;
  const token = createResultToken(sub.id, version);
  await ctx.tx
    .update(formSubmissions)
    .set({ resultTokenVersion: version, resultTokenHash: hashToken(token), resultTokenExpiresAt: new Date(ctx.now.getTime() + RESULT_TOKEN_DAYS * 86_400_000), updatedAt: ctx.now })
    .where(eq(formSubmissions.id, sub.id));
  return token;
}

const MAX_RESULT_RESENDS = 3;

/**
 * Resends `forms.result` for a completed submission (at most 3 times, keys
 * `form_result:<submission_id>:resend:<n>`), with the stored outcome and non-sensitive total in
 * the submission locale (SE4), and points `result_email_message_id` at the new message.
 */
export const resendResultEmail = action(
  { name: "forms.resend_result", audience: "staff", permission: "forms.write", input: SubmissionInput, audit: false },
  async (ctx, i): Promise<{ emailMessageId: string }> => {
    const { sub, slug, content } = await loadSubmission(ctx.tx, i.submissionId, true);
    if (sub.status !== "completed") throw new ConflictError("submission_not_completed");
    if (!sub.personId) throw new ConflictError("anonymous_submission");
    const n = (await countResends(ctx.tx, sub.id)) + 1;
    if (n > MAX_RESULT_RESENDS) throw new ConflictError("resend_limit");
    const locale = sub.locale as Locale;
    const def = content.definition;
    const ending = def.endings.find((e) => e.key === sub.endingKey) ?? def.endings[0]!;
    const outcome = sub.outcomeKey ? (content.scoring.outcomes.find((o) => o.key === sub.outcomeKey) ?? null) : null;
    const total = sub.score?.total ?? null;
    const range = total !== null && content.scoring.total ? findRange(content.scoring.total.ranges, total) : null;
    const token = await liveResultToken(ctx, sub);
    const prefill = await getPersonPrefill(ctx.tx, sub.personId);
    const data = FormResultProps.parse({
      firstName: prefill.firstName,
      formTitle: localized(def.title, locale) ?? slug,
      outcomeLabel: outcome ? localized(outcome.label, locale) : null,
      scoreLine: ending.showScore && total !== null ? String(Math.round(total * 100) / 100) : null,
      explanation: (outcome ? localized(outcome.explanation, locale) : null) ?? (range ? localized(range.explanation, locale) : null),
      recommendation: (outcome ? localized(outcome.recommendation, locale) : null) ?? (range ? localized(range.recommendation, locale) : null),
      intro: localized(ending.email?.intro, locale),
      resultUrl: resultPageUrl(slug, locale, token),
      ctas: ending.ctas.slice(0, 4).map((c) => ({ label: localized(c.label, locale) ?? c.key, url: ctaRedirectUrl(token, c.key) })),
      pendingConfirmation: (sub.consentSnapshot ?? []).some((c) => (c as { pendingConfirmation?: boolean }).pendingConfirmation === true),
    });
    const key = `${resendKeyPrefix(sub.id)}${n}`;
    const r = await sendTransactional(ctx, { template: "forms.result", personId: sub.personId, locale, data, key });
    await ctx.tx.update(formSubmissions).set({ resultEmailMessageId: r.emailMessageId, updatedAt: ctx.now }).where(eq(formSubmissions.id, sub.id));
    await ctx.audit({ action: "forms.result_resent", entityType: "form_submission", entityId: sub.id, personId: sub.personId, newValue: { n, key, emailMessageId: r.emailMessageId } });
    return { emailMessageId: r.emailMessageId };
  },
);

/** ID6, edge case 18: bumps `result_token_version`, so the old result link answers 404. */
export const revokeResultLink = action(
  { name: "forms.revoke_result_link", audience: "staff", permission: "forms.write", input: SubmissionInput, audit: false },
  async (ctx, i): Promise<{ ok: true }> => {
    const { sub } = await loadSubmission(ctx.tx, i.submissionId, true);
    if (sub.status !== "completed" || !sub.resultTokenHash) throw new ConflictError("no_result_link");
    const version = sub.resultTokenVersion + 1;
    await ctx.tx
      .update(formSubmissions)
      .set({ resultTokenVersion: version, resultTokenHash: hashToken(createResultToken(sub.id, version)), updatedAt: ctx.now })
      .where(eq(formSubmissions.id, sub.id));
    await ctx.audit({
      action: "forms.result_link_revoked",
      entityType: "form_submission",
      entityId: sub.id,
      personId: sub.personId,
      oldValue: { resultTokenVersion: sub.resultTokenVersion },
      newValue: { resultTokenVersion: version },
    });
    return { ok: true };
  },
);

/**
 * Deletes one submission (`spam`, `test`, or `subject_request`: one result removed without full
 * erasure); its sensitive rows go by the cascade. The audit row carries the reason and ids, never
 * answers. Timeline events stay with crm (append-only).
 */
export const deleteSubmission = action(
  {
    name: "forms.delete_submission",
    audience: "staff",
    permission: "forms.publish",
    input: z.object({ submissionId: Uuid, reason: z.enum(["spam", "test", "subject_request"]) }).strict(),
    audit: false,
  },
  async (ctx, i): Promise<{ ok: true }> => {
    const { sub, slug, version } = await loadSubmission(ctx.tx, i.submissionId, true);
    await ctx.tx.execute(sql`set local beam.allow_rewrite = 'on'`);
    await ctx.tx.delete(formSubmissions).where(eq(formSubmissions.id, sub.id));
    await ctx.audit({
      action: "forms.submission_deleted",
      entityType: "form_submission",
      entityId: sub.id,
      personId: sub.personId,
      oldValue: { formId: sub.formId, formSlug: slug, version: version.version, status: sub.status },
      newValue: { reason: i.reason },
    });
    return { ok: true };
  },
);

/**
 * ID8 (public): always `{ ok: true }`, whether or not the address is known; when a completed
 * submission of that form exists for it, a new result link is emailed (at most 3 per email per
 * form per day).
 */
export const requestResultLink = action(
  {
    name: "forms.request_result_link",
    audience: "public",
    input: z.object({ slug: z.string().trim().max(64), email: z.string().trim().max(254).email(), locale: z.enum(LOCALES) }).strict(),
    audit: false,
  },
  async (ctx, i): Promise<{ ok: true }> => requestResultLinkService(ctx.tx, ctx, i),
);

/**
 * ID10: the hosted URL with a 2-hour staff identity token (permission `persons.write`, only forms
 * with `settings.staffEntryAllowed`); audited `forms.staff_entry_started` with person and form.
 */
export const startStaffEntry = action(
  {
    name: "forms.start_staff_entry",
    audience: "staff",
    permission: "persons.write",
    input: z.object({ formId: Uuid, personId: Uuid, locale: z.enum(LOCALES).optional() }).strict(),
    audit: false,
  },
  async (ctx, i): Promise<{ url: string }> => {
    const r = await createStaffEntryUrl(ctx.tx, ctx, i);
    await ctx.audit({ action: "forms.staff_entry_started", entityType: "form", entityId: i.formId, personId: i.personId, newValue: { formId: i.formId, personId: i.personId, locale: i.locale ?? null } });
    return r;
  },
);
