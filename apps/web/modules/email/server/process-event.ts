/**
 * Resend events (email spec rules 46 to 49, 52; edge cases 1 to 3). `processResendEvent()` is the
 * `handle` of the `defineWebhookHandler({ provider: 'resend' })` registration in `jobs.ts` and runs
 * inside platform's `webhook.process` job transaction.
 *
 * - The event is stored once in `email_events` (`resend_event_id` = the `svix-id`, unique: a
 *   second delivery is a no-op); unknown types and unknown `resend_id`s change nothing (the raw
 *   payload stays in `webhook_events`).
 * - R3 (email-P9): `email.received` (Resend Inbound on `in.beam.be`) is not an outbound event. The
 *   payload is mapped to crm's input (`messageId` from the Message-ID header, `inReplyTo`, `from`,
 *   `fromName`, `subject`, `text`, `attachmentCount`, `receivedAt`) and passed to
 *   `crm.ingestInboundEmail` in this transaction (never the raw payload, cross-module D10);
 *   nothing is stored in `email_*` tables. crm is idempotent on `messageId`; the platform stores
 *   one `webhook_events` row per svix id, so one delivery is one call.
 * - The message moves forward only by rank; first-occurrence timestamps are set once.
 * - Hard bounce -> `crm.addSuppression` scope `all` reason `hard_bounce`; complaint -> reason
 *   `complaint` (crm withdraws every marketing consent and asks automation to exit enrolments).
 *   A hard bounce of a campaign message then re-evaluates the bounce-rate auto-pause
 *   (`evaluateBounceRate`, rule 37).
 * - Soft bounce of a transactional message (attempt 1) -> `email.retry_soft_bounce` one hour
 *   later. Three soft bounces of the same address within 30 days -> `addSuppression` scope `all`,
 *   reason `hard_bounce`, source `soft_bounce_x3`; the count runs under the message row lock.
 */
import { emailEvents, emailMessages, webhookEvents } from "@beam/db/schema";
import { bounceTypeOf, mapResendEventType, messageEventPatch, type EmailEventType } from "@beam/core/email";
import { and, eq, gte, isNotNull, ne, sql } from "@/lib/ctx";
import { logger } from "@/lib/logger";
import { rowsOf } from "@/lib/sensitive";
import type { JobCtx } from "@/lib/job-runner";
import { addSuppression, ingestInboundEmail } from "@/modules/crm/api";
import { evaluateBounceRate } from "./auto-pause";

export const SOFT_BOUNCE_LIMIT = 3;
export const SOFT_BOUNCE_WINDOW_DAYS = 30;
export const SOFT_BOUNCE_RETRY_DELAY_MS = 60 * 60 * 1000;

type ResendPayload = {
  type?: unknown;
  created_at?: unknown;
  data?: {
    email_id?: unknown;
    created_at?: unknown;
    bounce?: { type?: unknown; subType?: unknown; message?: unknown };
    reason?: unknown;
    click?: { link?: unknown };
    // email.received (Resend Inbound)
    from?: unknown;
    subject?: unknown;
    text?: unknown;
    html?: unknown;
    message_id?: unknown;
    in_reply_to?: unknown;
    headers?: unknown;
    attachments?: unknown;
  };
};

export type ProcessOutcome =
  | { outcome: "ignored"; reason: "unknown_type" | "no_message_id" | "unknown_message" | "duplicate" }
  | { outcome: "processed"; messageId: string; type: EmailEventType }
  | { outcome: "inbound"; threadId: string };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** crm's `ingestInboundEmail` input (crm spec 4.8, email rule 46). */
export type InboundEmailInput = {
  messageId: string;
  inReplyTo?: string;
  from: string;
  fromName?: string;
  subject: string;
  text: string;
  attachmentCount: number;
  receivedAt: Date;
};

/** A header of an inbound payload, case-insensitive; Resend sends `headers` as an object or as `[{ name, value }]`. */
function headerOf(headers: unknown, name: string): string | null {
  const want = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (const h of headers as unknown[]) {
      const entry = h as { name?: unknown; value?: unknown } | null;
      if (entry && typeof entry.name === "string" && entry.name.toLowerCase() === want) return str(entry.value);
    }
    return null;
  }
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) if (k.toLowerCase() === want) return str(Array.isArray(v) ? v[0] : v);
  }
  return null;
}

/** The first `<id>` of a Message-ID or In-Reply-To value (kept with its brackets), else the trimmed value. */
function messageIdOf(v: string | null): string | null {
  if (!v) return null;
  const m = /<[^<>\s]+>/.exec(v);
  return m ? m[0] : v.trim() || null;
}

/** `"Name" <a@b>` or `a@b` as address and display name. */
export function parseAddress(raw: string | null): { address: string; name: string | null } {
  if (!raw) return { address: "", name: null };
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+)>\s*$/.exec(raw);
  if (m) return { address: m[2]!.trim().toLowerCase(), name: m[1]?.trim() || null };
  return { address: raw.trim().toLowerCase(), name: null };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** A plain-text rendering of an HTML body, for inbound mail without a text part. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === "#") {
        const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Rule 46 (R3): the `email.received` payload as crm's input, or null without a Message-ID (crm
 * needs it as the idempotency key; such a delivery stays in `webhook_events` only).
 */
export function inboundEmailInput(p: ResendPayload): InboundEmailInput | null {
  const d = p.data ?? {};
  const messageId = messageIdOf(headerOf(d.headers, "message-id") ?? str(d.message_id));
  if (!messageId) return null;
  const inReplyTo = messageIdOf(headerOf(d.headers, "in-reply-to") ?? str(d.in_reply_to));
  const from = parseAddress(str(d.from) ?? headerOf(d.headers, "from"));
  const text = str(d.text) ?? (str(d.html) ? htmlToPlainText(d.html as string) : "");
  return {
    messageId,
    ...(inReplyTo ? { inReplyTo } : {}),
    from: from.address,
    ...(from.name ? { fromName: from.name } : {}),
    subject: typeof d.subject === "string" ? d.subject.trim() : "",
    text,
    attachmentCount: Array.isArray(d.attachments) ? d.attachments.length : 0,
    receivedAt: occurredAt(p),
  };
}

function occurredAt(p: ResendPayload): Date {
  const raw = str(p.data?.created_at) ?? str(p.created_at);
  const d = raw ? new Date(raw) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Only `{ bounce: { type, subType, message } }` or `{ reason }`; never addresses or IP. */
function eventPayload(type: EmailEventType, p: ResendPayload): Record<string, unknown> {
  if (type === "bounced" && p.data?.bounce) {
    const b = p.data.bounce;
    return { bounce: { type: str(b.type), subType: str(b.subType), message: str(b.message)?.slice(0, 500) ?? null } };
  }
  if (type === "failed" || type === "delayed") {
    const reason = str(p.data?.reason);
    return reason ? { reason: reason.slice(0, 200) } : {};
  }
  return {};
}

/** True for a message whose content is transactional (retried once on a soft bounce, rule 49). */
const isTransactional = (m: { kind: string; purpose: string | null }) => m.kind === "transactional" || (m.kind === "automation" && m.purpose === null);

export async function processResendEvent(ctx: JobCtx, event: { id: string; payload: unknown }): Promise<ProcessOutcome> {
  const p = (event.payload ?? {}) as ResendPayload;
  const type = mapResendEventType(str(p.type) ?? "");
  if (type === null) return { outcome: "ignored", reason: "unknown_type" };
  if (type === "received") {
    const input = inboundEmailInput(p);
    if (!input) {
      logger.info({ webhookEventId: event.id }, "email: inbound mail without a Message-ID (no_message_id)");
      return { outcome: "ignored", reason: "no_message_id" };
    }
    const { threadId } = await ingestInboundEmail(ctx.tx, ctx, input);
    return { outcome: "inbound", threadId };
  }
  const resendId = str(p.data?.email_id);
  if (!resendId) return { outcome: "ignored", reason: "no_message_id" };

  const [m] = await ctx.tx.select().from(emailMessages).where(eq(emailMessages.resendId, resendId)).for("update");
  if (!m) {
    logger.info({ resendId, webhookEventId: event.id }, "email: webhook for an unknown message (unknown_message)");
    return { outcome: "ignored", reason: "unknown_message" };
  }

  const [stored] = await ctx.tx.select({ externalEventId: webhookEvents.externalEventId }).from(webhookEvents).where(eq(webhookEvents.id, event.id));
  const at = occurredAt(p);
  const bounceType = type === "bounced" ? bounceTypeOf(str(p.data?.bounce?.type)) : null;
  const link = str(p.data?.click?.link);
  const inserted = await ctx.tx
    .insert(emailEvents)
    .values({
      emailMessageId: m.id,
      type,
      source: "resend",
      resendEventId: stored?.externalEventId ?? event.id,
      ...(type === "clicked" && link ? { url: link.slice(0, 2000) } : {}),
      payload: eventPayload(type, p),
      occurredAt: at,
    })
    .onConflictDoNothing({ target: emailEvents.resendEventId })
    .returning({ id: emailEvents.id });
  if (!inserted.length) return { outcome: "ignored", reason: "duplicate" };

  const patch = messageEventPatch(
    {
      status: m.status,
      bounceType: m.bounceType,
      sentAt: m.sentAt,
      deliveredAt: m.deliveredAt,
      openedAt: m.openedAt,
      clickedAt: m.clickedAt,
      bouncedAt: m.bouncedAt,
      complainedAt: m.complainedAt,
      lastEventAt: m.lastEventAt,
    },
    { type, occurredAt: at, bounceType },
  );
  if (type === "failed" && patch.status === "failed") Object.assign(patch, { error: "resend_failed" });
  if (Object.keys(patch).length) await ctx.tx.update(emailMessages).set({ ...patch, updatedAt: ctx.now }).where(eq(emailMessages.id, m.id));

  const ref = { type: "email_message", id: m.id };
  if (type === "bounced" && m.personId && m.bouncedAt === null) {
    await ctx.recordEvent({ kind: "email.bounced", personId: m.personId, data: { bounce_type: bounceType ?? "soft" }, ref, dedupeKey: `email:${m.id}:bounced` });
  }
  if (type === "complained" && m.personId && m.complainedAt === null) {
    await ctx.recordEvent({ kind: "email.complained", personId: m.personId, data: {}, ref, dedupeKey: `email:${m.id}:complained` });
  }

  if (m.toEmail && type === "bounced" && bounceType === "hard") {
    await addSuppression(ctx.tx, ctx, { email: m.toEmail, scope: "all", reason: "hard_bounce", source: `resend:${resendId}`, ...(m.personId ? { personId: m.personId } : {}) });
  }
  if (type === "bounced" && bounceType === "hard" && m.kind === "campaign" && m.campaignId) {
    await evaluateBounceRate(ctx.tx, m.campaignId, ctx);
  }
  if (m.toEmail && type === "complained") {
    await addSuppression(ctx.tx, ctx, { email: m.toEmail, scope: "all", reason: "complaint", source: `resend:${resendId}`, ...(m.personId ? { personId: m.personId } : {}) });
  }
  if (m.toEmail && type === "bounced" && bounceType === "soft") await handleSoftBounce(ctx, m, at);
  return { outcome: "processed", messageId: m.id, type };
}

async function handleSoftBounce(ctx: JobCtx, m: typeof emailMessages.$inferSelect, at: Date): Promise<void> {
  const since = new Date(at.getTime() - SOFT_BOUNCE_WINDOW_DAYS * 86_400_000);
  const [count] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(emailMessages)
    .where(
      and(
        sql`lower(${emailMessages.toEmail}) = lower(${m.toEmail})`,
        eq(emailMessages.bounceType, "soft"),
        isNotNull(emailMessages.bouncedAt),
        gte(emailMessages.bouncedAt, since),
      ),
    );
  if ((count?.n ?? 0) >= SOFT_BOUNCE_LIMIT) {
    await addSuppression(ctx.tx, ctx, { email: m.toEmail!, scope: "all", reason: "hard_bounce", source: "soft_bounce_x3", ...(m.personId ? { personId: m.personId } : {}) });
    return;
  }
  if (isTransactional(m) && m.attempt === 1) {
    await ctx.enqueue({
      kind: "email.retry_soft_bounce",
      payload: { emailMessageId: m.id },
      key: `email:${m.id}:retry`,
      runAt: new Date(at.getTime() + SOFT_BOUNCE_RETRY_DELAY_MS),
    });
  }
}

/**
 * `email.retry_soft_bounce` (rule 49): one new message (`attempt = 2`, `retry_of_message_id`, key
 * `<original key>:retry`) queued for `email.send`. Idempotent through the key.
 */
export async function retrySoftBounce(ctx: JobCtx, input: { emailMessageId: string }): Promise<{ retryMessageId: string | null }> {
  const [m] = await ctx.tx.select().from(emailMessages).where(eq(emailMessages.id, input.emailMessageId));
  if (!m || m.attempt !== 1 || m.bounceType !== "soft" || !isTransactional(m)) return { retryMessageId: null };
  const key = `${m.idempotencyKey}:retry`;
  const [inserted] = await ctx.tx
    .insert(emailMessages)
    .values({
      personId: m.personId,
      toEmail: m.toEmail,
      kind: m.kind,
      purpose: m.purpose,
      templateVersionId: m.templateVersionId,
      campaignId: m.campaignId,
      enrolmentId: m.enrolmentId,
      locale: m.locale,
      props: m.props,
      context: m.context,
      attachments: m.attachments,
      replyTo: m.replyTo,
      extraHeaders: m.extraHeaders,
      fromDomain: m.fromDomain,
      idempotencyKey: key,
      attempt: 2,
      retryOfMessageId: m.id,
      status: "queued",
    })
    .onConflictDoNothing({ target: emailMessages.idempotencyKey })
    .returning({ id: emailMessages.id });
  const retry = inserted ?? (await ctx.tx.select({ id: emailMessages.id }).from(emailMessages).where(and(eq(emailMessages.idempotencyKey, key), ne(emailMessages.id, m.id))))[0];
  if (!retry) return { retryMessageId: null };
  const template = await templateKeyOf(ctx, m);
  await ctx.enqueue({ kind: "email.send", payload: { emailMessageId: retry.id, template }, key: `email:${retry.id}`, lane: "fast", priority: m.kind === "transactional" ? 1 : 5 });
  return { retryMessageId: retry.id };
}

/** The `template` of the original `email.send` payload (the registry key or slug). */
async function templateKeyOf(ctx: JobCtx, m: typeof emailMessages.$inferSelect): Promise<string> {
  const rows = rowsOf<{ template: string | null }>(
    await ctx.tx.execute(sql`select payload->>'template' as template from jobs where idempotency_key = ${`email:${m.id}`} limit 1`),
  );
  return rows[0]?.template ?? "(none)";
}
