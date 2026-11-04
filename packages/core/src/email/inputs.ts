/**
 * Zod inputs of the email actions (email spec section 4, `<Action>Input`). Pure. The actions in
 * `apps/web/modules/email/actions.ts` (email-P5 and later) parse with these; later packages
 * extend this file without renaming a schema.
 */
import { z } from "zod";
import { LOCALES } from "../i18n/locales";
import { LocalizedTextSchema } from "../i18n/localized-text";
import { BlockDocumentSchema } from "./blocks";
import { MARKETING_PURPOSES, MARKETING_SLUG_PATTERN, TEMPLATE_KINDS, TEMPLATE_STATUSES } from "./types";

export const LocaleSchema = z.enum(LOCALES);
export const MarketingPurposeSchema = z.enum(MARKETING_PURPOSES);
const uuid = z.string().uuid();
const version = z.number().int().positive();
const instant = z.coerce.date();

export const CreateTemplateInput = z.object({
  name: z.string().trim().min(1).max(160),
  kind: z.literal("marketing"),
  purpose: MarketingPurposeSchema,
  slug: z.string().regex(MARKETING_SLUG_PATTERN).optional(),
});

export const SaveTemplateDraftInput = z.object({
  templateId: uuid,
  draftUpdatedAt: instant,
  subject: LocalizedTextSchema,
  preheader: LocalizedTextSchema,
  document: BlockDocumentSchema.optional(),
  copy: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), LocalizedTextSchema).optional(),
});

export const PublishTemplateVersionInput = z.object({ templateId: uuid, draftUpdatedAt: instant });
export const ArchiveTemplateInput = z.object({ templateId: uuid });
export const DuplicateTemplateInput = z.object({ templateId: uuid, name: z.string().trim().min(1).max(160) });

/** The sample personas of previews and test sends (rule 18: lead, customer, member, assessment outcome). */
export const SAMPLE_PERSONAS = ["lead", "customer", "member"] as const;
export type SamplePersona = (typeof SAMPLE_PERSONAS)[number];

/** "Preview as": a real contact (`persons.read`) or a sample persona with an optional assessment outcome key. */
export const PreviewAsSchema = z.union([
  z.object({ personId: uuid }).strict(),
  z.object({ sample: z.enum(SAMPLE_PERSONAS), assessmentOutcome: z.string().trim().min(1).max(80).optional() }).strict(),
]);
export type PreviewAs = z.infer<typeof PreviewAsSchema>;

export const SendTestEmailInput = z.object({
  templateId: uuid,
  use: z.enum(["draft", "current"]),
  locales: z.array(LocaleSchema).min(1).max(3),
  to: z.array(z.string().trim().toLowerCase().email()).min(1).max(5),
  as: PreviewAsSchema,
  campaignId: uuid.optional(),
});

/** `listTemplates` filters (email-P5): tab, status, search, owning module of a transactional key, page. */
export const ListTemplatesInput = z.object({
  kind: z.enum(TEMPLATE_KINDS).optional(),
  status: z.enum(TEMPLATE_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  module: z.string().regex(/^[a-z]+$/).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

/** `getPreview` (email-P5): one locale of the draft or the current version, as a persona (none = lead sample). */
export const GetPreviewInput = z.object({
  templateId: uuid,
  use: z.enum(["draft", "current"]),
  locale: LocaleSchema,
  as: PreviewAsSchema.optional(),
});

export const CreateCampaignInput = z.object({
  name: z.string().trim().min(1).max(160),
  purpose: MarketingPurposeSchema,
  templateId: uuid.optional(),
});

export const UpdateCampaignInput = z.object({
  campaignId: uuid,
  expectedVersion: version,
  name: z.string().trim().min(1).max(160).optional(),
  segmentId: uuid.nullable().optional(),
  excludeSegmentIds: z.array(uuid).max(20).optional(),
  scheduledAt: instant.nullable().optional(),
});

export const ScheduleCampaignInput = z.object({
  campaignId: uuid,
  expectedVersion: version,
  scheduledAt: z.union([z.literal("now"), instant]),
  confirmOutsideWindow: z.boolean().optional(),
});

const campaignVersioned = z.object({ campaignId: uuid, expectedVersion: version });
export const UnscheduleCampaignInput = campaignVersioned;
export const RefreshAudienceInput = campaignVersioned;
export const PauseCampaignInput = campaignVersioned.extend({ confirmName: z.string().optional() });
export const ResumeCampaignInput = campaignVersioned.extend({ confirmName: z.string().optional() });
export const StopCampaignInput = campaignVersioned;
export const CancelCampaignInput = campaignVersioned;
export const DuplicateCampaignInput = z.object({ campaignId: uuid });

export const RemoveRecipientInput = z.object({ campaignId: uuid, personId: uuid });
export const RestoreRecipientInput = RemoveRecipientInput;

export const ResendMessageInput = z.object({ messageId: uuid });
export const CancelScheduledMessageInput = z.object({ messageId: uuid });

/** R4. */
export const RequestAiDraftInput = z.object({
  brief: z.string().trim().min(10).max(4000),
  sessionIds: z.array(uuid).max(3).default([]),
  segmentId: uuid.optional(),
  purpose: MarketingPurposeSchema,
  campaignId: uuid.optional(),
});
export const AcceptAiDraftInput = z.object({ draftId: uuid, campaignName: z.string().trim().min(1).max(160) });
export const DiscardAiDraftInput = z.object({ draftId: uuid });

/** `extra_headers`: only `In-Reply-To` and `References` (any other key is refused). */
export const ExtraHeadersSchema = z.object({ "In-Reply-To": z.string().min(1).optional(), References: z.string().min(1).optional() }).strict();

export const SendTransactionalInputSchema = z.object({
  template: z.string().trim().min(1),
  personId: uuid.optional(),
  to: z.string().trim().toLowerCase().email().optional(),
  locale: LocaleSchema,
  data: z.record(z.string(), z.unknown()),
  key: z.string().trim().min(1),
  attachments: z.array(z.object({ fileId: uuid, filename: z.string().min(1), inline: z.boolean().optional() }).strict()).optional(),
  context: z.record(z.string(), z.string()).optional(),
  sendAt: z.date().optional(),
  replyTo: z.string().email().optional(),
  headers: ExtraHeadersSchema.optional(),
});

export type CreateTemplateInput = z.infer<typeof CreateTemplateInput>;
export type SaveTemplateDraftInput = z.infer<typeof SaveTemplateDraftInput>;
export type PublishTemplateVersionInput = z.infer<typeof PublishTemplateVersionInput>;
export type SendTestEmailInput = z.infer<typeof SendTestEmailInput>;
export type ListTemplatesInput = z.input<typeof ListTemplatesInput>;
export type GetPreviewInput = z.infer<typeof GetPreviewInput>;
export type DuplicateTemplateInput = z.infer<typeof DuplicateTemplateInput>;
export type ArchiveTemplateInput = z.infer<typeof ArchiveTemplateInput>;
export type CreateCampaignInput = z.infer<typeof CreateCampaignInput>;
export type UpdateCampaignInput = z.infer<typeof UpdateCampaignInput>;
export type ScheduleCampaignInput = z.infer<typeof ScheduleCampaignInput>;
export type RequestAiDraftInput = z.infer<typeof RequestAiDraftInput>;
