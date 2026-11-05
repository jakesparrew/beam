/**
 * Inbox jobs and the Meta webhook handler (crm spec 4.5), crm-P9. `INBOX_JOBS` and
 * `metaWebhookHandler` are the definitions crm's `jobs.ts` facade registers (literal kinds there).
 *
 * - `crm.send_meta_reply` (fast / 1, key `meta_reply:<message_id>`): sends one `out` message of
 *   a Meta thread through the Send API. A message that already has its Meta `mid` is not sent
 *   again. 4xx (window closed, permission) and `settings.inbox.meta_enabled = false` are
 *   permanent: `delivery_error` is stored (it survives the rollback) and the job is dead.
 * - `crm.close_stale_threads` (bulk / 9): `pending` threads without a message for
 *   `settings.inbox.stale_pending_days` (14) days become `resolved` (rule 3.57).
 * - `crm.escalate_threads` (fast / 5): an `open` thread whose oldest unanswered inbound message
 *   is `settings.inbox.escalation_hours` (24) opening hours old (`settings.business_hours`; hours
 *   outside opening time do not count) is escalated once: `escalated_at`, one high `follow_up`
 *   task for the assignee (else the first active user of `default_assignee_role`), one Slack line
 *   and `inbox.escalated` on the linked person, all keyed `inbox:<thread_id>:escalated`.
 * - Webhook handler `meta` (inside platform's `webhook.process`): every inbound message of the
 *   stored delivery goes through `ingestMetaMessage` (one message per `mid`).
 */
import { z } from "zod";
import type { Tx } from "@beam/db";
import { inboxMessages, inboxThreads, type RoleKey } from "@beam/db/schema";
import type { BusinessHours } from "@beam/core/booking";
import { PermanentError } from "@beam/core/errors";
import { BRUSSELS, wallClock, weekdayOf, zonedTimeToUtc } from "@beam/core/platform";
import { IntegrationError } from "@beam/integrations/_shared";
import { createMetaMessagingClient, createMetaMessagingFake, type MetaMessagingClient, type MetaMessagingFake } from "@beam/integrations/meta-messaging";
import { and, eq, isNull, lt, sql, ValidationError, writeDurably } from "@/lib/ctx";
import { integrationMode, routedOnCall } from "@/lib/integrations";
import { defineJob, type JobCtx } from "@/lib/job-runner";
import { getSetting } from "@/lib/settings";
import { defineWebhookHandler } from "@/lib/webhooks";
import { notifySlack } from "@/modules/platform/api";
import { userLocale } from "../pipeline/api";
import { createTask, resolveTaskOwner } from "../tasks/api";
import { ingestMetaMessage, isMetaChannel } from "./api";

export const SendMetaReplyInput = z.object({ messageId: z.uuid() });
export const CloseStaleThreadsInput = z.object({});
export const EscalateThreadsInput = z.object({});

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Meta client selection
// ---------------------------------------------------------------------------

let processMetaFake: MetaMessagingFake | undefined;
let override: MetaMessagingClient | undefined;

/** The process's Meta fake (local, preview, e2e): every send made in fake mode lands here. */
export function metaMessagingFake(): MetaMessagingFake {
  return (processMetaFake ??= createMetaMessagingFake({ onCall: routedOnCall }));
}

/** Tests install a client (usually a fake); `undefined` restores the environment rule. */
export function setMetaMessagingClient(client: MetaMessagingClient | undefined): void {
  override = client;
}

/**
 * The Meta client: real with `META_APP_SECRET` and `META_PAGE_ACCESS_TOKEN` under the rule of
 * runbook section 1.5 (`integrationMode('meta', 'META_PAGE_ACCESS_TOKEN')`), else the fake.
 */
export function metaMessagingClient(env: Readonly<Record<string, string | undefined>> = process.env): MetaMessagingClient {
  if (override) return override;
  if (integrationMode("meta", "META_PAGE_ACCESS_TOKEN", env) === "fake") return metaMessagingFake();
  return createMetaMessagingClient({ appSecret: env.META_APP_SECRET ?? "", pageAccessToken: env.META_PAGE_ACCESS_TOKEN ?? "", onCall: routedOnCall });
}

// ---------------------------------------------------------------------------
// Opening hours (rule 3.57)
// ---------------------------------------------------------------------------

const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
};

/**
 * The instant at which `hours` opening hours have passed since `start`, counting only the
 * Brussels opening time of `businessHours.week` (ISO weekday 1 = Monday). `null` when the week
 * has no opening time at all.
 */
export function openingHoursDueAt(start: Date, hours: number, businessHours: Pick<BusinessHours, "week">): Date | null {
  let remaining = hours * HOUR_MS;
  let cursor = start.getTime();
  const first = wallClock(start, BRUSSELS);
  let day = { year: first.year, month: first.month, day: first.day };
  for (let guard = 0; guard < 800; guard++) {
    const wd = weekdayOf(day);
    const open = businessHours.week[(wd === 0 ? 7 : wd) as 1 | 2 | 3 | 4 | 5 | 6 | 7];
    if (open) {
      const from = zonedTimeToUtc({ ...day, ...hm(open.opens_at) }, BRUSSELS).getTime();
      const to = zonedTimeToUtc({ ...day, ...hm(open.closes_at) }, BRUSSELS).getTime();
      const begin = Math.max(cursor, from);
      if (to > begin) {
        if (to - begin >= remaining) return new Date(begin + remaining);
        remaining -= to - begin;
        cursor = to;
      }
    }
    const next = new Date(Date.UTC(day.year, day.month - 1, day.day + 1));
    day = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
  }
  return null;
}

// ---------------------------------------------------------------------------
// crm.send_meta_reply
// ---------------------------------------------------------------------------

export type SendMetaReplyResult = { status: "sent"; mid: string } | { status: "already_sent"; mid: string };

/** `crm.send_meta_reply` (rule 3.50). */
export async function runSendMetaReply(ctx: JobCtx, input: z.infer<typeof SendMetaReplyInput>): Promise<SendMetaReplyResult> {
  const [row] = await ctx.tx
    .select({ m: inboxMessages, t: inboxThreads })
    .from(inboxMessages)
    .innerJoin(inboxThreads, eq(inboxThreads.id, inboxMessages.threadId))
    .where(eq(inboxMessages.id, input.messageId));
  if (!row) throw new PermanentError("inbox_message_not_found");
  const { m, t } = row;
  if (m.externalMessageId) return { status: "already_sent", mid: m.externalMessageId };
  const fail = async (reason: string): Promise<never> => {
    await writeDurably(ctx, async (db) => {
      await db.update(inboxMessages).set({ deliveryError: reason.slice(0, 500) }).where(eq(inboxMessages.id, m.id));
    });
    throw new PermanentError(`meta_reply_failed: ${reason}`);
  };
  if (m.direction !== "out" || !isMetaChannel(t.channel) || !t.externalThreadId) return fail("not_a_meta_reply");
  const settings = await getSetting(ctx.tx, "inbox");
  if (!settings.meta_enabled) return fail("meta_disabled");
  try {
    const { messageId } = await metaMessagingClient().sendMessage({ recipientPsid: t.externalThreadId, text: m.body });
    await ctx.tx.update(inboxMessages).set({ externalMessageId: messageId, deliveryError: null }).where(eq(inboxMessages.id, m.id));
    return { status: "sent", mid: messageId };
  } catch (error) {
    if (error instanceof IntegrationError && !error.retryable) return fail(error.code ?? `status_${error.statusCode ?? "unknown"}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// crm.close_stale_threads
// ---------------------------------------------------------------------------

/** `crm.close_stale_threads` (rule 3.57). */
export async function runCloseStaleThreads(ctx: JobCtx, _input: z.infer<typeof CloseStaleThreadsInput>): Promise<{ resolved: number }> {
  const { stale_pending_days } = await getSetting(ctx.tx, "inbox");
  const cutoff = new Date(ctx.now.getTime() - stale_pending_days * DAY_MS);
  const rows = await ctx.tx
    .update(inboxThreads)
    .set({ status: "resolved", resolvedAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(inboxThreads.status, "pending"), lt(inboxThreads.lastMessageAt, cutoff), sql`coalesce(${inboxThreads.lastInboundAt}, ${inboxThreads.createdAt}) < ${cutoff}`))
    .returning({ id: inboxThreads.id });
  return { resolved: rows.length };
}

// ---------------------------------------------------------------------------
// crm.escalate_threads
// ---------------------------------------------------------------------------

const ESCALATED: Record<string, string> = {
  "nl-BE": "Inboxbericht wacht op antwoord",
  "fr-BE": "Message de la boîte de réception sans réponse",
  en: "Inbox message waiting for a reply",
};

export const threadEscalationKey = (threadId: string) => `inbox:${threadId}:escalated`;

async function escalationOwner(tx: Tx, assigneeUserId: string | null, role: string): Promise<string | null> {
  if (assigneeUserId) return assigneeUserId;
  try {
    return await resolveTaskOwner(tx, { ownerRole: (role || "customer_service") as RoleKey });
  } catch (error) {
    if (error instanceof ValidationError) return null;
    throw error;
  }
}

/** `crm.escalate_threads` (rule 3.57, edge case 37). */
export async function runEscalateThreads(ctx: JobCtx, _input: z.infer<typeof EscalateThreadsInput>): Promise<{ escalated: number }> {
  const { escalation_hours, default_assignee_role } = await getSetting(ctx.tx, "inbox");
  const businessHours = await getSetting(ctx.tx, "business_hours");
  const candidates = await ctx.tx
    .select({
      id: inboxThreads.id,
      oldest: sql<Date | string | null>`(select min(m.occurred_at) from inbox_messages m where m.thread_id = ${inboxThreads.id} and m.direction = 'in'
        and m.occurred_at > coalesce((select max(o.occurred_at) from inbox_messages o where o.thread_id = ${inboxThreads.id} and o.direction = 'out'), '-infinity'::timestamptz))`,
    })
    .from(inboxThreads)
    .where(and(eq(inboxThreads.status, "open"), isNull(inboxThreads.escalatedAt)))
    .orderBy(inboxThreads.lastMessageAt, inboxThreads.id);

  let escalated = 0;
  for (const c of candidates) {
    if (!c.oldest) continue;
    const due = openingHoursDueAt(new Date(c.oldest), escalation_hours, businessHours);
    if (!due || ctx.now.getTime() < due.getTime()) continue;
    const [t] = await ctx.tx
      .select()
      .from(inboxThreads)
      .where(and(eq(inboxThreads.id, c.id), eq(inboxThreads.status, "open"), isNull(inboxThreads.escalatedAt)))
      .for("update", { skipLocked: true });
    if (!t) continue;
    const ownerUserId = await escalationOwner(ctx.tx, t.assigneeUserId, default_assignee_role);
    if (!ownerUserId) continue; // nobody to own the task: try again on the next run
    const key = threadEscalationKey(t.id);
    const locale = await userLocale(ctx.tx, ownerUserId);
    const about = t.subject ?? t.fromName ?? t.fromAddress ?? t.channel;
    const task = await createTask(ctx.tx, ctx, {
      title: `${ESCALATED[locale] ?? ESCALATED.en}: ${about}`.slice(0, 200),
      kind: "follow_up",
      priority: "high",
      ownerUserId,
      dueAt: ctx.now,
      ...(t.personId ? { personId: t.personId } : {}),
      source: "system",
      ref: { type: "inbox_thread", id: t.id },
      dedupeKey: key,
    });
    await ctx.tx.update(inboxThreads).set({ escalatedAt: ctx.now, updatedAt: ctx.now }).where(eq(inboxThreads.id, t.id));
    if (!task.created) continue;
    await notifySlack(ctx, { fingerprint: key, severity: "normal", text: `Inbox thread ${t.id} (${t.channel}) has waited ${escalation_hours} opening hours for a reply.` });
    if (t.personId) {
      await ctx.recordEvent({ kind: "inbox.escalated", personId: t.personId, ref: { type: "inbox_thread", id: t.id }, data: { thread_id: t.id, channel: t.channel }, dedupeKey: key });
    }
    escalated++;
  }
  return { escalated };
}

// ---------------------------------------------------------------------------
// Registrations (declared with literal keys in crm's `jobs.ts` facade)
// ---------------------------------------------------------------------------

/** The `meta` webhook handler: ingests every inbound message of the stored delivery. */
export async function handleMetaWebhook(ctx: JobCtx, event: { id: string; payload: unknown }): Promise<{ ingested: number }> {
  let ingested = 0;
  for (const inbound of metaMessagingClient().parseWebhook(event.payload)) {
    const { created } = await ingestMetaMessage(ctx.tx, ctx, inbound);
    if (created) ingested++;
  }
  return { ingested };
}

export const metaWebhookHandler = defineWebhookHandler({
  provider: "meta",
  handle: async (ctx, event) => {
    await handleMetaWebhook(ctx, event);
  },
});

export const INBOX_JOBS = [
  defineJob({ kind: "crm.send_meta_reply" as never, lane: "fast", priority: 1, input: SendMetaReplyInput, run: runSendMetaReply }),
  defineJob({ kind: "crm.close_stale_threads" as never, lane: "bulk", priority: 9, input: CloseStaleThreadsInput, run: runCloseStaleThreads }),
  defineJob({ kind: "crm.escalate_threads" as never, lane: "fast", priority: 5, input: EscalateThreadsInput, run: runEscalateThreads }),
];
