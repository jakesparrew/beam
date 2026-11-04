/**
 * Single messages (email spec rules 39 to 44, 51 to 53, 59): the transactional outbox and the
 * `email.send` handler. email-P3 took over platform-P7's Wave 0 `sendTransactional` and
 * `email.send` behind the same signature, job kind, key (`email:<message_id>`) and payload
 * (`{ emailMessageId, template }`).
 *
 * Queueing never throws for content problems (an unknown template key, data that fails the
 * schema, no address): the row is written and `email.send` sets `failed` with
 * `unknown_template`, `invalid_template_data` or `no_recipient` and raises a `PermanentError`, so
 * an email problem never rolls back a booking or a payment. The status of a permanent failure is
 * written with `writeDurably`, so it survives the rollback of the job transaction.
 */
import type { Tx } from "@beam/db";
import { emailMessages, persons, suppressions, vMarketingReachability, vPersonStatus } from "@beam/db/schema";
import { MissingTranslationError, PermanentError } from "@beam/core/errors";
import { emailHash } from "@beam/core/crm";
import { newLinkToken, type MarketingPurpose, type SendTransactionalInput } from "@beam/core/email";
import { isLocale, type Locale } from "@beam/core/i18n";
import { buildOutgoingEmail, type FooterParts } from "@beam/email";
import { personalise, tokenNames, type VariantRecipient } from "@beam/email/blocks";
import { renderEmail, type CopyOverrides } from "@beam/email/render";
import type { TemplateAttachment } from "@beam/email/templates/define";
import { IntegrationError } from "@beam/integrations/_shared";
import type { EmailAttachment } from "@beam/integrations/resend";
import { actorJson, and, eq, inArray, writeDurably, type Ctx } from "@/lib/ctx";
import { recordEvent } from "@/lib/events";
import { readFile } from "@/lib/files";
import type { JobCtx } from "@/lib/job-runner";
import { buildPreferenceUrls } from "@/modules/crm/api";
import { footerFor, loadSendSettings, senderFor } from "./context";
import { buildTokenValues } from "./merge-fields";
import { sinkDecision, storeRenderedCopy } from "./sink";
import { applyTracking } from "./tracking";
import { currentVersionOf, loadSendTemplate, registryTemplate, type SendTemplate } from "./templates-info";

export type MessageInsert = typeof emailMessages.$inferInsert;

/** The idempotency key of the `email.send` job of a message. */
export const emailSendJobKey = (emailMessageId: string): string => `email:${emailMessageId}`;

/** Priority of `email.send`: 1 for transactional mail, 5 for automation and the rest (rule 39). */
export const SEND_PRIORITY = { transactional: 1, automation: 5 } as const;

function requireTx(ctx: Ctx): Tx {
  if (!ctx?.tx) throw new Error("email: sendTransactional, queueMarketingEmail and queueAutomationEmail run inside the caller's transaction");
  return ctx.tx;
}

/**
 * Inserts the message (`on conflict (idempotency_key) do nothing`) and, while it is `queued`,
 * enqueues `email.send` with key `email:<message_id>`. The same key twice returns the existing
 * message and its job and creates nothing.
 */
export async function queueMessage(
  ctx: Ctx,
  values: MessageInsert,
  job: { template: string; priority: number; runAt?: Date | null; always?: boolean },
): Promise<{ emailMessageId: string; jobId: string | null; created: boolean; status: MessageInsert["status"] }> {
  const tx = requireTx(ctx);
  const [inserted] = await tx
    .insert(emailMessages)
    .values(values)
    .onConflictDoNothing({ target: emailMessages.idempotencyKey })
    .returning({ id: emailMessages.id, status: emailMessages.status });
  const row =
    inserted ??
    (await tx.select({ id: emailMessages.id, status: emailMessages.status }).from(emailMessages).where(eq(emailMessages.idempotencyKey, values.idempotencyKey)))[0];
  if (!row) throw new Error(`email: message ${values.idempotencyKey} vanished`);
  let jobId: string | null = null;
  // A queued message always has its job. The same key returns the existing job (jobs are unique
  // by key); a message that is not queued (suppressed, blocked) gets one only when `always`.
  if (row.status === "queued" || job.always) {
    const enqueued = await ctx.enqueue({
      kind: "email.send",
      payload: { emailMessageId: row.id, template: job.template },
      key: emailSendJobKey(row.id),
      lane: "fast",
      priority: job.priority,
      ...(job.runAt ? { runAt: job.runAt } : {}),
    });
    jobId = enqueued.id;
  }
  return { emailMessageId: row.id, jobId, created: !!inserted, status: row.status };
}

/** Only `In-Reply-To` and `References` are kept (R3 inbox threading). */
function threadingHeaders(headers: SendTransactionalInput["headers"]): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (headers?.["In-Reply-To"]) out["In-Reply-To"] = headers["In-Reply-To"];
  if (headers?.References) out.References = headers.References;
  return Object.keys(out).length ? out : null;
}

/**
 * Queues one transactional email in the caller's transaction (rule 39). `template` is a registry
 * key or the slug of a block-backed transactional template; a key that is neither is accepted and
 * fails at `email.send` with `unknown_template`. `to` wins over the person's email; with neither,
 * the row is written with no address and `email.send` fails it with `no_recipient`.
 */
export async function sendTransactional(ctx: Ctx, input: SendTransactionalInput): Promise<{ emailMessageId: string; jobId: string }> {
  const tx = requireTx(ctx);
  if (!input.key?.trim()) throw new PermanentError("email_key_missing");
  const [existing] = await tx.select({ id: emailMessages.id }).from(emailMessages).where(eq(emailMessages.idempotencyKey, input.key));
  let templateVersionId: string | null = null;
  let toEmail: string | null = input.to?.trim() || null;
  if (!existing) {
    const current = input.template ? await currentVersionOf(tx, input.template) : null;
    if (current && current.template.kind === "transactional") templateVersionId = current.version.id;
    if (!toEmail && input.personId) {
      const [p] = await tx.select({ email: persons.email }).from(persons).where(eq(persons.id, input.personId));
      toEmail = p?.email ?? null;
    }
  }
  const result = await queueMessage(
    ctx,
    {
      personId: input.personId ?? null,
      toEmail,
      kind: "transactional",
      fromDomain: "mail.beam.be",
      templateVersionId,
      locale: input.locale,
      props: input.data ?? {},
      context: input.context ?? null,
      attachments: input.attachments ?? [],
      replyTo: input.replyTo ?? null,
      extraHeaders: threadingHeaders(input.headers),
      sendAt: input.sendAt ?? null,
      idempotencyKey: input.key,
      status: "queued",
    },
    { template: input.template || "(none)", priority: SEND_PRIORITY.transactional, runAt: input.sendAt ?? null, always: true },
  );
  return { emailMessageId: result.emailMessageId, jobId: result.jobId ?? "" };
}

/**
 * Rule 59: a message still `queued` becomes `failed` with error `cancelled` (gift voucher refunded
 * before delivery); `email.send` then skips it.
 */
export async function cancelScheduledMessage(ctx: Ctx, input: { messageId: string }): Promise<{ cancelled: boolean }> {
  const tx = requireTx(ctx);
  const [row] = await tx.select({ id: emailMessages.id, status: emailMessages.status }).from(emailMessages).where(eq(emailMessages.id, input.messageId)).for("update");
  if (!row || row.status !== "queued") return { cancelled: false };
  await tx
    .update(emailMessages)
    .set({ status: "failed", error: "cancelled", updatedAt: ctx.now })
    .where(and(eq(emailMessages.id, row.id), eq(emailMessages.status, "queued")));
  return { cancelled: true };
}

/** Writes a permanent outcome that survives the job's rollback, then throws the `PermanentError`. */
export async function failMessage(
  ctx: Ctx,
  message: { id: string; personId: string | null },
  outcome: { status: "failed" | "blocked_translation"; error: string | null },
): Promise<never> {
  await writeDurably(ctx, async (db) => {
    await db
      .update(emailMessages)
      .set({ status: outcome.status, error: outcome.error, updatedAt: new Date() })
      .where(and(eq(emailMessages.id, message.id), eq(emailMessages.status, "queued")));
    if (outcome.status === "blocked_translation" && message.personId) {
      await recordEvent(db, actorJson(ctx.actor), {
        kind: "email.blocked",
        personId: message.personId,
        data: { reason: "translation" },
        ref: { type: "email_message", id: message.id },
        dedupeKey: `email:${message.id}:blocked`,
      });
    }
  });
  throw new PermanentError(outcome.error ?? outcome.status);
}

export { registryTemplate };

// ---------------------------------------------------------------------------
// email.send (rules 39 to 44, 51 to 53, 59)
// ---------------------------------------------------------------------------

/** Templates that ignore `complaint` suppressions: the person asked for them, or a security notice (rule 40). */
export const COMPLAINT_EXEMPT_TEMPLATES = ["platform.magic_link", "platform.password_reset", "platform.mfa_changed", "ops.privacy_erasure_scheduled"] as const;

/** Total attachment size above 10 MB fails permanently (rule 44). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type SendJobInput = { emailMessageId: string; template: string };
export type SendJobResult = { status: string; resendId: string | null };

type MessageRow = typeof emailMessages.$inferSelect;

/** Rule 40: the final checks; returns the reason a message must not leave, or null. */
async function blockedReason(
  tx: Tx,
  m: MessageRow,
  input: { to: string; templateKey: string; marketing: boolean; personErased: boolean },
): Promise<string | null> {
  if (m.kind === "test") return null;
  if (input.personErased) return "erased";
  if (input.marketing && m.personId && m.purpose) {
    const [r] = await tx
      .select({ isReachable: vMarketingReachability.isReachable, reason: vMarketingReachability.blockedReason })
      .from(vMarketingReachability)
      .where(and(eq(vMarketingReachability.personId, m.personId), eq(vMarketingReachability.purpose, m.purpose)));
    if (!r?.isReachable) return r?.reason ?? "unreachable";
  }
  const reasons: ("hard_bounce" | "complaint" | "erased")[] = (COMPLAINT_EXEMPT_TEMPLATES as readonly string[]).includes(input.templateKey)
    ? ["hard_bounce", "erased"]
    : ["hard_bounce", "complaint", "erased"];
  const [s] = await tx
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.emailHash, emailHash(input.to)), eq(suppressions.scope, "all"), inArray(suppressions.reason, reasons)))
    .limit(1);
  return s ? "suppressed" : null;
}

async function loadAttachments(ctx: JobCtx, m: MessageRow, generated: readonly TemplateAttachment[]): Promise<EmailAttachment[] | null> {
  const out: EmailAttachment[] = [];
  for (const a of m.attachments) {
    const file = await readFile(ctx.tx, a.fileId);
    if (!file) return null;
    out.push({ filename: a.filename, content: file.bytes, contentType: file.mime, ...(a.inline ? { inline: true } : {}) });
  }
  for (const g of generated) out.push({ filename: g.filename, content: g.content, contentType: g.contentType });
  return out;
}

/** `buildOutgoingEmail()`, with its permanent refusals (`list_unsubscribe_not_https`, ...) as an error code. */
function buildOutgoing(...args: Parameters<typeof buildOutgoingEmail>): ReturnType<typeof buildOutgoingEmail> | { error: string } {
  try {
    return buildOutgoingEmail(...args);
  } catch (error) {
    if (error instanceof PermanentError) return { error: error.message.split(":")[0]! };
    throw error;
  }
}

function resendErrorCode(error: IntegrationError): string {
  if (error.statusCode === 422) return "invalid_recipient";
  return `resend_4xx:${error.statusCode ?? "unknown"}`;
}

type Rendered = { subject: string; html: string; text: string; generated: TemplateAttachment[] };

/** Renders the template (placeholders kept) or returns the permanent outcome of a content problem. */
async function renderMessage(
  ctx: JobCtx,
  m: MessageRow,
  tpl: SendTemplate,
  input: { locale: Locale; props: unknown; footer: FooterParts | null },
): Promise<Rendered | { status: "failed" | "blocked_translation"; error: string | null }> {
  try {
    if (tpl.def) {
      const copy = (tpl.version?.copy ?? undefined) as CopyOverrides | undefined;
      const r = await renderEmail({ source: "code", template: tpl.def, locale: input.locale, props: input.props, ...(copy ? { copy } : {}), footer: input.footer });
      const generated = tpl.def.attachments ? await tpl.def.attachments(input.props, input.locale) : [];
      return { ...r, generated };
    }
    const v = tpl.version!;
    if (!input.footer) return { status: "failed", error: "footer_incomplete" };
    const [status] = m.personId ? await ctx.tx.select({ status: vPersonStatus.status }).from(vPersonStatus).where(eq(vPersonStatus.personId, m.personId)) : [];
    const r = await renderEmail({
      source: "blocks",
      locale: input.locale,
      subject: v.subject,
      preheader: v.preheader,
      document: v.document,
      compiled: v.htmlByLocale && v.textByLocale ? { htmlByLocale: v.htmlByLocale, textByLocale: v.textByLocale } : null,
      recipient: { status: (status?.status as VariantRecipient["status"]) ?? null, outcomes: {} },
      footer: input.footer,
    });
    return { ...r, generated: [] };
  } catch (error) {
    if (error instanceof MissingTranslationError) return { status: "blocked_translation", error: null };
    if (error instanceof PermanentError && error.message.startsWith("invalid_props")) return { status: "failed", error: "invalid_template_data" };
    if (error instanceof PermanentError && error.message.startsWith("missing_text_part")) return { status: "failed", error: "missing_text_part" };
    throw error;
  }
}

/** The `email.send` handler. A message that is not `queued` any more is left alone (second run, cancelled). */
export async function sendEmailMessage(ctx: JobCtx, input: SendJobInput): Promise<SendJobResult> {
  const [m] = await ctx.tx.select().from(emailMessages).where(eq(emailMessages.id, input.emailMessageId)).for("update");
  if (!m) throw new PermanentError("email_message_not_found");
  if (m.status !== "queued") return { status: m.status, resendId: m.resendId };
  const ref = { id: m.id, personId: m.personId };

  const tpl = await loadSendTemplate(ctx.tx, { templateVersionId: m.templateVersionId, key: input.template });
  if (!tpl) return failMessage(ctx, ref, { status: "failed", error: "unknown_template" });
  if (!isLocale(m.locale)) return failMessage(ctx, ref, { status: "blocked_translation", error: null });
  const locale = m.locale;

  const [person] = m.personId ? await ctx.tx.select({ email: persons.email, erasedAt: persons.erasedAt }).from(persons).where(eq(persons.id, m.personId)) : [];
  const current = person?.email ?? null;
  // Transactional mail goes where the caller said; campaign and automation mail to the current address (edge case 30).
  const to = (m.kind === "transactional" || m.kind === "test" ? (m.toEmail ?? current) : (current ?? m.toEmail))?.trim() || null;
  if (!to) return failMessage(ctx, ref, { status: "failed", error: "no_recipient" });

  // Marketing content: marketing templates, campaign messages and queueMarketingEmail sends (D54).
  const marketing = m.kind !== "test" && (m.purpose !== null || m.fromDomain === "news.beam.be");
  const purpose: MarketingPurpose | null = m.purpose ?? (marketing ? "newsletter" : null);

  if (await blockedReason(ctx.tx, m, { to, templateKey: tpl.key, marketing, personErased: !!person?.erasedAt })) {
    await ctx.tx.update(emailMessages).set({ status: "suppressed", error: null, updatedAt: ctx.now }).where(eq(emailMessages.id, m.id));
    if (m.personId && !person?.erasedAt) {
      await ctx.recordEvent({ kind: "email.blocked", personId: m.personId, data: { reason: "suppressed" }, ref: { type: "email_message", id: m.id }, dedupeKey: `email:${m.id}:blocked` });
    }
    return { status: "suppressed", resendId: null };
  }

  let props: unknown = m.props ?? {};
  if (tpl.def) {
    const parsed = tpl.def.props.safeParse(m.props ?? undefined);
    if (!parsed.success) return failMessage(ctx, ref, { status: "failed", error: "invalid_template_data" });
    props = parsed.data;
  }

  const sink = sinkDecision();
  const settings = await loadSendSettings(ctx.tx);
  const link = m.kind === "test" ? null : newLinkToken();
  const prefs = link ? buildPreferenceUrls(link.token, locale) : null;
  const preferenceUrls = prefs ? { preferencesUrl: prefs.preferencesUrl, unsubscribeUrl: prefs.unsubscribeUrl } : null;

  let footer: FooterParts | null;
  try {
    footer = await footerFor(ctx.tx, { settings, locale, purpose: marketing && purpose ? purpose : "transactional", personId: m.personId, preferenceUrls });
  } catch (error) {
    if (error instanceof MissingTranslationError) return failMessage(ctx, ref, { status: "blocked_translation", error: null });
    if (error instanceof PermanentError) return failMessage(ctx, ref, { status: "failed", error: "footer_incomplete" });
    throw error;
  }
  const rendered = await renderMessage(ctx, m, tpl, { locale, props, footer });
  if ("status" in rendered) return failMessage(ctx, ref, rendered);

  const names = tokenNames(`${rendered.subject}\n${rendered.html}\n${rendered.text}`);
  const values = await buildTokenValues(ctx.tx, {
    personId: m.personId,
    locale,
    context: m.context as Record<string, unknown> | null,
    names: [...names.tokens, ...names.mergeFields],
    links: preferenceUrls,
  });
  const subject = personalise(rendered.subject, values, { escape: false }).trim();
  let html = personalise(rendered.html, values, { escape: true });
  const text = personalise(rendered.text, values, { escape: false }).trim();
  if (!text) return failMessage(ctx, ref, { status: "failed", error: "missing_text_part" });

  // Rule 51: transactional messages carry no pixel and no click rewriting.
  let links: string[] | null = null;
  if (marketing && link) ({ html, links } = applyTracking(html, link.token));

  const attachments = await loadAttachments(ctx, m, rendered.generated);
  if (!attachments) return failMessage(ctx, ref, { status: "failed", error: "attachment_not_found" });
  if (attachments.reduce((n, a) => n + a.content.byteLength, 0) > MAX_ATTACHMENT_BYTES) return failMessage(ctx, ref, { status: "failed", error: "attachment_too_large" });

  const sender = senderFor(settings, m.fromDomain);
  const outgoing = buildOutgoing(
    {
      messageId: m.id,
      messageKind: m.kind,
      campaignId: m.campaignId,
      to,
      subject: m.kind === "test" ? `[TEST] ${subject}` : subject,
      html,
      text,
      headers: { ...(m.extraHeaders ?? {}) },
      ...(attachments.length ? { attachments } : {}),
    },
    {
      kind: marketing ? "marketing" : "transactional",
      from: sender.from,
      replyTo: m.replyTo ?? sender.replyTo,
      listUnsubscribe: prefs ? { oneClickPostUrl: prefs.oneClickPostUrl } : null,
      sinkRewrite: !sink.production && sink.sink ? { sink: sink.sink, env: sink.env } : null,
    },
  );
  if ("error" in outgoing) return failMessage(ctx, ref, { status: "failed", error: outgoing.error });

  const renderedFileId = sink.production ? m.renderedFileId : await storeRenderedCopy(ctx, { messageId: m.id, templateKey: tpl.key, html, personId: m.personId });

  let resendId: string;
  try {
    ({ id: resendId } = await ctx.integrations.resend.sendEmail({ ...outgoing, idempotencyKey: emailSendJobKey(m.id) }));
  } catch (error) {
    if (error instanceof IntegrationError && !error.retryable) return failMessage(ctx, ref, { status: "failed", error: resendErrorCode(error) });
    throw error;
  }

  await ctx.tx
    .update(emailMessages)
    .set({ status: "sent", resendId, sentAt: ctx.now, toEmail: to, subject, renderedFileId, linkTokenHash: link?.hash ?? null, links, error: null, updatedAt: ctx.now })
    .where(eq(emailMessages.id, m.id));
  if (m.personId && m.kind !== "test") {
    await ctx.recordEvent({
      kind: "email.sent",
      personId: m.personId,
      data: { template_slug: tpl.key, campaign_id: m.campaignId, enrolment_id: m.enrolmentId },
      ref: { type: "email_message", id: m.id },
      dedupeKey: `email:${m.id}:sent`,
    });
  }
  return { status: "sent", resendId };
}
