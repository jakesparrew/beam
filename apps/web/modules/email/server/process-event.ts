/**
 * Resend events (email spec rules 46 to 49, 52; edge cases 1 to 3). `processResendEvent()` is the
 * `handle` of the `defineWebhookHandler({ provider: 'resend' })` registration in `jobs.ts` and runs
 * inside platform's `webhook.process` job transaction.
 *
 * - The event is stored once in `email_events` (`resend_event_id` = the `svix-id`, unique: a
 *   second delivery is a no-op); unknown types and unknown `resend_id`s change nothing (the raw
 *   payload stays in `webhook_events`). `email.received` (R3 inbound) is not an outbound event and
 *   is dispatched by email-P9; it is ignored here.
 * - The message moves forward only by rank; first-occurrence timestamps are set once.
 * - Hard bounce -> `crm.addSuppression` scope `all` reason `hard_bounce`; complaint -> reason
 *   `complaint` (crm withdraws every marketing consent and asks automation to exit enrolments).
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
import { addSuppression } from "@/modules/crm/api";

export const SOFT_BOUNCE_LIMIT = 3;
export const SOFT_BOUNCE_WINDOW_DAYS = 30;
export const SOFT_BOUNCE_RETRY_DELAY_MS = 60 * 60 * 1000;

type ResendPayload = {
  type?: unknown;
  created_at?: unknown;
  data?: { email_id?: unknown; created_at?: unknown; bounce?: { type?: unknown; subType?: unknown; message?: unknown }; reason?: unknown; click?: { link?: unknown } };
};

export type ProcessOutcome =
  | { outcome: "ignored"; reason: "unknown_type" | "inbound" | "no_message_id" | "unknown_message" | "duplicate" }
  | { outcome: "processed"; messageId: string; type: EmailEventType };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

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
  if (type === "received") return { outcome: "ignored", reason: "inbound" };
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
