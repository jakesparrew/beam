/**
 * assistant's door for other modules. `getPersonAssistantPanel` feeds the "Assistant" panel on
 * the staff person page: the person's conversations with the analyst's summary, interests, the
 * quotes behind them and the score.
 */
import { assistantConversations } from "@beam/db/schema";
import { desc, inArray, type DbOrTx } from "@/lib/ctx";
import { resolvePersonIds } from "@/modules/crm/api";
import { latestAdvice, type ProfileAdvice } from "./server/advise";
import { loadActivity, type ActivityData } from "./server/activity";
import { loadBehaviour, type BehaviourFacts } from "./server/behaviour";

export type { ActivityData, BehaviourFacts, ProfileAdvice };

/** The activity charts of the staff person page: visits and interactions per period, and when they come. */
export function getPersonActivity(db: DbOrTx, personId: string): Promise<ActivityData> {
  return loadActivity(db, personId);
}

/** The behaviour panel of the staff person page: live facts and the lead agent's latest advice. */
export async function getPersonBehaviourPanel(db: DbOrTx, personId: string): Promise<{ facts: BehaviourFacts | null; advice: { actionId: string; at: Date; advice: ProfileAdvice } | null }> {
  const [facts, advice] = await Promise.all([loadBehaviour(db, personId), latestAdvice(db, personId)]);
  return { facts, advice };
}

export type PersonAssistantPanel = {
  conversations: {
    id: string;
    role: "guide" | "coach";
    status: "open" | "handoff" | "closed";
    startedAt: Date;
    lastMessageAt: Date;
    messageCount: number;
    score: number | null;
    scoreReason: string | null;
    summary: string | null;
    intent: string | null;
    interests: string[];
    objections: string[];
    quotes: Record<string, string>;
    tags: string[];
  }[];
  bestScore: number | null;
};

export async function getPersonAssistantPanel(db: DbOrTx, personId: string): Promise<PersonAssistantPanel> {
  const ids = await resolvePersonIds(db as Parameters<typeof resolvePersonIds>[0], personId);
  const rows = await db.select().from(assistantConversations).where(inArray(assistantConversations.personId, ids)).orderBy(desc(assistantConversations.lastMessageAt)).limit(20);
  const conversations = rows.map((c) => ({
    id: c.id,
    role: c.role,
    status: c.status,
    startedAt: c.createdAt,
    lastMessageAt: c.lastMessageAt,
    messageCount: c.messageCount,
    score: c.score,
    scoreReason: c.scoreReason,
    summary: c.analysis?.summary ?? null,
    intent: c.analysis?.intent ?? null,
    interests: c.analysis?.interests ?? [],
    objections: c.analysis?.objections ?? [],
    quotes: c.analysis?.quotes ?? {},
    tags: c.analysis?.tags ?? [],
  }));
  const scores = conversations.map((c) => c.score).filter((s): s is number => s != null);
  return { conversations, bestScore: scores.length ? Math.max(...scores) : null };
}
