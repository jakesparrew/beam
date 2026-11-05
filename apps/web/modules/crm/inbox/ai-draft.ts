/**
 * AI-drafted inbox replies (crm rules 3.51 and 3.58, spec 4.2 and 4.5), crm-P10.
 *
 * - `requestDraft` (`requestAiDraft`, `ai.use`): an inbound message gets `ai_draft_status =
 *   pending` and one `ai.draft_reply` job (key `ai:draft_reply:<message_id>`, a later request for
 *   the same message `ai:draft_reply:<message_id>:r<n>`). A sensitive thread, or a keyword match
 *   while `settings.ai.sensitive_enabled` is off, is `blocked_sensitive` at once and nothing is
 *   enqueued.
 * - `runDraftReply` (job `ai.draft_reply`): screens again (the thread may have been marked
 *   sensitive meanwhile), builds the context (rule 3.58: `toAiContext` of the linked person with
 *   the feature's allow-list, the last 10 non-note messages up to the drafted one, the active
 *   knowledge articles in the thread's locale in key order, cut at 20,000 characters), calls
 *   `callClaude` (`ai.draft_reply`, opus) and stores `ai_draft`, `ai_request_id`, `ready`. A
 *   budget stop or another permanent error stores `failed` durably and rethrows.
 * - A draft is never sent by the system: staff edit it and press Send (`replyWithDraft`), which
 *   records `used`; `discardDraft` drops it.
 *
 * `fieldsSent` lists only the `AI_ALLOWED_FIELDS` of the person context: `callClaude` rejects
 * any other name (PL-53). The message texts and the knowledge articles are the content of the
 * request, stored in `ai_requests.prompt`; email address, phone and names other than the first
 * name are never in the context, and the sender's address is not quoted.
 */
import { z } from "zod";
import type { DbOrTx } from "@beam/db";
import { inboxMessages, inboxThreads, jobs, persons, supportKnowledgeArticles, type InboxAiDraftStatus } from "@beam/db/schema";
import { AI_FEATURES, aiContextFields, aiContextJson, toAiContext, type AiContext, type AiProfileInput } from "@beam/core/ai";
import { PermanentError } from "@beam/core/errors";
import { LOCALES, missingLocales, type Locale, type LocalizedText } from "@beam/core/i18n";
import { callClaude } from "@/lib/ai";
import { and, asc, ConflictError, desc, eq, lte, ne, NotFoundError, sql, ValidationError, writeDurably, type Ctx, type JobKind } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";
import { screenSensitiveAll } from "../../../../../packages/core/src/crm/sensitive-screen";
import { replyStaffThread } from "./api";
import type { ThreadMessage } from "./queries";

export const AI_DRAFT_FEATURE = "ai.draft_reply" as const;
export const AI_DRAFT_JOB_KIND = "ai.draft_reply" as const;
/** Rule 3.58: the knowledge part of the prompt. */
export const KNOWLEDGE_CONTEXT_MAX_CHARS = 20_000;
/** Rule 3.58: the newest non-note messages of the thread. */
export const DRAFT_MESSAGE_LIMIT = 10;
/** One message in the prompt (a long email is cut). */
export const DRAFT_MESSAGE_MAX_CHARS = 4_000;
export const KNOWLEDGE_BODY_MAX_CHARS = 5_000;
export const KNOWLEDGE_TITLE_MAX_CHARS = 200;
export const AI_DRAFT_MAX_CHARS = 20_000;

export const DraftReplyInput = z.object({ messageId: z.uuid() });

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

// ---------------------------------------------------------------------------
// Prompt (rule 3.58)
// ---------------------------------------------------------------------------

export type DraftArticle = { key: string; title: string; body: string };
export type DraftPromptMessage = Pick<ThreadMessage, "direction" | "body" | "occurredAt">;

const LANGUAGE: Record<Locale, string> = { "nl-BE": "Dutch (Belgium)", "fr-BE": "French (Belgium)", en: "English" };

/** Articles in key order, whole while they fit, the one that crosses the limit cut, the rest left out. */
export function knowledgeSection(articles: readonly DraftArticle[], max = KNOWLEDGE_CONTEXT_MAX_CHARS): string {
  let out = "";
  for (const a of [...articles].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))) {
    const block = `${out ? "\n\n" : ""}### ${a.title} [${a.key}]\n${a.body.trim()}`;
    if (out.length + block.length <= max) {
      out += block;
      continue;
    }
    out += block.slice(0, Math.max(0, max - out.length));
    break;
  }
  return out;
}

/**
 * The system and user prompt of one draft. `context` is the person's allow-listed context (may
 * be empty for an unlinked sender); `messages` oldest first, notes already left out.
 */
export function buildDraftPrompt(context: AiContext, messages: readonly DraftPromptMessage[], articles: readonly DraftArticle[], opts: { locale?: Locale } = {}): { system: string; user: string } {
  const locale: Locale = opts.locale ?? (typeof context.locale === "string" && (LOCALES as readonly string[]).includes(context.locale) ? (context.locale as Locale) : "nl-BE");
  const knowledge = knowledgeSection(articles);
  const system = [
    "You draft replies for the customer service team of BEAM Vitality Center, a wellness and training centre in Belgium.",
    "A staff member reads, edits and sends your draft; you never send anything yourself.",
    `Write the reply in ${LANGUAGE[locale]}, in plain text without Markdown, friendly and short, and sign it "Team BEAM".`,
    "Use only the facts below: the customer context, the conversation and the BEAM policies. Never invent prices, dates, availability or promises.",
    "If the policies do not answer the question, say that the team will check and come back to the customer.",
    "Never ask for or repeat health information, and do not give medical advice.",
    "",
    "## BEAM policies",
    knowledge || "(none)",
    "",
    "## Customer context (JSON)",
    aiContextJson(context),
  ].join("\n");
  const lines = messages.map((m) => {
    const who = m.direction === "in" ? "Customer" : "BEAM";
    return `[${who}, ${m.occurredAt.toISOString()}]\n${clip(m.body.trim(), DRAFT_MESSAGE_MAX_CHARS)}`;
  });
  const user = ["The conversation so far, oldest first:", "", lines.join("\n\n"), "", "Draft the next reply from BEAM to the customer's last message."].join("\n");
  return { system, user };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type MessageWithThread = { m: typeof inboxMessages.$inferSelect; t: typeof inboxThreads.$inferSelect };

async function messageWithThread(tx: DbOrTx, messageId: string, lock = false): Promise<MessageWithThread> {
  const q = tx.select({ m: inboxMessages, t: inboxThreads }).from(inboxMessages).innerJoin(inboxThreads, eq(inboxThreads.id, inboxMessages.threadId)).where(eq(inboxMessages.id, messageId));
  const [row] = lock ? await q.for("update", { of: inboxMessages }) : await q;
  if (!row) throw new NotFoundError("inbox_message_not_found");
  return row;
}

/** Rule 3.58: the last `DRAFT_MESSAGE_LIMIT` non-note messages up to `upTo`, oldest first. */
export async function draftMessages(tx: DbOrTx, threadId: string, upTo: { occurredAt: Date }): Promise<DraftPromptMessage[]> {
  const rows = await tx
    .select({ direction: inboxMessages.direction, body: inboxMessages.body, occurredAt: inboxMessages.occurredAt })
    .from(inboxMessages)
    .where(and(eq(inboxMessages.threadId, threadId), ne(inboxMessages.direction, "note"), lte(inboxMessages.occurredAt, upTo.occurredAt)))
    .orderBy(desc(inboxMessages.occurredAt), desc(inboxMessages.createdAt))
    .limit(DRAFT_MESSAGE_LIMIT);
  return rows.reverse();
}

/** Active articles in `locale` (a locale without text is left out). */
export async function draftArticles(tx: DbOrTx, locale: Locale): Promise<DraftArticle[]> {
  const rows = await tx
    .select({ key: supportKnowledgeArticles.key, title: supportKnowledgeArticles.title, body: supportKnowledgeArticles.body })
    .from(supportKnowledgeArticles)
    .where(eq(supportKnowledgeArticles.isActive, true))
    .orderBy(asc(supportKnowledgeArticles.key));
  return rows
    .map((r) => ({ key: r.key, title: (r.title[locale] ?? "").trim(), body: (r.body[locale] ?? "").trim() }))
    .filter((r) => r.body.length > 0);
}

/** The person's allow-listed context (`ai.draft_reply` fields only); `{}` without a person. */
export async function draftContext(tx: DbOrTx, personId: string | null): Promise<{ context: AiContext; locale: Locale }> {
  if (!personId) return { context: {}, locale: "nl-BE" };
  const [p] = await tx.select({ firstName: persons.firstName, locale: persons.locale }).from(persons).where(eq(persons.id, personId));
  if (!p) return { context: {}, locale: "nl-BE" };
  const [profile] = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`select status, is_member, b2c_stage, tags, credits_day_remaining, credits_night_remaining, next_grant_expires_at, membership_period_end_at, next_booking_at from v_person_profile where person_id = ${personId}`),
  );
  const input: AiProfileInput = {
    first_name: p.firstName,
    locale: p.locale,
    status: (profile?.status as string | undefined) ?? null,
    is_member: (profile?.is_member as boolean | undefined) ?? null,
    b2c_stage: (profile?.b2c_stage as string | undefined) ?? null,
    tags: (profile?.tags as string[] | undefined) ?? null,
    credits_remaining: profile ? Number(profile.credits_day_remaining ?? 0) + Number(profile.credits_night_remaining ?? 0) : null,
    grant_expires_at: (profile?.next_grant_expires_at as Date | string | null | undefined) ?? null,
    membership_period_end_at: (profile?.membership_period_end_at as Date | string | null | undefined) ?? null,
    next_booking_at: (profile?.next_booking_at as Date | string | null | undefined) ?? null,
  };
  return { context: toAiContext(input, AI_FEATURES[AI_DRAFT_FEATURE].allowedFields), locale: p.locale };
}

/** Rule 3.51: blocked unless `settings.ai.sensitive_enabled`. */
async function sensitiveBlock(tx: DbOrTx, thread: { isSensitive: boolean }, messages: readonly { body: string }[]): Promise<{ blocked: boolean; matched: string[] }> {
  const ai = (await getSetting(tx, "ai")) as { sensitive_enabled?: boolean };
  if (ai.sensitive_enabled) return { blocked: false, matched: [] };
  if (thread.isSensitive) return { blocked: true, matched: ["thread_is_sensitive"] };
  return screenSensitiveAll(messages.map((m) => m.body).join("\n\n"), LOCALES);
}

const setStatus = (tx: DbOrTx, messageId: string, values: Partial<typeof inboxMessages.$inferInsert>) =>
  tx.update(inboxMessages).set(values).where(eq(inboxMessages.id, messageId));

// ---------------------------------------------------------------------------
// Staff handlers
// ---------------------------------------------------------------------------

/** `requestAiDraft` (`crm.request_ai_draft`, audit `ai.request`). `jobId` is null when blocked. */
export async function requestDraft(ctx: Ctx, input: { messageId: string }): Promise<{ jobId: string | null; status: InboxAiDraftStatus }> {
  const { m, t } = await messageWithThread(ctx.tx, input.messageId, true);
  if (m.direction !== "in") throw new ValidationError("validation", { messageId: "not_inbound" });
  if (m.aiDraftStatus === "pending") throw new ConflictError("ai_draft_pending");
  if (m.aiDraftStatus === "used") throw new ConflictError("ai_draft_used");
  const screen = await sensitiveBlock(ctx.tx, t, await draftMessages(ctx.tx, t.id, m));
  let jobId: string | null = null;
  let status: InboxAiDraftStatus;
  if (screen.blocked) {
    status = "blocked_sensitive";
    await setStatus(ctx.tx, m.id, { aiDraftStatus: status, aiDraft: null });
  } else {
    const base = `ai:draft_reply:${m.id}`;
    const [prior] = rowsOf<{ n: number }>(await ctx.tx.execute(sql`select count(*)::int as n from ${jobs} where ${jobs.idempotencyKey} = ${base} or ${jobs.idempotencyKey} like ${`${base}:r%`}`));
    const n = Number(prior?.n ?? 0);
    const job = await ctx.enqueue({ kind: AI_DRAFT_JOB_KIND as JobKind, payload: { messageId: m.id }, key: n === 0 ? base : `${base}:r${n}` });
    jobId = job.id;
    status = "pending";
    await setStatus(ctx.tx, m.id, { aiDraftStatus: status, aiDraft: null });
  }
  await ctx.audit({
    action: "ai.request",
    entityType: "inbox_message",
    entityId: m.id,
    personId: t.personId,
    newValue: { feature: AI_DRAFT_FEATURE, thread_id: t.id, status, ...(screen.blocked ? { blocked: true } : {}) },
  });
  return { jobId, status };
}

/** `discardAiDraft` (`crm.discard_ai_draft`): a ready draft is dropped. */
export async function discardDraft(ctx: Ctx, input: { messageId: string }): Promise<{ messageId: string }> {
  const { m } = await messageWithThread(ctx.tx, input.messageId, true);
  if (m.aiDraftStatus !== "ready" && m.aiDraftStatus !== "failed" && m.aiDraftStatus !== "blocked_sensitive") throw new ConflictError("ai_draft_not_ready");
  await setStatus(ctx.tx, m.id, { aiDraftStatus: "discarded", aiDraft: null });
  return { messageId: m.id };
}

/**
 * `replyToThread` with `usedAiDraftMessageId` (rule 3.51): the reply is the staff member's text;
 * a ready draft of an inbound message of the same thread becomes `used`.
 */
export async function replyWithDraft(ctx: Ctx, input: { threadId: string; body: string; templateKey?: string; usedAiDraftMessageId?: string }): Promise<{ messageId: string }> {
  const result = await replyStaffThread(ctx, input);
  if (input.usedAiDraftMessageId) {
    await ctx.tx
      .update(inboxMessages)
      .set({ aiDraftStatus: "used" })
      .where(and(eq(inboxMessages.id, input.usedAiDraftMessageId), eq(inboxMessages.threadId, input.threadId), eq(inboxMessages.aiDraftStatus, "ready")));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export type KnowledgeArticleInput = { id?: string; key: string; title: LocalizedText; body: LocalizedText; isActive: boolean };

/** `saveKnowledgeArticle` (`crm.save_knowledge_article`, audit `knowledge.save`): all three locales required. */
export async function saveKnowledge(ctx: Ctx, input: KnowledgeArticleInput): Promise<{ articleId: string }> {
  const fields: Record<string, string> = {};
  if (!/^[a-z0-9_-]{2,64}$/.test(input.key)) fields.key = "invalid";
  if (missingLocales(input.title).length) fields.title = "missing_locales";
  else if (LOCALES.some((l) => (input.title[l] ?? "").length > KNOWLEDGE_TITLE_MAX_CHARS)) fields.title = "too_long";
  if (missingLocales(input.body).length) fields.body = "missing_locales";
  else if (LOCALES.some((l) => (input.body[l] ?? "").length > KNOWLEDGE_BODY_MAX_CHARS)) fields.body = "too_long";
  if (Object.keys(fields).length) throw new ValidationError("validation", fields);
  const trim = (t: LocalizedText): LocalizedText => Object.fromEntries(LOCALES.map((l) => [l, (t[l] ?? "").trim()]));
  const userId = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
  const values = { key: input.key, title: trim(input.title), body: trim(input.body), isActive: input.isActive, updatedByUserId: userId };
  const [dup] = await ctx.tx.select({ id: supportKnowledgeArticles.id }).from(supportKnowledgeArticles).where(eq(supportKnowledgeArticles.key, input.key));
  if (dup && dup.id !== input.id) throw new ValidationError("validation", { key: "taken" });
  let old: typeof supportKnowledgeArticles.$inferSelect | undefined;
  let id: string;
  if (input.id) {
    [old] = await ctx.tx.select().from(supportKnowledgeArticles).where(eq(supportKnowledgeArticles.id, input.id)).for("update");
    if (!old) throw new NotFoundError("knowledge_article_not_found");
    await ctx.tx.update(supportKnowledgeArticles).set({ ...values, updatedAt: ctx.now }).where(eq(supportKnowledgeArticles.id, input.id));
    id = input.id;
  } else {
    const [row] = await ctx.tx.insert(supportKnowledgeArticles).values(values).returning({ id: supportKnowledgeArticles.id });
    id = row!.id;
  }
  await ctx.audit({
    action: "knowledge.save",
    entityType: "support_knowledge_article",
    entityId: id,
    ...(old ? { oldValue: { key: old.key, is_active: old.isActive } } : {}),
    newValue: { key: input.key, is_active: input.isActive },
  });
  return { articleId: id };
}

// ---------------------------------------------------------------------------
// Job `ai.draft_reply`
// ---------------------------------------------------------------------------

export type DraftReplyResult =
  | { status: "ready"; aiRequestId: string }
  | { status: "blocked_sensitive"; matched: string[] }
  | { status: "skipped"; current: InboxAiDraftStatus }
  | { status: "missing" };

/** The job handler (fast / 5, max 3, key `ai:draft_reply:<message_id>`). */
export async function runDraftReply(ctx: JobCtx, input: z.infer<typeof DraftReplyInput>): Promise<DraftReplyResult> {
  let row: MessageWithThread;
  try {
    row = await messageWithThread(ctx.tx, input.messageId, true);
  } catch (error) {
    if (error instanceof NotFoundError) return { status: "missing" };
    throw error;
  }
  const { m, t } = row;
  if (m.aiDraftStatus !== "pending") return { status: "skipped", current: m.aiDraftStatus };

  const messages = await draftMessages(ctx.tx, t.id, m);
  const screen = await sensitiveBlock(ctx.tx, t, messages);
  if (screen.blocked) {
    await setStatus(ctx.tx, m.id, { aiDraftStatus: "blocked_sensitive", aiDraft: null });
    return { status: "blocked_sensitive", matched: screen.matched };
  }

  const { context, locale } = await draftContext(ctx.tx, t.personId);
  const articles = await draftArticles(ctx.tx, locale);
  const prompt = buildDraftPrompt(context, messages, articles, { locale });
  let result: { text: string; aiRequestId: string };
  try {
    result = await callClaude(ctx, {
      feature: AI_DRAFT_FEATURE,
      model: "opus",
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      ...(t.personId ? { personId: t.personId } : {}),
      fieldsSent: aiContextFields(context),
      maxTokens: 1500,
    });
  } catch (error) {
    if (error instanceof PermanentError) await markFailed(ctx, m.id);
    throw error;
  }
  const draft = clip(result.text.trim(), AI_DRAFT_MAX_CHARS);
  if (!draft) {
    await markFailed(ctx, m.id);
    throw new PermanentError("empty_draft");
  }
  await setStatus(ctx.tx, m.id, { aiDraft: draft, aiRequestId: result.aiRequestId, aiDraftStatus: "ready" });
  return { status: "ready", aiRequestId: result.aiRequestId };
}

/** `failed` survives the rollback of the job (written durably), only over `pending`. */
async function markFailed(ctx: Ctx, messageId: string): Promise<void> {
  await writeDurably(ctx, async (db) => {
    await db.update(inboxMessages).set({ aiDraftStatus: "failed" }).where(and(eq(inboxMessages.id, messageId), eq(inboxMessages.aiDraftStatus, "pending")));
  });
}

/** The job's dead letter: retries ran out (a provider outage), the draft is `failed`. */
export async function onDraftReplyDead(ctx: JobCtx, input: z.infer<typeof DraftReplyInput>): Promise<void> {
  await ctx.tx.update(inboxMessages).set({ aiDraftStatus: "failed" }).where(and(eq(inboxMessages.id, input.messageId), eq(inboxMessages.aiDraftStatus, "pending")));
}

// ---------------------------------------------------------------------------
// Panel state
// ---------------------------------------------------------------------------

export type AiDraftState = {
  /** The newest inbound message of the thread: the one a draft replies to. */
  messageId: string;
  status: InboxAiDraftStatus;
  draft: string | null;
  threadIsSensitive: boolean;
};

/** The draft state of a thread's newest inbound message (null when the thread has none). */
export async function getAiDraftState(db: DbOrTx, threadId: string): Promise<AiDraftState | null> {
  const [row] = await db
    .select({ messageId: inboxMessages.id, status: inboxMessages.aiDraftStatus, draft: inboxMessages.aiDraft, isSensitive: inboxThreads.isSensitive })
    .from(inboxMessages)
    .innerJoin(inboxThreads, eq(inboxThreads.id, inboxMessages.threadId))
    .where(and(eq(inboxMessages.threadId, threadId), eq(inboxMessages.direction, "in")))
    .orderBy(desc(inboxMessages.occurredAt), desc(inboxMessages.createdAt))
    .limit(1);
  if (!row) return null;
  return { messageId: row.messageId, status: row.status, draft: row.status === "ready" ? row.draft : null, threadIsSensitive: row.isSensitive };
}
