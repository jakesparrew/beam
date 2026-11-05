/**
 * email's cross-module door (email spec section 4 "Cross-module API", 02-data-model section
 * 6.8). Written by platform-P7 with the Wave 0 `sendTransactional`; email-P1 declared every
 * function another module calls with its final signature; email-P3 implements the sending side:
 * `sendTransactional`, `queueMarketingEmail`, `queueAutomationEmail`, `getTemplateInfo`,
 * `getPublishedTemplateInfo`, `listPublishedTemplates`, `seedTemplate`, `getReachability`,
 * `resolveLinkToken`, `listPersonEmails`, `countBlockedMessages` and `cancelScheduledMessage`;
 * email-P4 adds `isSegmentInUse` (crm's archive guard) and `unsubscribeLinksFor` (crm's links of
 * one message: `List-Unsubscribe`, footer links, `{{preferences_url}}` and `{{unsubscribe_url}}`).
 *
 * The queueing functions only write rows and enqueue inside the caller's transaction
 * (`ctx.tx`); they never call Resend and never throw for content problems (rule 39).
 *
 * email-P7 implements `getCampaignStats` (snapshot or `v_campaign_stats`), `getEmailHealth`
 * (rule 38a) and the `PersonEmailHistory` server component for crm's person page.
 *
 * Still stubs (later email packages): `findLatestMessage` (email-P8), `getCampaignAttribution`
 * (email-P9).
 */
import type { ReactElement } from "react";
import type { DbOrTx, Tx } from "@beam/db";
import { emailMessages, emailTemplates, emailTemplateVersions } from "@beam/db/schema";
import { NotImplementedError } from "@beam/core/errors";
import type { Locale } from "@beam/core/i18n";
import type {
  AutomationEmailInput,
  AutomationEmailResult,
  CampaignStats,
  MarketingPurpose,
  MessageStatus,
  PersonEmailRow,
  SeedTemplateInput,
  SendTransactionalInput,
  TemplateInfo,
  TemplateKind,
} from "@beam/core/email";
import { and, desc, eq, gte, inArray, sql, type Ctx } from "@/lib/ctx";
import type { PersonEmailHistoryProps } from "./ui/PersonEmailHistory";
import * as context from "./server/context";
import * as deliveryWatch from "./server/delivery-watch";
import * as linkToken from "./server/link-token";
import * as queue from "./server/queue-automation";
import * as reports from "./server/reports";
import * as segments from "./server/segments";
import * as send from "./server/send";
import * as templates from "./server/templates-info";

export { unsubscribeLinksFor, type UnsubscribeLinks, type UnsubscribeLinksInput } from "./server/unsubscribe-links";

export type {
  AutomationEmailInput,
  AutomationEmailResult,
  CampaignStats,
  MarketingPurpose,
  MessageStatus,
  PersonEmailRow,
  SeedTemplateInput,
  SendTransactionalInput,
  TemplateInfo,
} from "@beam/core/email";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`email.${fn}`));

/** The idempotency key of the `email.send` job of a message. */
export const emailSendJobKey = send.emailSendJobKey;

/** Queues one transactional email in the caller's transaction. The same `key` twice is one message and one job. */
export function sendTransactional(ctx: Ctx, input: SendTransactionalInput): Promise<{ emailMessageId: string; jobId: string }> {
  return send.sendTransactional(ctx, input);
}

/** Marketing templates, and registry templates with `loadProps` sent as a commercial message (rule 39a, D54). */
export function queueMarketingEmail(ctx: Ctx, input: AutomationEmailInput): Promise<AutomationEmailResult> {
  return queue.queueMarketingEmail(ctx, input);
}

/** Transactional templates sent by automation steps (rule 39a). */
export function queueAutomationEmail(ctx: Ctx, input: AutomationEmailInput): Promise<AutomationEmailResult> {
  return queue.queueAutomationEmail(ctx, input);
}

/** The current published version of a template. */
export function getTemplateInfo(db: DbOrTx, slug: string): Promise<TemplateInfo | null> {
  return templates.getTemplateInfo(db, slug);
}

export function getPublishedTemplateInfo(db: DbOrTx, slugs: string[]): Promise<Map<string, TemplateInfo>> {
  return templates.getPublishedTemplateInfo(db, slugs);
}

/** crm preference and unsubscribe routes; never writes. */
export function resolveLinkToken(
  db: DbOrTx,
  token: string,
): Promise<{ emailMessageId: string; personId: string; purpose: MarketingPurpose | null; locale: Locale; sentAt: Date } | null> {
  return linkToken.resolveLinkToken(db, token);
}

export function listPublishedTemplates(
  db: DbOrTx,
  q?: string,
): Promise<{ slug: string; name: string; kind: TemplateKind; purpose: MarketingPurpose | null; locales: Locale[] }[]> {
  return templates.listPublishedTemplates(db, q);
}

/** Creates the template and a published version 1 when the slug is absent; never touches an existing slug. */
export function seedTemplate(tx: Tx, input: SeedTemplateInput): Promise<{ templateId: string; created: boolean }> {
  return templates.seedTemplate(tx, input);
}

export function getReachability(
  tx: DbOrTx,
  personId: string,
  purpose: MarketingPurpose,
): Promise<{ isReachable: boolean; blockedReason: "erased" | "no_email" | "restricted" | "suppressed" | "withdrawn" | "no_consent" | null }> {
  return context.getReachability(tx, personId, purpose);
}

/** R2, commerce. */
export function findLatestMessage(
  _db: DbOrTx,
  _input: { personId: string; templateSlug: string; after: Date },
): Promise<{ emailMessageId: string; status: MessageStatus; sentAt: Date | null; clickedAt: Date | null } | null> {
  return notYet("findLatestMessage");
}

/** Rule 59: a still-queued message becomes `failed` with `cancelled`; `email.send` then skips it. */
export function cancelScheduledMessage(ctx: Ctx, input: { messageId: string }): Promise<{ cancelled: boolean }> {
  return send.cancelScheduledMessage(ctx, input);
}

/** crm archive guard: campaigns not terminal using the segment as audience or exclusion. */
export function isSegmentInUse(db: DbOrTx, segmentId: string): Promise<boolean> {
  return segments.isSegmentInUse(db, segmentId);
}

export const PERSON_EMAILS_PAGE_SIZE = 50;

/** Every message to the person, newest first, 50 per page (rule 63). `page` starts at 1. */
export async function listPersonEmails(db: DbOrTx, personId: string, page = 1): Promise<{ items: PersonEmailRow[]; nextPage: number | null }> {
  const p = Math.max(1, Math.floor(page));
  const rows = await db
    .select({
      emailMessageId: emailMessages.id,
      slug: emailTemplates.slug,
      subject: emailMessages.subject,
      status: emailMessages.status,
      queuedAt: emailMessages.queuedAt,
      sentAt: emailMessages.sentAt,
      openedAt: emailMessages.openedAt,
      clickedAt: emailMessages.clickedAt,
      campaignId: emailMessages.campaignId,
      jobTemplate: sql<string | null>`(select j.payload->>'template' from jobs j where j.idempotency_key = 'email:' || ${emailMessages.id}::text limit 1)`,
    })
    .from(emailMessages)
    .leftJoin(emailTemplateVersions, eq(emailTemplateVersions.id, emailMessages.templateVersionId))
    .leftJoin(emailTemplates, eq(emailTemplates.id, emailTemplateVersions.templateId))
    .where(eq(emailMessages.personId, personId))
    .orderBy(desc(emailMessages.createdAt), desc(emailMessages.id))
    .limit(PERSON_EMAILS_PAGE_SIZE + 1)
    .offset((p - 1) * PERSON_EMAILS_PAGE_SIZE);
  const items = rows.slice(0, PERSON_EMAILS_PAGE_SIZE).map((r) => ({
    emailMessageId: r.emailMessageId,
    templateSlug: r.slug ?? r.jobTemplate ?? "",
    subject: r.subject,
    status: r.status,
    queuedAt: r.queuedAt,
    sentAt: r.sentAt,
    openedAt: r.openedAt,
    clickedAt: r.clickedAt,
    campaignId: r.campaignId,
  }));
  return { items, nextPage: rows.length > PERSON_EMAILS_PAGE_SIZE ? p + 1 : null };
}

/** Per campaign: the frozen snapshot when present, else `v_campaign_stats` (rule 62). Unknown ids are left out. */
export function getCampaignStats(db: DbOrTx, campaignIds: string[]): Promise<CampaignStats[]> {
  return reports.getCampaignStats(db, campaignIds);
}

/** ops daily digest: messages blocked for a missing translation since `since`. */
export async function countBlockedMessages(db: DbOrTx, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailMessages)
    .where(and(inArray(emailMessages.status, ["blocked_translation"]), gte(emailMessages.updatedAt, since)));
  return Number(row?.n ?? 0);
}

/** Rule 38a values (a) to (d) for the daily digest and the System page. */
export function getEmailHealth(
  db: DbOrTx,
  now: Date = new Date(),
): Promise<{ oldestQueuedMinutes: number | null; deadSends15m: number; sent60m: number; failed5m: number; blockedTranslation5m: number }> {
  return deliveryWatch.getEmailHealth(db, now);
}

/** R3, ops dashboards. */
export function getCampaignAttribution(
  _db: DbOrTx,
  _input: { from: Date; to: Date },
): Promise<{ campaignId: string | null; automationId: string | null; name: string; orders: number; revenueCents: number; firstPurchases: number }[]> {
  return notYet("getCampaignAttribution");
}

export type { PersonEmailHistoryProps } from "./ui/PersonEmailHistory";

/**
 * Server component rendered by crm as the "Emails" tab of `/admin/persons/[id]` (spec section 5,
 * rule 63): every message to the person, newest first, 50 per page, with reachability per
 * purpose and Resend for transactional messages (`persons.write`). The UI module loads when the
 * panel renders, so importing this api from jobs and other modules does not pull the UI in.
 */
export async function PersonEmailHistory(props: PersonEmailHistoryProps): Promise<ReactElement> {
  const ui = await import("./ui/PersonEmailHistory");
  return ui.PersonEmailHistory(props);
}
