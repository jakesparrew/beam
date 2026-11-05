/**
 * Natural-language questions (ops rule 77, R4), the work of the inline job `ai.answer_question`:
 *
 * 1. Claude (`ai.answer_question`, Opus) gets the `ai` schema description (`describeAiSchema`)
 *    and the question and returns `{ sql, refusal? }` (structured output).
 * 2. `validateAiSql` accepts one read-only statement over `ai` views (DPIA-gated views only while
 *    their DPIA is approved) and caps it at 200 rows; anything else is `refused`.
 * 3. Platform's `runAiReadOnlyQuery` runs it as `beam_ai_ro` (5 s; a timeout is `timeout`).
 * 4. Claude gets the question, the column names and at most 200 rows, without any person id
 *    column, and writes a short explanation in the asking user's locale.
 *
 * Every Claude call and the SQL run leave an `ai_requests` row (platform). A spent budget is
 * `budget_exceeded`. The `nl_questions` row holds the SQL, status, columns, row count and
 * explanation, never the rows. Names for `person_id` links are resolved on the server by the
 * action (`personLinks`), never sent to Claude.
 */
import { z } from "zod";
import type { DbOrTx } from "@beam/db";
import { nlQuestions, persons, users } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import { AiSqlRejectedError } from "@beam/core/ai";
import { DPIA_KEYS, type DpiaKey } from "@beam/core/ops";
import type { Locale } from "@beam/core/i18n";
import { and, eq, inArray, isNull } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { AiSqlRunError, callClaude, runAiReadOnlyQuery } from "@/modules/platform/api";
import { isDpiaApproved } from "../exports/api";
import { describeAiSchema } from "../../../../../packages/core/src/ops/ai-schema-doc";
import { AI_SQL_ROW_LIMIT, validateAiSql } from "../../../../../packages/core/src/ops/validate-ai-sql";

export type NlStatus = "answered" | "refused" | "error" | "timeout" | "budget_exceeded";

export type AskOutcome = {
  questionId: string;
  status: NlStatus;
  columns: string[];
  rows: unknown[][];
  explanation: string | null;
  sql: string | null;
};

/** Claude's first answer (rule 77). */
export const AskSqlOutput = z.object({ sql: z.string().max(20_000), refusal: z.string().max(500).nullable().optional() });
/** Claude's second answer. */
export const AskExplanationOutput = z.object({ explanation: z.string().max(4000) });

/** Marks the system prompt of the explanation call (the fake gateway scripts it apart from the SQL call). */
export const EXPLAIN_SYSTEM_PREFIX = "You explain the result of a question about BEAM Vitality Center's data.";

const LANGUAGE: Record<Locale, string> = { "nl-BE": "Dutch (Belgium)", "fr-BE": "French (Belgium)", en: "English" };

/** Columns that hold a person id: rendered as links, never sent to Claude. */
export function isPersonIdColumn(name: string): boolean {
  return name === "person_id" || name.endsWith("_person_id");
}

/** The status a failed Claude call maps to (platform's `callClaude` messages, PL-56 and PL-59). */
function statusOfClaudeError(error: unknown): NlStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PermanentError && message === "budget") return "budget_exceeded";
  if (message.startsWith("refusal:")) return "refused";
  return "error";
}

async function dpiaState(db: DbOrTx): Promise<Record<DpiaKey, boolean>> {
  const out = {} as Record<DpiaKey, boolean>;
  for (const key of DPIA_KEYS) out[key] = await isDpiaApproved(db, key);
  return out;
}

/** The rows sent with the explanation request: no person id column, at most 200 rows, short cells. */
export function explanationPayload(question: string, columns: readonly string[], rows: readonly unknown[][]): string {
  const keep = columns.map((c, i) => ({ c, i })).filter(({ c }) => !isPersonIdColumn(c));
  const cell = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v.slice(0, 200) : v);
  return JSON.stringify({
    question,
    columns: keep.map(({ c }) => c),
    rows: rows.slice(0, AI_SQL_ROW_LIMIT).map((r) => keep.map(({ i }) => cell(r[i]))),
    rowCount: rows.length,
  });
}

/** Answers question `questionId` (the `ai.answer_question` job). A finished question is not asked again. */
export async function answerQuestion(ctx: JobCtx, questionId: string): Promise<AskOutcome> {
  const started = Date.now();
  const [q] = await ctx.tx
    .select({
      id: nlQuestions.id,
      userId: nlQuestions.userId,
      question: nlQuestions.question,
      status: nlQuestions.status,
      generatedSql: nlQuestions.generatedSql,
      explanation: nlQuestions.explanation,
      aiRequestIds: nlQuestions.aiRequestIds,
      columns: nlQuestions.columns,
    })
    .from(nlQuestions)
    .where(eq(nlQuestions.id, questionId));
  if (!q) throw new PermanentError(`nl_question_not_found: ${questionId}`);

  const dpia = await dpiaState(ctx.tx);
  // Idempotent: a question with a result is not sent to Claude again; an answered one re-reads its rows.
  if (q.aiRequestIds.length > 0 || q.status !== "error" || q.generatedSql !== null) {
    let rows: unknown[][] = [];
    let columns = q.columns;
    if (q.status === "answered" && q.generatedSql) {
      const checked = validateAiSql(q.generatedSql, { dpiaApproved: dpia });
      if (checked.ok) {
        const result = await runAiReadOnlyQuery(ctx, checked.sql).catch(() => null);
        if (result) ({ rows, columns } = { rows: result.rows.slice(0, AI_SQL_ROW_LIMIT), columns: result.columns });
      }
    }
    return { questionId, status: q.status, columns, rows, explanation: q.explanation, sql: q.generatedSql };
  }

  const [user] = await ctx.tx.select({ locale: users.locale }).from(users).where(eq(users.id, q.userId));
  const locale: Locale = user?.locale ?? "en";
  const aiRequestIds: string[] = [];
  const finish = async (out: Omit<AskOutcome, "questionId">): Promise<AskOutcome> => {
    await ctx.tx
      .update(nlQuestions)
      .set({
        status: out.status,
        generatedSql: out.sql,
        columns: out.columns,
        rowCount: out.status === "answered" ? out.rows.length : null,
        explanation: out.explanation,
        aiRequestIds,
        durationMs: Date.now() - started,
        updatedAt: ctx.now,
      })
      .where(eq(nlQuestions.id, questionId));
    return { questionId, ...out };
  };

  // 1. The SQL.
  let answer: z.infer<typeof AskSqlOutput>;
  try {
    const res = await callClaude(ctx, {
      feature: "ai.answer_question",
      model: "opus",
      system: describeAiSchema(),
      messages: [{ role: "user", content: q.question }],
      fieldsSent: [],
      outputSchema: AskSqlOutput,
      maxTokens: 2048,
    });
    aiRequestIds.push(res.aiRequestId);
    answer = res.parsed;
  } catch (error) {
    const status = statusOfClaudeError(error);
    return finish({ status, columns: [], rows: [], explanation: null, sql: null });
  }
  const proposed = answer.sql.trim();
  if (answer.refusal || !proposed) {
    return finish({ status: "refused", columns: [], rows: [], explanation: (answer.refusal ?? "").slice(0, 500) || null, sql: proposed || null });
  }

  // 2. Validation.
  const checked = validateAiSql(proposed, { dpiaApproved: dpia });
  if (!checked.ok) return finish({ status: "refused", columns: [], rows: [], explanation: checked.reason, sql: proposed });

  // 3. The read-only run.
  let columns: string[];
  let rows: unknown[][];
  try {
    const result = await runAiReadOnlyQuery(ctx, checked.sql);
    columns = result.columns;
    rows = result.rows.slice(0, AI_SQL_ROW_LIMIT);
  } catch (error) {
    if (error instanceof AiSqlRunError && error.reason === "timeout") return finish({ status: "timeout", columns: [], rows: [], explanation: null, sql: checked.sql });
    if (error instanceof AiSqlRejectedError) return finish({ status: "refused", columns: [], rows: [], explanation: error.message, sql: checked.sql });
    return finish({ status: "error", columns: [], rows: [], explanation: error instanceof Error ? error.message.slice(0, 500) : null, sql: checked.sql });
  }

  // 4. The explanation (a failure keeps the answer without one).
  let explanation: string | null;
  try {
    const res = await callClaude(ctx, {
      feature: "ai.answer_question",
      model: "opus",
      system: `${EXPLAIN_SYSTEM_PREFIX} Write two to four plain sentences in ${LANGUAGE[locale]} for a staff member. Use only the rows given; amounts ending in _cents are euro cents. Do not mention SQL.`,
      messages: [{ role: "user", content: explanationPayload(q.question, columns, rows) }],
      fieldsSent: [],
      outputSchema: AskExplanationOutput,
      maxTokens: 1024,
    });
    aiRequestIds.push(res.aiRequestId);
    explanation = res.parsed.explanation.trim() || null;
  } catch {
    explanation = null;
  }
  return finish({ status: "answered", columns, rows, explanation, sql: checked.sql });
}

/** Display names for the person ids in `person_id` columns (staff screen only; erased people have none). */
export async function personLinks(db: DbOrTx, columns: readonly string[], rows: readonly unknown[][]): Promise<Record<string, string>> {
  const ids = new Set<string>();
  columns.forEach((c, i) => {
    if (!isPersonIdColumn(c)) return;
    for (const r of rows) {
      const v = r[i];
      if (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)) ids.add(v.toLowerCase());
    }
  });
  if (ids.size === 0) return {};
  const found = await db
    .select({ id: persons.id, firstName: persons.firstName, lastName: persons.lastName })
    .from(persons)
    .where(and(inArray(persons.id, [...ids]), isNull(persons.erasedAt)));
  return Object.fromEntries(found.map((p) => [p.id, [p.firstName, p.lastName].filter(Boolean).join(" ") || p.id.slice(0, 8)]));
}
