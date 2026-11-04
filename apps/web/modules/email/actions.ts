"use server";
/**
 * email server actions (email spec section 4 "Server actions (staff)", all through `action()`).
 * email-P5: the template store. Each handler writes its own `audit_log` row with the spec's audit
 * name (`email.template_create`, `email.template_publish`, `email.template_archive`,
 * `email.test_send`), so the wrapper's automatic row is off; draft saves are not audited.
 *
 * - `createTemplate` (`email.write`): a marketing template with an empty draft.
 * - `saveTemplateDraft` (`email.write`): saves the one draft (created from the current version on
 *   the first edit of a published template); stale `draftUpdatedAt` answers `conflict`.
 * - `publishTemplateVersion` (`email.send`): completeness, tokens, footer, MJML compile; returns
 *   the accessibility and size warnings.
 * - `archiveTemplate` (`email.send`), `duplicateTemplate` (`email.write`).
 * - `sendTestEmail` (`email.write`; `persons.read` too for a real contact): staff addresses only.
 * - `uploadImage` (`email.write`): an editor image as a public `files` row of kind `image`
 *   through platform's `storeFile` (`image/png|jpeg|gif|webp`, at most 2 MB, rule 22), audited
 *   `files.upload_image` like platform's own upload action.
 * - `previewTemplate` (`email.write`, read-only): the editor's live preview.
 * email-P6 adds the campaign actions.
 */
import { z } from "zod";
import {
  ArchiveTemplateInput,
  CreateTemplateInput,
  DuplicateTemplateInput,
  GetPreviewInput,
  PublishTemplateVersionInput,
  SaveTemplateDraftInput,
  SendTestEmailInput,
} from "@beam/core/email";
import { action } from "@/lib/action";
import { actorHasPermission, ValidationError } from "@/lib/ctx";
import { storeFile } from "@/modules/platform/api";
import { getPreview } from "./queries";
import {
  archiveTemplateRecord,
  createTemplateRecord,
  duplicateTemplateRecord,
  publishTemplateRecord,
  saveTemplateDraftRecord,
  sendTestEmailRecord,
} from "./server/templates";

export const createTemplate = action(
  { name: "email.template_create", audience: "staff", permission: "email.write", input: CreateTemplateInput, audit: false },
  (ctx, input) => createTemplateRecord(ctx, input),
);

export const saveTemplateDraft = action(
  { name: "email.template_save", audience: "staff", permission: "email.write", input: SaveTemplateDraftInput, audit: false },
  (ctx, input) => saveTemplateDraftRecord(ctx, input),
);

export const publishTemplateVersion = action(
  { name: "email.template_publish", audience: "staff", permission: "email.send", input: PublishTemplateVersionInput, audit: false },
  (ctx, input) => publishTemplateRecord(ctx, input),
);

export const archiveTemplate = action(
  { name: "email.template_archive", audience: "staff", permission: "email.send", input: ArchiveTemplateInput, audit: false },
  (ctx, input) => archiveTemplateRecord(ctx, input),
);

export const duplicateTemplate = action(
  { name: "email.template_duplicate", audience: "staff", permission: "email.write", input: DuplicateTemplateInput, audit: false },
  (ctx, input) => duplicateTemplateRecord(ctx, input),
);

export const sendTestEmail = action(
  { name: "email.test_send", audience: "staff", permission: "email.write", input: SendTestEmailInput, audit: false },
  (ctx, input) => sendTestEmailRecord(ctx, input),
);

export const previewTemplate = action(
  {
    name: "email.template_preview",
    audience: "staff",
    permission: "email.write",
    input: GetPreviewInput.extend({ versionId: z.uuid().optional() }),
    audit: false,
  },
  async (ctx, input) => {
    const { versionId, ...args } = input;
    return getPreview(ctx.tx, args, { canReadPersons: actorHasPermission(ctx.actor, "persons.read"), ...(versionId ? { versionId } : {}) });
  },
);

/** Editor images may be at most 2 MB (rule 22; the editor refuses larger files before upload too). */
const MAX_EDITOR_IMAGE_BYTES = 2 * 1024 * 1024;
const EDITOR_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export const uploadImage = action(
  { name: "files.upload_image", audience: "staff", permission: "email.write", input: z.instanceof(FormData), audit: false },
  async (ctx, form): Promise<{ fileId: string; url: string }> => {
    const file = form.get("file");
    if (!(file instanceof Blob)) throw new ValidationError("file_required", { file: "required" });
    if (file.size > MAX_EDITOR_IMAGE_BYTES) throw new ValidationError("file_too_large", { file: "too_large" });
    if (!(EDITOR_IMAGE_TYPES as readonly string[]).includes(file.type)) throw new ValidationError("image_type_not_allowed", { file: "type_not_allowed" });
    const name = (file as Blob & { name?: string }).name ?? "image";
    const { fileId, sha256 } = await storeFile(ctx, { kind: "image", name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()), isPublic: true });
    await ctx.audit({ action: "files.upload_image", entityType: "files", entityId: fileId, newValue: { name, mime: file.type, size_bytes: file.size, sha256 } });
    return { fileId, url: `/api/public/files/${fileId}` };
  },
);
