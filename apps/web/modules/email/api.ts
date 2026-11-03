/**
 * email's cross-module door (02-data-model section 6.8). Written by platform-P7 on behalf of the
 * email module, which takes the file over in Wave 1.
 *
 * `sendTransactional` is working from Wave 0 (platform spec 4.9): it writes the `email_messages`
 * row (`idempotency_key = key`, status `queued`) and enqueues `email.send` (key
 * `email:<message_id>`, lane fast, priority 1, `run_at = sendAt`) in the caller's transaction,
 * and never calls Resend. `context` is stored and ignored in Wave 0 (merge fields are email's
 * Wave 1 work). Every other function is a stub that throws `NotImplementedError('email.<fn>')`.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { emailMessages, persons } from "@beam/db/schema";
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
import { eq, ValidationError, type Ctx } from "@/lib/ctx";

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
export const emailSendJobKey = (emailMessageId: string): string => `email:${emailMessageId}`;

async function recipientOf(tx: DbOrTx, input: SendTransactionalInput): Promise<string> {
  if (input.to?.trim()) return input.to.trim();
  if (!input.personId) throw new ValidationError("email_recipient_missing", { to: "required" });
  const [person] = await tx.select({ email: persons.email }).from(persons).where(eq(persons.id, input.personId));
  if (!person?.email) throw new ValidationError("email_recipient_missing", { personId: "no_email" });
  return person.email;
}

/** Queues one transactional email in the caller's transaction. The same `key` twice is one message and one job. */
export async function sendTransactional(ctx: Ctx, input: SendTransactionalInput): Promise<{ emailMessageId: string; jobId: string }> {
  if (!input.key.trim()) throw new ValidationError("email_key_missing", { key: "required" });
  if (!input.template.trim()) throw new ValidationError("email_template_missing", { template: "required" });
  const [existing] = await ctx.tx.select({ id: emailMessages.id }).from(emailMessages).where(eq(emailMessages.idempotencyKey, input.key));
  let emailMessageId = existing?.id;
  if (!emailMessageId) {
    const to = await recipientOf(ctx.tx, input);
    const headers: Record<string, string> = {};
    if (input.headers?.["In-Reply-To"]) headers["In-Reply-To"] = input.headers["In-Reply-To"];
    if (input.headers?.References) headers.References = input.headers.References;
    const [row] = await ctx.tx
      .insert(emailMessages)
      .values({
        personId: input.personId ?? null,
        toEmail: to,
        kind: "transactional",
        locale: input.locale,
        props: input.data,
        context: input.context ?? null,
        attachments: input.attachments ?? [],
        replyTo: input.replyTo ?? null,
        extraHeaders: Object.keys(headers).length ? headers : null,
        sendAt: input.sendAt ?? null,
        idempotencyKey: input.key,
        status: "queued",
      })
      .onConflictDoNothing({ target: emailMessages.idempotencyKey })
      .returning({ id: emailMessages.id });
    emailMessageId =
      row?.id ?? (await ctx.tx.select({ id: emailMessages.id }).from(emailMessages).where(eq(emailMessages.idempotencyKey, input.key)))[0]!.id;
  }
  const job = await ctx.enqueue({
    kind: "email.send",
    payload: { emailMessageId, template: input.template },
    key: emailSendJobKey(emailMessageId),
    lane: "fast",
    priority: 1,
    ...(input.sendAt ? { runAt: input.sendAt } : {}),
  });
  return { emailMessageId, jobId: job.id };
}

// Stubs (email Wave 1 and later) ----------------------------------------------------------

/** Marketing templates (automation rule A-31). */
export function queueMarketingEmail(_ctx: Ctx, _input: AutomationEmailInput): Promise<AutomationEmailResult> {
  return notYet("queueMarketingEmail");
}

/** Transactional templates sent by automation steps. */
export function queueAutomationEmail(_ctx: Ctx, _input: AutomationEmailInput): Promise<AutomationEmailResult> {
  return notYet("queueAutomationEmail");
}

/** The current published version of a template. */
export function getTemplateInfo(_db: DbOrTx, _slug: string): Promise<TemplateInfo | null> {
  return notYet("getTemplateInfo");
}

export function getPublishedTemplateInfo(_db: DbOrTx, _slugs: string[]): Promise<Map<string, TemplateInfo>> {
  return notYet("getPublishedTemplateInfo");
}

/** crm preference and unsubscribe routes; never writes. */
export function resolveLinkToken(
  _db: DbOrTx,
  _token: string,
): Promise<{ emailMessageId: string; personId: string; purpose: MarketingPurpose | null; locale: Locale; sentAt: Date } | null> {
  return notYet("resolveLinkToken");
}

export function listPublishedTemplates(
  _db: DbOrTx,
  _q?: string,
): Promise<{ slug: string; name: string; kind: TemplateKind; purpose: MarketingPurpose | null; locales: Locale[] }[]> {
  return notYet("listPublishedTemplates");
}

/** Creates the template and a published version 1 when the slug is absent; never touches an existing slug. */
export function seedTemplate(_tx: Tx, _input: SeedTemplateInput): Promise<{ templateId: string; created: boolean }> {
  return notYet("seedTemplate");
}

export function getReachability(
  _tx: DbOrTx,
  _personId: string,
  _purpose: MarketingPurpose,
): Promise<{ isReachable: boolean; blockedReason: "erased" | "no_email" | "restricted" | "suppressed" | "withdrawn" | "no_consent" | null }> {
  return notYet("getReachability");
}

/** R2, commerce. */
export function findLatestMessage(
  _db: DbOrTx,
  _input: { personId: string; templateSlug: string; after: Date },
): Promise<{ emailMessageId: string; status: MessageStatus; sentAt: Date | null; clickedAt: Date | null } | null> {
  return notYet("findLatestMessage");
}

export function cancelScheduledMessage(_ctx: Ctx, _input: { messageId: string }): Promise<{ cancelled: boolean }> {
  return notYet("cancelScheduledMessage");
}

/** crm archive guard: campaigns not terminal using the segment as audience or exclusion. */
export function isSegmentInUse(_db: DbOrTx, _segmentId: string): Promise<boolean> {
  return notYet("isSegmentInUse");
}

export function listPersonEmails(_db: DbOrTx, _personId: string, _page?: number): Promise<{ items: PersonEmailRow[]; nextPage: number | null }> {
  return notYet("listPersonEmails");
}

export function getCampaignStats(_db: DbOrTx, _campaignIds: string[]): Promise<CampaignStats[]> {
  return notYet("getCampaignStats");
}

/** ops daily digest. */
export function countBlockedMessages(_db: DbOrTx, _since: Date): Promise<number> {
  return notYet("countBlockedMessages");
}

export function getEmailHealth(
  _db: DbOrTx,
): Promise<{ oldestQueuedMinutes: number | null; deadSends15m: number; sent60m: number; failed5m: number; blockedTranslation5m: number }> {
  return notYet("getEmailHealth");
}

/** R3, ops dashboards. */
export function getCampaignAttribution(
  _db: DbOrTx,
  _input: { from: Date; to: Date },
): Promise<{ campaignId: string | null; automationId: string | null; name: string; orders: number; revenueCents: number; firstPurchases: number }[]> {
  return notYet("getCampaignAttribution");
}
