/**
 * The unified inbox (crm rules 3.49, 3.50, 3.57; crm spec 4.2 and 4.8), crm-P9.
 *
 * Ingest (other modules and the Meta webhook): `ingestInboundEmail` (email's `email.received`),
 * `createInboxThreadFromForm` (forms) and `ingestMetaMessage` (crm's `meta` webhook handler).
 * Every inbound message is inserted `on conflict (external_message_id) do nothing`, so a repeated
 * delivery changes nothing. It is linked to the active person whose email (or stored
 * `external_ids.meta_psid`) matches; otherwise the thread has no person (rule 3.49). Inbound
 * never creates a person or consent. A new inbound message moves `pending` and `resolved` to
 * `open` (rule 3.57).
 *
 * Staff handlers (called by `./actions`, testable with a plain `Ctx`): reply, note, assign and
 * status, link person, mark sensitive and reply templates. They write their own audit rows
 * (`inbox.reply|note|update|link|sensitive|template`).
 *
 * Email threading: a thread's `external_thread_id` is the Message-ID of its first message. A new
 * email joins the thread of the message its `In-Reply-To` names; without a match it joins the
 * newest non-resolved email thread from the same address whose subject is the same once `Re:`
 * and `Fwd:` prefixes are removed; otherwise it starts a thread.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { inboxMessages, inboxReplyTemplates, inboxThreads, persons, type InboxChannel, type InboxThreadStatus } from "@beam/db/schema";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import { missingLocales } from "@beam/core/i18n";
import type { MetaInbound } from "@beam/integrations/meta-messaging";
import { and, ConflictError, desc, eq, isNull, ne, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import type { EventCtx } from "../api";

export type InboxThreadRecord = typeof inboxThreads.$inferSelect;
export type InboxMessageRecord = typeof inboxMessages.$inferSelect;

/** The Meta Send API answers only within 24 hours of the customer's last message (rule 3.50). */
export const META_WINDOW_MS = 24 * 3_600_000;
/** Replies to email threads come from this address (crm spec section 6). */
export const INBOX_REPLY_TO = "hello@beam.be";
export const INBOX_REPLY_TEMPLATE = "crm.inbox_reply";
/** The reply subject of a thread without one (web forms, empty subjects). */
export const DEFAULT_REPLY_SUBJECT: Readonly<Record<Locale, string>> = { "nl-BE": "Je bericht aan BEAM", "fr-BE": "Votre message à BEAM", en: "Your message to BEAM" };

export const isMetaChannel = (channel: InboxChannel): boolean => channel === "instagram" || channel === "messenger";

/** Rule 3.50: whether a Meta thread can still be answered at `now`. */
export function metaWindowOpen(lastInboundAt: Date | null, now: Date): boolean {
  return !!lastInboundAt && now.getTime() - lastInboundAt.getTime() < META_WINDOW_MS;
}

/** The subject without reply and forward prefixes, lower case, for thread matching. */
export function normaliseSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").trim();
  for (let i = 0; i < 10; i++) {
    const next = s.replace(/^(re|aw|antw|fw|fwd|tr|wg)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").toLowerCase();
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** The active person with this email address (rule 3.49), or null. */
async function personByEmail(tx: DbOrTx, email: string): Promise<string | null> {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  const [row] = await tx
    .select({ id: persons.id })
    .from(persons)
    .where(and(sql`lower(${persons.email}) = ${e}`, isNull(persons.mergedIntoPersonId), isNull(persons.erasedAt)))
    .limit(1);
  return row?.id ?? null;
}

/** The active person whose `external_ids.meta_psid` is this sender id (rule 3.49), or null. */
async function personByMetaPsid(tx: DbOrTx, psid: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: persons.id })
    .from(persons)
    .where(and(sql`${persons.externalIds}->>'meta_psid' = ${psid}`, isNull(persons.mergedIntoPersonId), isNull(persons.erasedAt)))
    .limit(1);
  return row?.id ?? null;
}

async function threadById(tx: DbOrTx, threadId: string, lock = false): Promise<InboxThreadRecord> {
  const q = tx.select().from(inboxThreads).where(eq(inboxThreads.id, threadId));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw new NotFoundError("inbox_thread_not_found");
  return row;
}

/** `inbox.message_received` on the linked person (dedupe per message). */
async function recordReceived(ctx: EventCtx, thread: Pick<InboxThreadRecord, "id" | "channel" | "personId" | "companyId">, message: Pick<InboxMessageRecord, "id" | "occurredAt">): Promise<void> {
  if (!thread.personId && !thread.companyId) return;
  await ctx.recordEvent({
    kind: "inbox.message_received",
    ...(thread.personId ? { personId: thread.personId } : {}),
    ...(thread.companyId ? { companyId: thread.companyId } : {}),
    occurredAt: message.occurredAt,
    ref: { type: "inbox_thread", id: thread.id },
    data: { thread_id: thread.id, channel: thread.channel },
    dedupeKey: `inbox:${message.id}:received`,
  });
}

type Inbound = {
  thread: InboxThreadRecord;
  externalMessageId: string;
  body: string;
  attachmentCount: number;
  occurredAt: Date;
};

/**
 * Inserts one inbound message (nothing on a repeated `externalMessageId`) and applies rule 3.57:
 * `pending` and `resolved` become `open`. Returns whether the message is new.
 */
async function addInbound(tx: Tx, ctx: EventCtx, input: Inbound): Promise<{ messageId: string | null; created: boolean }> {
  const [inserted] = await tx
    .insert(inboxMessages)
    .values({
      threadId: input.thread.id,
      direction: "in",
      body: clip(input.body, 50_000),
      externalMessageId: input.externalMessageId,
      attachmentCount: Math.max(0, Math.min(input.attachmentCount, 32_767)),
      occurredAt: input.occurredAt,
    })
    .onConflictDoNothing({ target: inboxMessages.externalMessageId })
    .returning({ id: inboxMessages.id, occurredAt: inboxMessages.occurredAt });
  if (!inserted) return { messageId: null, created: false };
  await tx
    .update(inboxThreads)
    .set({
      status: "open",
      resolvedAt: null,
      lastMessageAt: sql`greatest(${inboxThreads.lastMessageAt}, ${input.occurredAt})`,
      lastInboundAt: sql`greatest(coalesce(${inboxThreads.lastInboundAt}, ${input.occurredAt}), ${input.occurredAt})`,
      updatedAt: ctx.now,
    })
    .where(eq(inboxThreads.id, input.thread.id));
  await recordReceived(ctx, input.thread, inserted);
  return { messageId: inserted.id, created: true };
}

/** A new thread (`on conflict` on the channel and external id returns the existing one). */
async function upsertThread(
  tx: Tx,
  values: { channel: InboxChannel; externalThreadId: string | null; personId: string | null; fromAddress: string | null; fromName: string | null; subject: string | null; at: Date },
): Promise<InboxThreadRecord> {
  if (values.externalThreadId) {
    const [existing] = await tx
      .select()
      .from(inboxThreads)
      .where(and(eq(inboxThreads.channel, values.channel), eq(inboxThreads.externalThreadId, values.externalThreadId)));
    if (existing) return existing;
  }
  const [row] = await tx
    .insert(inboxThreads)
    .values({
      channel: values.channel,
      externalThreadId: values.externalThreadId,
      personId: values.personId,
      fromAddress: values.fromAddress,
      fromName: values.fromName ? clip(values.fromName, 200) : null,
      subject: values.subject ? clip(values.subject, 500) : null,
      lastMessageAt: values.at,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [raced] = await tx
    .select()
    .from(inboxThreads)
    .where(and(eq(inboxThreads.channel, values.channel), eq(inboxThreads.externalThreadId, values.externalThreadId ?? "")));
  if (!raced) throw new ConflictError("inbox_thread_race");
  return raced;
}

/** Email's `email.received` dispatch (crm spec 4.8, section 6). Idempotent on `messageId`. */
export async function ingestInboundEmail(
  tx: Tx,
  ctx: EventCtx,
  msg: {
    messageId: string;
    inReplyTo?: string;
    from: string;
    fromName?: string;
    subject: string;
    text: string;
    attachmentCount: number;
    receivedAt: Date;
  },
): Promise<{ threadId: string }> {
  const messageId = msg.messageId.trim();
  if (!messageId) throw new ValidationError("message_id_missing", { messageId: "required" });
  const [seen] = await tx.select({ threadId: inboxMessages.threadId }).from(inboxMessages).where(eq(inboxMessages.externalMessageId, messageId));
  if (seen) return { threadId: seen.threadId };

  const from = msg.from.trim().toLowerCase();
  let thread: InboxThreadRecord | undefined;
  const replyTo = msg.inReplyTo?.trim();
  if (replyTo) {
    const [byMessage] = await tx
      .select({ t: inboxThreads })
      .from(inboxMessages)
      .innerJoin(inboxThreads, eq(inboxThreads.id, inboxMessages.threadId))
      .where(and(eq(inboxMessages.externalMessageId, replyTo), eq(inboxThreads.channel, "email")));
    thread = byMessage?.t;
    if (!thread) {
      const [byRoot] = await tx.select().from(inboxThreads).where(and(eq(inboxThreads.channel, "email"), eq(inboxThreads.externalThreadId, replyTo)));
      thread = byRoot;
    }
  }
  const subjectKey = normaliseSubject(msg.subject);
  if (!thread && subjectKey && from) {
    const candidates = await tx
      .select()
      .from(inboxThreads)
      .where(and(eq(inboxThreads.channel, "email"), sql`lower(${inboxThreads.fromAddress}) = ${from}`, ne(inboxThreads.status, "resolved")))
      .orderBy(desc(inboxThreads.lastMessageAt))
      .limit(20);
    thread = candidates.find((t) => normaliseSubject(t.subject) === subjectKey);
  }
  thread ??= await upsertThread(tx, {
    channel: "email",
    externalThreadId: messageId,
    personId: from ? await personByEmail(tx, from) : null,
    fromAddress: from || null,
    fromName: msg.fromName?.trim() || null,
    subject: msg.subject.trim() || null,
    at: msg.receivedAt,
  });
  await addInbound(tx, ctx, { thread, externalMessageId: messageId, body: msg.text, attachmentCount: msg.attachmentCount, occurredAt: msg.receivedAt });
  return { threadId: thread.id };
}

/** forms whose version sets `FormSettings.createInboxThread: true` (cross-module D62). Idempotent on `submissionId`. */
export async function createInboxThreadFromForm(
  tx: Tx,
  ctx: EventCtx,
  input: { personId: string; submissionId: string; subject: string; body: string },
): Promise<{ threadId: string }> {
  const key = `form:${input.submissionId}`;
  const [p] = await tx.select({ email: persons.email, firstName: persons.firstName, lastName: persons.lastName }).from(persons).where(eq(persons.id, input.personId));
  if (!p) throw new NotFoundError("person_not_found");
  const thread = await upsertThread(tx, {
    channel: "form",
    externalThreadId: key,
    personId: input.personId,
    fromAddress: p.email?.toLowerCase() ?? null,
    fromName: [p.firstName, p.lastName].filter(Boolean).join(" ") || null,
    subject: input.subject.trim() || null,
    at: ctx.now,
  });
  await addInbound(tx, ctx, { thread, externalMessageId: key, body: input.body, attachmentCount: 0, occurredAt: ctx.now });
  return { threadId: thread.id };
}

/** One Meta message from crm's `meta` webhook handler (thread key: the sender PSID). */
export async function ingestMetaMessage(tx: Tx, ctx: EventCtx, inbound: MetaInbound): Promise<{ threadId: string; created: boolean }> {
  const [seen] = await tx.select({ threadId: inboxMessages.threadId }).from(inboxMessages).where(eq(inboxMessages.externalMessageId, inbound.mid));
  if (seen) return { threadId: seen.threadId, created: false };
  const thread = await upsertThread(tx, {
    channel: inbound.channel,
    externalThreadId: inbound.senderId,
    personId: await personByMetaPsid(tx, inbound.senderId),
    fromAddress: inbound.senderId,
    fromName: null,
    subject: null,
    at: inbound.sentAt,
  });
  const { created } = await addInbound(tx, ctx, { thread, externalMessageId: inbound.mid, body: inbound.text, attachmentCount: inbound.attachmentCount, occurredAt: inbound.sentAt });
  return { threadId: thread.id, created };
}

// ---------------------------------------------------------------------------
// Staff handlers (crm spec 4.2)
// ---------------------------------------------------------------------------

/** Staff moves (rule 3.57): resolve an open or pending thread, reopen a resolved one. */
export const STAFF_STATUS_MOVES: Readonly<Record<InboxThreadStatus, readonly InboxThreadStatus[]>> = {
  open: ["resolved"],
  pending: ["resolved"],
  resolved: ["open"],
};

const staffUserId = (ctx: Ctx): string | null => (ctx.actor.kind === "staff" ? ctx.actor.userId : null);

/** `assignThread` / `setThreadStatus` (`crm.update_thread`, audit `inbox.update`). */
export async function updateStaffThread(ctx: Ctx, input: { threadId: string; assigneeUserId?: string | null; status?: InboxThreadStatus }): Promise<{ threadId: string; status: InboxThreadStatus }> {
  const tx = ctx.tx;
  const t = await threadById(tx, input.threadId, true);
  const patch: Partial<typeof inboxThreads.$inferInsert> = {};
  if (input.assigneeUserId !== undefined && input.assigneeUserId !== t.assigneeUserId) patch.assigneeUserId = input.assigneeUserId;
  if (input.status && input.status !== t.status) {
    if (!STAFF_STATUS_MOVES[t.status].includes(input.status)) throw new ConflictError("inbox_invalid_transition");
    patch.status = input.status;
    patch.resolvedAt = input.status === "resolved" ? ctx.now : null;
  }
  if (Object.keys(patch).length === 0) return { threadId: t.id, status: t.status };
  await tx.update(inboxThreads).set({ ...patch, updatedAt: ctx.now }).where(eq(inboxThreads.id, t.id));
  await ctx.audit({
    action: "inbox.update",
    entityType: "inbox_thread",
    entityId: t.id,
    personId: t.personId,
    oldValue: { status: t.status, assignee_user_id: t.assigneeUserId },
    newValue: { status: patch.status ?? t.status, assignee_user_id: patch.assigneeUserId !== undefined ? patch.assigneeUserId : t.assigneeUserId },
  });
  return { threadId: t.id, status: patch.status ?? t.status };
}

/** The Message-IDs of a thread's inbound email messages, oldest first (threading headers). */
async function inboundMessageIds(tx: DbOrTx, threadId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: inboxMessages.externalMessageId })
    .from(inboxMessages)
    .where(and(eq(inboxMessages.threadId, threadId), eq(inboxMessages.direction, "in")))
    .orderBy(inboxMessages.occurredAt, inboxMessages.id);
  return rows.map((r) => r.id).filter((id): id is string => !!id && !id.startsWith("form:"));
}

async function threadLocale(tx: DbOrTx, personId: string | null): Promise<Locale> {
  if (!personId) return "nl-BE";
  const [p] = await tx.select({ locale: persons.locale }).from(persons).where(eq(persons.id, personId));
  return p?.locale ?? "nl-BE";
}

/**
 * `replyToThread` (`crm.reply_thread`, rule 3.50): one `out` message. Email and form threads
 * queue one `crm.inbox_reply` email (key `inbox_reply:<message_id>`, Reply-To `hello@beam.be`,
 * `In-Reply-To` and `References` from the thread's inbound Message-IDs); Meta threads enqueue
 * `crm.send_meta_reply` while the 24-hour window is open, else `conflict` `meta_window_closed`.
 * The first reply sets `first_response_at`; `open` becomes `pending`; `escalated_at` stays.
 */
export async function replyStaffThread(ctx: Ctx, input: { threadId: string; body: string; templateKey?: string; usedAiDraftMessageId?: string }): Promise<{ messageId: string }> {
  const tx = ctx.tx;
  const body = input.body.trim();
  if (!body) throw new ValidationError("validation", { body: "required" });
  const t = await threadById(tx, input.threadId, true);
  const meta = isMetaChannel(t.channel);
  if (meta && !metaWindowOpen(t.lastInboundAt, ctx.now)) throw new ConflictError("meta_window_closed");
  if (meta && !(await getSetting(tx, "inbox")).meta_enabled) throw new ConflictError("meta_disabled");
  if (!meta && !t.fromAddress && !t.personId) throw new ValidationError("no_recipient", { threadId: "no_recipient" });

  const [msg] = await tx
    .insert(inboxMessages)
    .values({ threadId: t.id, direction: "out", body: clip(body, 50_000), sentByUserId: staffUserId(ctx), occurredAt: ctx.now })
    .returning({ id: inboxMessages.id });
  const messageId = msg!.id;

  if (meta) {
    await ctx.enqueue({ kind: "crm.send_meta_reply", payload: { messageId }, key: `meta_reply:${messageId}`, priority: 1 });
  } else {
    const ids = await inboundMessageIds(tx, t.id);
    const last = ids.at(-1);
    const locale = await threadLocale(tx, t.personId);
    const { sendTransactional } = await import("@/modules/email/api");
    const sent = await sendTransactional(ctx, {
      template: INBOX_REPLY_TEMPLATE,
      ...(t.personId ? { personId: t.personId } : {}),
      ...(t.fromAddress ? { to: t.fromAddress } : {}),
      locale,
      data: { body, subject: t.subject?.trim() || DEFAULT_REPLY_SUBJECT[locale] },
      key: `inbox_reply:${messageId}`,
      replyTo: INBOX_REPLY_TO,
      ...(last ? { headers: { "In-Reply-To": last, References: ids.slice(-20).join(" ") } } : {}),
    });
    await tx.update(inboxMessages).set({ emailMessageId: sent.emailMessageId }).where(eq(inboxMessages.id, messageId));
  }

  await tx
    .update(inboxThreads)
    .set({
      status: t.status === "open" ? "pending" : t.status,
      firstResponseAt: t.firstResponseAt ?? ctx.now,
      lastMessageAt: sql`greatest(${inboxThreads.lastMessageAt}, ${ctx.now})`,
      updatedAt: ctx.now,
    })
    .where(eq(inboxThreads.id, t.id));
  if (t.personId || t.companyId) {
    await ctx.recordEvent({
      kind: "inbox.reply_sent",
      ...(t.personId ? { personId: t.personId } : {}),
      ...(t.companyId ? { companyId: t.companyId } : {}),
      ref: { type: "inbox_thread", id: t.id },
      data: { thread_id: t.id, channel: t.channel },
      dedupeKey: `inbox:${messageId}:reply_sent`,
    });
  }
  await ctx.audit({ action: "inbox.reply", entityType: "inbox_thread", entityId: t.id, personId: t.personId, newValue: { message_id: messageId, channel: t.channel, template_key: input.templateKey ?? null } });
  return { messageId };
}

/** `addThreadNote` (`crm.note_thread`): an internal note, never sent (the audit row has no body). */
export async function addStaffThreadNote(ctx: Ctx, input: { threadId: string; body: string }): Promise<{ messageId: string }> {
  const body = input.body.trim();
  if (!body) throw new ValidationError("validation", { body: "required" });
  const t = await threadById(ctx.tx, input.threadId);
  const [msg] = await ctx.tx
    .insert(inboxMessages)
    .values({ threadId: t.id, direction: "note", body: clip(body, 50_000), sentByUserId: staffUserId(ctx), occurredAt: ctx.now })
    .returning({ id: inboxMessages.id });
  await ctx.tx.update(inboxThreads).set({ updatedAt: ctx.now }).where(eq(inboxThreads.id, t.id));
  await ctx.audit({ action: "inbox.note", entityType: "inbox_thread", entityId: t.id, personId: t.personId, newValue: { message_id: msg!.id } });
  return { messageId: msg!.id };
}

/**
 * `linkThreadPerson` (`crm.link_thread`): links the thread to `personId`, or creates the person
 * from the sender (`createFromSender`: email and form threads through
 * `findOrCreatePersonByEmail`, Meta threads as a person without email named after the sender).
 * A Meta thread stores its sender id in the person's `external_ids.meta_psid`. The thread's
 * inbound messages get their `inbox.message_received` events on the person (deduped per message).
 */
export async function linkStaffThreadPerson(ctx: Ctx, input: { threadId: string; personId?: string; createFromSender?: { locale: Locale } }): Promise<{ personId: string }> {
  const tx = ctx.tx;
  const t = await threadById(tx, input.threadId, true);
  let personId = input.personId ?? null;
  if (!personId && input.createFromSender) {
    const [first, ...rest] = (t.fromName ?? "").trim().split(/\s+/).filter(Boolean);
    const { createPersonWithoutEmail, findOrCreatePersonByEmail } = await import("../persons/api");
    const lastName = rest.length ? { lastName: rest.join(" ") } : {};
    if (!isMetaChannel(t.channel) && t.fromAddress?.includes("@")) {
      const found = await findOrCreatePersonByEmail(tx, ctx, { email: t.fromAddress, ...(first ? { firstName: first } : {}), ...lastName, locale: input.createFromSender.locale, acquisition: { source: "manual" } });
      personId = found.personId;
    } else {
      const made = await createPersonWithoutEmail(tx, ctx, { firstName: first ?? "Meta", ...lastName, locale: input.createFromSender.locale, acquisition: { source: "social_media" } });
      personId = made.personId;
    }
  }
  if (!personId) throw new ValidationError("validation", { personId: "required" });
  const [p] = await tx.select({ id: persons.id, erasedAt: persons.erasedAt, mergedInto: persons.mergedIntoPersonId }).from(persons).where(eq(persons.id, personId));
  if (!p || p.erasedAt || p.mergedInto) throw new NotFoundError("person_not_found");

  await tx.update(inboxThreads).set({ personId, updatedAt: ctx.now }).where(eq(inboxThreads.id, t.id));
  if (isMetaChannel(t.channel) && t.externalThreadId) {
    await tx
      .update(persons)
      .set({ externalIds: sql`coalesce(${persons.externalIds}, '{}'::jsonb) || jsonb_build_object('meta_psid', ${t.externalThreadId}::text)`, updatedAt: ctx.now })
      .where(and(eq(persons.id, personId), sql`coalesce(${persons.externalIds}->>'meta_psid', '') <> ${t.externalThreadId}`));
  }
  const inbound = await tx
    .select({ id: inboxMessages.id, occurredAt: inboxMessages.occurredAt })
    .from(inboxMessages)
    .where(and(eq(inboxMessages.threadId, t.id), eq(inboxMessages.direction, "in")));
  for (const m of inbound) await recordReceived(ctx, { ...t, personId }, m);
  await ctx.audit({ action: "inbox.link", entityType: "inbox_thread", entityId: t.id, personId, oldValue: { person_id: t.personId }, newValue: { person_id: personId } });
  return { personId };
}

/** `markThreadSensitive` (`crm.mark_thread_sensitive`): a sensitive thread is never sent to AI. */
export async function markStaffThreadSensitive(ctx: Ctx, input: { threadId: string; isSensitive: boolean }): Promise<{ threadId: string }> {
  const t = await threadById(ctx.tx, input.threadId, true);
  if (t.isSensitive === input.isSensitive) return { threadId: t.id };
  await ctx.tx.update(inboxThreads).set({ isSensitive: input.isSensitive, updatedAt: ctx.now }).where(eq(inboxThreads.id, t.id));
  await ctx.audit({ action: "inbox.sensitive", entityType: "inbox_thread", entityId: t.id, personId: t.personId, oldValue: { is_sensitive: t.isSensitive }, newValue: { is_sensitive: input.isSensitive } });
  return { threadId: t.id };
}

/** `saveReplyTemplate` (`crm.save_reply_template`): every locale of name and body is required. */
export async function saveStaffReplyTemplate(ctx: Ctx, input: { id?: string; key: string; name: LocalizedText; body: LocalizedText; isActive: boolean }): Promise<{ templateId: string }> {
  const fields: Record<string, string> = {};
  if (missingLocales(input.name).length) fields.name = "missing_locales";
  if (missingLocales(input.body).length) fields.body = "missing_locales";
  if (Object.keys(fields).length) throw new ValidationError("validation", fields);
  const values = { key: input.key, name: input.name, body: input.body, isActive: input.isActive };
  let old: typeof inboxReplyTemplates.$inferSelect | undefined;
  let id: string;
  if (input.id) {
    [old] = await ctx.tx.select().from(inboxReplyTemplates).where(eq(inboxReplyTemplates.id, input.id));
    if (!old) throw new NotFoundError("inbox_template_not_found");
    await ctx.tx.update(inboxReplyTemplates).set({ ...values, updatedAt: ctx.now }).where(eq(inboxReplyTemplates.id, input.id));
    id = input.id;
  } else {
    const [dup] = await ctx.tx.select({ id: inboxReplyTemplates.id }).from(inboxReplyTemplates).where(eq(inboxReplyTemplates.key, input.key));
    if (dup) throw new ValidationError("validation", { key: "taken" });
    const [row] = await ctx.tx.insert(inboxReplyTemplates).values(values).returning({ id: inboxReplyTemplates.id });
    id = row!.id;
  }
  await ctx.audit({
    action: "inbox.template",
    entityType: "inbox_reply_template",
    entityId: id,
    ...(old ? { oldValue: { key: old.key, is_active: old.isActive } } : {}),
    newValue: { key: input.key, is_active: input.isActive },
  });
  return { templateId: id };
}
