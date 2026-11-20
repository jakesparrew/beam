/**
 * assistant's GDPR registration. Facade read by `pnpm gen:indexes`; ops runs export, erase and the
 * sweeps.
 * - export: the person's conversations with every message (the staff-only tool trace left out),
 *   the analyst's reading with its quotes and score, and the agent log about them.
 * - erase: deletes the conversations (messages and log rows cascade), the remaining log rows and
 *   the visitors linked to the person.
 * - sweep `assistant.anonymous_conversations`: conversations of visitors who never became a person
 *   are deleted 90 days after their last message, then visitors without any conversation.
 */
import type { Tx } from "@beam/db";
import { assistantActions, assistantConversations, assistantMessages, assistantVisitors } from "@beam/db/schema";
import type { EraseReportRow, PrivacyExport, PrivacyRegistration, RetentionPolicySeed } from "@beam/core/privacy";
import { asc, inArray, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { resolvePersonIds } from "@/modules/crm/api";

const SWEEP_BATCH = 5000;

export const retention: readonly RetentionPolicySeed[] = [
  {
    key: "assistant.anonymous_conversations",
    tableName: "assistant_conversations",
    days: 90,
    action: "delete",
    description: "Chats of visitors who never left contact details: deleted 90 days after the last message.",
  },
];

async function exportPerson(tx: Tx, personId: string): Promise<PrivacyExport> {
  const ids = await resolvePersonIds(tx, personId);
  const convs = await tx.select().from(assistantConversations).where(inArray(assistantConversations.personId, ids)).orderBy(asc(assistantConversations.createdAt));
  const convIds = convs.map((c) => c.id);
  const messages = convIds.length
    ? await tx
        .select({ conversationId: assistantMessages.conversationId, author: assistantMessages.author, body: assistantMessages.body, createdAt: assistantMessages.createdAt, rating: assistantMessages.rating })
        .from(assistantMessages)
        .where(inArray(assistantMessages.conversationId, convIds))
        .orderBy(asc(assistantMessages.createdAt))
    : [];
  const actions = await tx.select({ kind: assistantActions.kind, detail: assistantActions.detail, createdAt: assistantActions.createdAt }).from(assistantActions).where(inArray(assistantActions.personId, ids)).orderBy(asc(assistantActions.createdAt));
  return {
    "assistant/conversations.json": convs.map((c) => ({
      id: c.id,
      role: c.role,
      status: c.status,
      page: c.page,
      started_at: c.createdAt.toISOString(),
      last_message_at: c.lastMessageAt.toISOString(),
      analysis: c.analysis,
      score: c.score,
      score_reason: c.scoreReason,
      messages: messages.filter((m) => m.conversationId === c.id).map((m) => ({ author: m.author, text: m.body, at: m.createdAt.toISOString(), rating: m.rating })),
    })),
    "assistant/actions.json": actions.map((a) => ({ kind: a.kind, detail: a.detail, at: a.createdAt.toISOString() })),
  };
}

async function erasePerson(tx: Tx, personId: string): Promise<EraseReportRow[]> {
  await tx.execute(sql`select set_config('beam.allow_rewrite', 'on', true)`);
  const ids = await resolvePersonIds(tx, personId);
  const convs = await tx.delete(assistantConversations).where(inArray(assistantConversations.personId, ids)).returning({ id: assistantConversations.id });
  const actions = await tx.delete(assistantActions).where(inArray(assistantActions.personId, ids)).returning({ id: assistantActions.id });
  const visitors = await tx.delete(assistantVisitors).where(inArray(assistantVisitors.personId, ids)).returning({ id: assistantVisitors.id });
  return [
    { table: "assistant_conversations", rows: convs.length, action: "delete" },
    { table: "assistant_actions", rows: actions.length, action: "delete" },
    { table: "assistant_visitors", rows: visitors.length, action: "delete" },
  ];
}

export const sweep: Record<string, (tx: Tx, cutoff: Date) => Promise<number>> = {
  "assistant.anonymous_conversations": async (tx, cutoff) => {
    const deleted = rowsOf<{ id: string }>(
      await tx.execute(sql`
        delete from assistant_conversations where id in (
          select id from assistant_conversations where person_id is null and last_message_at < ${cutoff.toISOString()} limit ${SWEEP_BATCH}
        ) returning id`),
    ).length;
    await tx.execute(sql`delete from assistant_visitors v where v.person_id is null and not exists (select 1 from assistant_conversations c where c.visitor_id = v.id)`);
    return deleted;
  },
};

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["assistant_visitors", "assistant_conversations", "assistant_actions"],
  export: exportPerson,
  erase: erasePerson,
  sweep,
  retention,
};

/** Assistant tables without a person reference of their own. */
export const noPiiTables = ["assistant_messages", "assistant_eval_cases", "assistant_eval_runs"] as const;
