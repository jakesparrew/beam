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
 *
 * email-P6, campaigns (`server/campaigns.ts`; each handler audits itself with the spec's name):
 * - `createCampaign`, `updateCampaign` (draft only), `duplicateCampaign` (`email.write`).
 * - `scheduleCampaign` (rule 26 checks, publishes the draft, enqueues `campaign.plan`),
 *   `unscheduleCampaign`, `refreshAudience`, `removeRecipient`, `restoreRecipient`,
 *   `pauseCampaign`, `resumeCampaign` (the campaign name after a bounce-rate pause),
 *   `stopCampaign`, `cancelCampaign` (`campaigns.send`).
 * - `estimateAudience` (`email.write`, read-only): the Audience step's live estimate.
 *
 * email-P7, messages and reports:
 * - `resendMessage` (`persons.write`; reception and customer service resend a booking
 *   confirmation or receipt at the desk): a transactional message in `sent`, `delivered`,
 *   `bounced` or `failed` is queued again as a new message with key `<original>:manual:<n>`, the
 *   same template version, data, context and attachments, to the person's current address.
 *   Refused for campaign, automation and test messages and while the address is suppressed
 *   (`hard_bounce`, `complaint` or `erased`, scope `all`). Audited `email.message_resend`.
 * - `cancelScheduledMessage` (`email.send`): rule 59 for a `queued` message with a future
 *   `send_at`. Audited `email.message_cancel`.
 * - `exportCampaignReport` (`reports.read` or `email.write`, read-only): the report's CSV.
 */
import { z } from "zod";
import {
  ArchiveTemplateInput,
  CancelCampaignInput,
  CreateCampaignInput,
  DuplicateCampaignInput,
  GetAudienceEstimateInput,
  PauseCampaignInput,
  RefreshAudienceInput,
  RemoveRecipientInput,
  RestoreRecipientInput,
  ResumeCampaignInput,
  ScheduleCampaignInput,
  StopCampaignInput,
  UnscheduleCampaignInput,
  UpdateCampaignInput,
  CreateTemplateInput,
  DuplicateTemplateInput,
  GetPreviewInput,
  PublishTemplateVersionInput,
  SaveTemplateDraftInput,
  SendTestEmailInput,
} from "@beam/core/email";
import { emailHash } from "@beam/core/crm";
import { CancelScheduledMessageInput, ResendMessageInput } from "@beam/core/email";
import { emailMessages, jobs, persons, suppressions } from "@beam/db/schema";
import { action } from "@/lib/action";
import { actorHasPermission, and, eq, inArray, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { storeFile } from "@/modules/platform/api";
import { cancelScheduledMessage as cancelMessage } from "./api";
import { campaignReportCsv, getPreview, RESENDABLE_STATUSES } from "./queries";
import { COMPLAINT_EXEMPT_TEMPLATES, queueMessage, SEND_PRIORITY } from "./server/send";
import {
  cancelCampaignRecord,
  createCampaignRecord,
  duplicateCampaignRecord,
  pauseCampaignRecord,
  refreshAudienceRecord,
  removeRecipientRecord,
  restoreRecipientRecord,
  resumeCampaignRecord,
  scheduleCampaignRecord,
  stopCampaignRecord,
  unscheduleCampaignRecord,
  updateCampaignRecord,
} from "./server/campaigns";
import { getAudienceEstimate } from "./server/plan";
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

// ---------------------------------------------------------------------------
// Campaigns (email-P6)
// ---------------------------------------------------------------------------

export const createCampaign = action(
  { name: "email.campaign_create", audience: "staff", permission: "email.write", input: CreateCampaignInput, audit: false },
  (ctx, input) => createCampaignRecord(ctx, input),
);

export const updateCampaign = action(
  { name: "email.campaign_update", audience: "staff", permission: "email.write", input: UpdateCampaignInput, audit: false },
  (ctx, input) => updateCampaignRecord(ctx, input),
);

export const duplicateCampaign = action(
  { name: "email.campaign_duplicate", audience: "staff", permission: "email.write", input: DuplicateCampaignInput, audit: false },
  (ctx, input) => duplicateCampaignRecord(ctx, input),
);

export const scheduleCampaign = action(
  { name: "email.campaign_schedule", audience: "staff", permission: "campaigns.send", input: ScheduleCampaignInput, audit: false },
  (ctx, input) => scheduleCampaignRecord(ctx, input),
);

export const unscheduleCampaign = action(
  { name: "email.campaign_unschedule", audience: "staff", permission: "campaigns.send", input: UnscheduleCampaignInput, audit: false },
  (ctx, input) => unscheduleCampaignRecord(ctx, input),
);

export const refreshAudience = action(
  { name: "email.campaign_refresh", audience: "staff", permission: "campaigns.send", input: RefreshAudienceInput, audit: false },
  (ctx, input) => refreshAudienceRecord(ctx, input),
);

export const removeRecipient = action(
  { name: "email.recipient_remove", audience: "staff", permission: "campaigns.send", input: RemoveRecipientInput, audit: false },
  (ctx, input) => removeRecipientRecord(ctx, input),
);

export const restoreRecipient = action(
  { name: "email.recipient_restore", audience: "staff", permission: "campaigns.send", input: RestoreRecipientInput, audit: false },
  (ctx, input) => restoreRecipientRecord(ctx, input),
);

export const pauseCampaign = action(
  { name: "email.campaign_pause", audience: "staff", permission: "campaigns.send", input: PauseCampaignInput, audit: false },
  (ctx, input) => pauseCampaignRecord(ctx, input),
);

export const resumeCampaign = action(
  { name: "email.campaign_resume", audience: "staff", permission: "campaigns.send", input: ResumeCampaignInput, audit: false },
  (ctx, input) => resumeCampaignRecord(ctx, input),
);

export const stopCampaign = action(
  { name: "email.campaign_stop", audience: "staff", permission: "campaigns.send", input: StopCampaignInput, audit: false },
  (ctx, input) => stopCampaignRecord(ctx, input),
);

export const cancelCampaign = action(
  { name: "email.campaign_cancel", audience: "staff", permission: "campaigns.send", input: CancelCampaignInput, audit: false },
  (ctx, input) => cancelCampaignRecord(ctx, input),
);

export const estimateAudience = action(
  { name: "email.audience_estimate", audience: "staff", permission: "email.write", input: GetAudienceEstimateInput, audit: false },
  (ctx, input) => getAudienceEstimate(ctx.tx, input),
);

// ---------------------------------------------------------------------------
// Messages and reports (email-P7)
// ---------------------------------------------------------------------------

/** The root idempotency key of a message: a resend of a resend counts from the original. */
const rootKey = (key: string) => key.replace(/(:manual:\d+)+$/, "");

async function resendMessageRecord(ctx: Ctx, input: { messageId: string }): Promise<{ messageId: string }> {
  const tx = ctx.tx;
  const [m] = await tx.select().from(emailMessages).where(eq(emailMessages.id, input.messageId)).for("update");
  if (!m) throw new NotFoundError("email_message_not_found");
  if (m.kind !== "transactional") throw new ValidationError("not_transactional", { messageId: "not_transactional" });
  if (!(RESENDABLE_STATUSES as readonly string[]).includes(m.status)) throw new ValidationError("not_resendable", { messageId: "not_resendable" });
  // `props` are purged 30 days after sending (`email.purge_props`): the data to render is gone.
  if (m.props === null) throw new ValidationError("data_expired", { messageId: "data_expired" });

  let to = m.toEmail;
  if (m.personId) {
    const [p] = await tx.select({ email: persons.email, erasedAt: persons.erasedAt }).from(persons).where(eq(persons.id, m.personId));
    if (p?.erasedAt) throw new ValidationError("person_erased", { messageId: "person_erased" });
    to = p?.email ?? m.toEmail;
  }
  to = to?.trim() || null;
  if (!to) throw new ValidationError("no_recipient", { messageId: "no_recipient" });

  const [job] = await tx.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.idempotencyKey, `email:${m.id}`));
  const [tpl] = m.templateVersionId
    ? rowsOf<{ slug: string }>(
        await tx.execute(sql`select t.slug from email_template_versions v join email_templates t on t.id = v.template_id where v.id = ${m.templateVersionId}::uuid`),
      )
    : [];
  const template = (job?.payload as { template?: string } | undefined)?.template ?? tpl?.slug ?? "(none)";

  const reasons = (COMPLAINT_EXEMPT_TEMPLATES as readonly string[]).includes(template) ? (["hard_bounce", "erased"] as const) : (["hard_bounce", "complaint", "erased"] as const);
  const [suppressed] = await tx
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.emailHash, emailHash(to)), eq(suppressions.scope, "all"), inArray(suppressions.reason, [...reasons])))
    .limit(1);
  if (suppressed) throw new ValidationError("address_suppressed", { messageId: "address_suppressed" });

  const root = rootKey(m.idempotencyKey);
  const [prior] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(emailMessages)
    .where(sql`${emailMessages.idempotencyKey} like ${`${root.replace(/[\\%_]/g, (x) => `\\${x}`)}:manual:%`}`);
  const key = `${root}:manual:${Number(prior?.n ?? 0) + 1}`;

  const queued = await queueMessage(
    ctx,
    {
      personId: m.personId,
      toEmail: to,
      kind: "transactional",
      fromDomain: "mail.beam.be",
      templateVersionId: m.templateVersionId,
      locale: m.locale,
      props: m.props ?? {},
      context: m.context,
      attachments: m.attachments,
      replyTo: m.replyTo,
      extraHeaders: m.extraHeaders,
      sendAt: null,
      idempotencyKey: key,
      status: "queued",
    },
    { template, priority: SEND_PRIORITY.transactional, always: true },
  );
  await ctx.audit({
    action: "email.message_resend",
    entityType: "email_message",
    entityId: queued.emailMessageId,
    oldValue: { email_message_id: m.id },
    newValue: { email_message_id: queued.emailMessageId, idempotency_key: key, template },
  });
  return { messageId: queued.emailMessageId };
}

export const resendMessage = action(
  { name: "email.message_resend", audience: "staff", permission: "persons.write", input: ResendMessageInput, audit: false },
  (ctx, input) => resendMessageRecord(ctx, input),
);

export const cancelScheduledMessage = action(
  { name: "email.message_cancel", audience: "staff", permission: "email.send", input: CancelScheduledMessageInput, audit: false },
  async (ctx, input) => {
    const [m] = await ctx.tx.select({ id: emailMessages.id, status: emailMessages.status, sendAt: emailMessages.sendAt }).from(emailMessages).where(eq(emailMessages.id, input.messageId));
    if (!m) throw new NotFoundError("email_message_not_found");
    if (m.status !== "queued" || !m.sendAt || m.sendAt <= ctx.now) throw new ValidationError("not_scheduled", { messageId: "not_scheduled" });
    const result = await cancelMessage(ctx, { messageId: m.id });
    if (result.cancelled) {
      await ctx.audit({ action: "email.message_cancel", entityType: "email_message", entityId: m.id, oldValue: { status: "queued" }, newValue: { status: "failed", error: "cancelled" } });
    }
    return { ok: result.cancelled };
  },
);

export const exportCampaignReport = action(
  { name: "email.report_export", audience: "staff", permission: "reports.read", input: z.object({ campaignId: z.uuid() }), audit: false },
  async (ctx, input): Promise<{ filename: string; csv: string }> => ({
    filename: `campaign-${input.campaignId}.csv`,
    csv: await campaignReportCsv(ctx.tx, input.campaignId),
  }),
);
