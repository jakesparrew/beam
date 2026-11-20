/**
 * The AI assistant (docs/plan/modules/assistant.md): one agent with three roles. The guide talks
 * to anonymous visitors on the site, the coach to signed-in customers in the portal, and the
 * analyst reads finished conversations in a job. Visitors are known by a random token the browser
 * keeps (only its hash is stored); a visitor becomes a CRM person only by leaving contact details.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, numeric, pgEnum, pgTable, smallint, text, uuid } from "drizzle-orm/pg-core";
import { persons } from "./crm";
import { createdAt, id, timestamps, tstz } from "./_shared";
import { users } from "./platform";

export const assistantConversationsRole = pgEnum("assistant_conversations_role", ["guide", "coach"]);
export const assistantConversationsStatus = pgEnum("assistant_conversations_status", ["open", "handoff", "closed"]);
export const assistantMessagesAuthor = pgEnum("assistant_messages_author", ["visitor", "assistant", "staff"]);

/** One browser that chatted. `token_hash` is the sha256 of the token in its local storage. */
export const assistantVisitors = pgTable(
  "assistant_visitors",
  {
    id: id(),
    tokenHash: text().notNull().unique("assistant_visitors_token_hash_unique"),
    personId: uuid().references(() => persons.id),
    locale: text().notNull().default("nl-BE"),
    firstPage: text(),
    /** UTM and landing page, only when the visitor accepted analytics cookies. */
    origin: jsonb().$type<Record<string, string>>(),
    firstSeenAt: tstz().notNull().defaultNow(),
    lastSeenAt: tstz().notNull().defaultNow(),
  },
  (t) => [index("assistant_visitors_person_idx").on(t.personId)],
);

/** The analyst's reading of a conversation (every value carries the visitor's own words). */
export type AssistantAnalysis = {
  summary: string;
  intent: string;
  interests: string[];
  urgency: "low" | "medium" | "high" | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  objections: string[];
  quotes: Record<string, string>;
  tags: string[];
};

export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    id: id(),
    visitorId: uuid()
      .notNull()
      .references(() => assistantVisitors.id, { onDelete: "cascade" }),
    personId: uuid().references(() => persons.id),
    role: assistantConversationsRole().notNull().default("guide"),
    status: assistantConversationsStatus().notNull().default("open"),
    locale: text().notNull().default("nl-BE"),
    page: text(),
    messageCount: integer().notNull().default(0),
    unansweredCount: integer().notNull().default(0),
    /** From the first staff reply on, the agent stays silent in this conversation. */
    takenOverByUserId: uuid().references(() => users.id),
    contactOfferedAt: tstz(),
    contactCapturedAt: tstz(),
    bookingLinkClickedAt: tstz(),
    analysis: jsonb().$type<AssistantAnalysis>(),
    score: smallint(),
    scoreReason: text(),
    analysedAt: tstz(),
    analysedMessageCount: integer().notNull().default(0),
    costCents: numeric({ precision: 12, scale: 4 }).notNull().default("0"),
    lastMessageAt: tstz().notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index("assistant_conversations_visitor_idx").on(t.visitorId),
    index("assistant_conversations_person_idx").on(t.personId),
    index("assistant_conversations_last_idx").on(t.lastMessageAt.desc()),
    check("assistant_conversations_score_ck", sql`${t.score} is null or ${t.score} between 0 and 100`),
  ],
);

/** A card the widget renders under an answer. */
export type AssistantCard =
  | { type: "sessions"; sessions: { id: string; title: string; startsAt: string; kind: string; free: number; priceCents: number | null; href: string }[] }
  | { type: "link"; label: string; href: string }
  | { type: "contact" }
  | { type: "handoff" };

/** One tool call of an answer, for the back-office trace. */
export type AssistantToolCall = { name: string; input: unknown; output: unknown; ms: number };

export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: id(),
    conversationId: uuid()
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    author: assistantMessagesAuthor().notNull(),
    staffUserId: uuid().references(() => users.id),
    body: text().notNull(),
    /** answered | unknown | handoff | limited | contact (assistant messages only). */
    kind: text(),
    cards: jsonb().$type<AssistantCard[]>().notNull().default(sql`'[]'::jsonb`),
    tools: jsonb().$type<AssistantToolCall[]>().notNull().default(sql`'[]'::jsonb`),
    model: text(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cacheReadTokens: integer().notNull().default(0),
    cacheWriteTokens: integer().notNull().default(0),
    costCents: numeric({ precision: 12, scale: 4 }).notNull().default("0"),
    durationMs: integer(),
    rating: smallint(),
    createdAt: createdAt(),
  },
  (t) => [
    index("assistant_messages_conversation_idx").on(t.conversationId, t.createdAt),
    check("assistant_messages_body_ck", sql`char_length(${t.body}) <= 8000`),
    check("assistant_messages_rating_ck", sql`${t.rating} is null or ${t.rating} in (-1, 1)`),
  ],
);

/**
 * The agent log: one row per thing the agent did outside the chat (contact saved, consent
 * recorded, tag applied, score set, handoff opened, task created, automation enrolment).
 */
export const assistantActions = pgTable(
  "assistant_actions",
  {
    id: id(),
    conversationId: uuid().references(() => assistantConversations.id, { onDelete: "cascade" }),
    personId: uuid().references(() => persons.id),
    kind: text().notNull(),
    detail: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index("assistant_actions_created_idx").on(t.createdAt.desc()),
    index("assistant_actions_person_idx").on(t.personId),
    check("assistant_actions_kind_ck", sql`${t.kind} ~ '^[a-z_]{2,40}$'`),
  ],
);

/** The evaluation set: real questions with what a good answer must contain. */
export const assistantEvalCases = pgTable("assistant_eval_cases", {
  id: id(),
  role: assistantConversationsRole().notNull().default("guide"),
  locale: text().notNull().default("nl-BE"),
  question: text().notNull(),
  expectation: text().notNull(),
  ...timestamps(),
});

/** One case answered by one model: the answer, its cost and speed, and the judge's verdict. */
export const assistantEvalRuns = pgTable(
  "assistant_eval_runs",
  {
    id: id(),
    runKey: text().notNull(),
    caseId: uuid()
      .notNull()
      .references(() => assistantEvalCases.id, { onDelete: "cascade" }),
    model: text().notNull(),
    answer: text().notNull(),
    passed: smallint(),
    verdict: text(),
    costCents: numeric({ precision: 12, scale: 4 }).notNull().default("0"),
    durationMs: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("assistant_eval_runs_key_idx").on(t.runKey, t.model)],
);
