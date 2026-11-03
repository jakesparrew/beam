/**
 * email types named in the cross-module contract (02-data-model section 6.8). Wave 0 skeleton
 * by platform-P7; email owns this file from email-P1 on.
 */
import type { Locale } from "../i18n/locales";
import type { LocalizedText } from "../i18n/localized-text";

export type { Locale };

export type MarketingPurpose = "newsletter" | "events" | "member_comms" | "b2b";
export type MessageStatus = "queued" | "blocked_translation" | "suppressed" | "sent" | "delivered" | "bounced" | "complained" | "failed";
export type TemplateKind = "transactional" | "marketing";

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

/** A block-backed template document (email section 3, rule 20). */
export type Block = { type: string; id: string } & Record<string, unknown>;
export type BlockDocument = { schemaVersion: 1; locales: Partial<Record<Locale, Block[]>> };

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
