/**
 * email types named in the cross-module contract (02-data-model section 6.8) and the module's
 * enum value lists. Wave 0 skeleton by platform-P7; email owns this file from email-P1 on.
 */
import type { Locale } from "../i18n/locales";
import type { LocalizedText } from "../i18n/localized-text";
import type { BlockDocument } from "./blocks";

export type { Locale };
export type { Block, BlockDocument } from "./blocks";
export type { BlockedReason } from "./reachability";
export type { CampaignStatus } from "./campaign-state";
export type { EmailEventType } from "./message-status";

export const MARKETING_PURPOSES = ["newsletter", "events", "member_comms", "b2b"] as const;
export type MarketingPurpose = (typeof MARKETING_PURPOSES)[number];

export const MESSAGE_STATUSES = ["queued", "blocked_translation", "suppressed", "sent", "delivered", "bounced", "complained", "failed"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const TEMPLATE_KINDS = ["transactional", "marketing"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const TEMPLATE_STATUSES = ["draft", "published", "archived"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const MESSAGE_KINDS = ["transactional", "campaign", "automation", "test"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const FROM_DOMAINS = ["mail.beam.be", "news.beam.be"] as const;
export type FromDomain = (typeof FROM_DOMAINS)[number];

export const RECIPIENT_STATUSES = [
  "planned",
  "sent",
  "skipped_suppressed",
  "skipped_consent",
  "skipped_translation",
  "skipped_unreachable",
  "removed",
  "failed",
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const PAUSED_REASONS = ["manual", "bounce_rate"] as const;
export type PausedReason = (typeof PAUSED_REASONS)[number];

export const AI_DRAFT_STATUSES = ["queued", "ready", "failed", "accepted", "discarded"] as const;
export type AiDraftStatus = (typeof AI_DRAFT_STATUSES)[number];

/** Campaign chunk size (rule 27) and Resend batch size (rule 33). */
export const CHUNK_SIZE = 500;
export const BATCH_SIZE = 100;

/** Transactional slug `<module>.<name>` and marketing slug (kebab-case), as the `email_templates_slug_ck` check. */
export const TRANSACTIONAL_SLUG_PATTERN = /^[a-z]+\.[a-z][a-z0-9_]{1,60}$/;
export const MARKETING_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/;

export function isValidTemplateSlug(kind: TemplateKind, slug: string): boolean {
  return kind === "transactional" ? TRANSACTIONAL_SLUG_PATTERN.test(slug) : MARKETING_SLUG_PATTERN.test(slug);
}

/** The sending domain of a template kind (rule 1; `queueMarketingEmail` always uses `news.beam.be`). */
export function fromDomainOf(kind: TemplateKind): FromDomain {
  return kind === "marketing" ? "news.beam.be" : "mail.beam.be";
}

/** The email spec 4.8 input of `sendTransactional` (Wave 0 stub shape, final). */
export type SendTransactionalInput = {
  template: string;
  personId?: string;
  to?: string;
  locale: Locale;
  data: Record<string, unknown>;
  key: string;
  attachments?: { fileId: string; filename: string; inline?: boolean }[];
  context?: Record<string, string>;
  sendAt?: Date;
  replyTo?: string;
  headers?: { "In-Reply-To"?: string; References?: string };
};

export type AutomationEmailInput = {
  templateSlug: string;
  personId: string;
  enrolmentId: string;
  idempotencyKey: string;
  context?: Record<string, string>;
  stepKey?: string;
};

export type AutomationEmailResult = {
  messageId: string;
  status: "queued" | "skipped_unreachable" | "skipped_translation";
  created: boolean;
  templateVersionId: string;
};

export type TemplateInfo = { templateVersionId: string; kind: TemplateKind; purpose: MarketingPurpose | null; locales: Locale[] };

export type SeedTemplateInput = {
  slug: string;
  name: string;
  kind: TemplateKind;
  purpose: MarketingPurpose | null;
  subject: LocalizedText;
  preheader: LocalizedText;
  document: BlockDocument;
};

export type PersonEmailRow = {
  emailMessageId: string;
  templateSlug: string;
  subject: string | null;
  status: MessageStatus;
  queuedAt: Date;
  sentAt: Date | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  campaignId: string | null;
};

export type CampaignStats = {
  campaignId: string;
  recipients: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
};
