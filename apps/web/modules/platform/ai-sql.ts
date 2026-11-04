/**
 * R4 (platform-P10): the read-only runner of Claude-written SQL (`runAiReadOnlyQuery`, platform
 * spec 4.8, decisions 44 and 81, cross-module decision 46). Ops' NL questions call it after
 * their own `validateAiSql`; this runner is the last line of defence and trusts no caller:
 *
 * 1. `assertAiSqlSafe(sql)` (`@beam/core/ai`): one `select`/`with`, no comments, no dollar
 *    quoting, no DML/DDL words, relations of schema `ai` only, functions of `AI_SQL_FUNCTIONS` only.
 * 2. A read-only (sub)transaction on the job's own connection (the normal pooled connection;
 *    `SET LOCAL` is safe in PgBouncer's transaction mode): `set transaction read only`,
 *    `set local role beam_ai_ro` (no grant on `public`), `set local search_path = ai`,
 *    `set local statement_timeout = '5s'`.
 * 3. The statement runs through a cursor, so at most `AI_SQL_MAX_ROWS` rows are ever fetched.
 * 4. The (sub)transaction is always rolled back, which also undoes the `SET LOCAL`s.
 * 5. One `ai_requests` row per call, written durably (it survives a rollback of the job): the
 *    SQL in `prompt`, the column names and row count (never row values) in `output`.
 */
import type { DbOrTx } from "@beam/db";
import { aiRequests } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import { AI_FEATURES, AiSqlRejectedError, assertAiSqlSafe, isAiFeatureKey, modelIdFor, type AiFeatureKey } from "@beam/core/ai";
import { actorJson, sql, writeDurably } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";

/** Rows returned at most; a statement with more is cut (`output.truncated`). */
export const AI_SQL_MAX_ROWS = 1000;
/** Postgres `statement_timeout` of every AI statement. */
export const AI_SQL_TIMEOUT = "5s";
/** The role of `0100_ai_readonly.sql`. */
export const AI_SQL_ROLE = "beam_ai_ro";
/** The `ai_requests.prompt` prefix of a SQL log row (the read-only SQL log on `/admin/system/ai`). */
export const AI_SQL_LOG_PREFIX = "[sql]\n";
/** The feature a SQL row is booked under when the calling job is not an AI feature job. */
export const AI_SQL_DEFAULT_FEATURE: AiFeatureKey = "ai.answer_question";

export type AiSqlResult = { columns: string[]; rows: unknown[][] };

export type AiSqlFailure = "timeout" | "permission_denied" | "read_only" | "duplicate_columns" | "invalid";

/** The statement passed the guard but Postgres refused or cancelled it. Permanent: the same SQL fails again. */
export class AiSqlRunError extends PermanentError {
  override readonly name = "AiSqlRunError";
  readonly code = "ai_sql_failed" as const;
  constructor(
    readonly reason: AiSqlFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`ai_sql_failed: ${reason}: ${message.slice(0, 300)}`, options);
  }
}

export type RunAiSqlOptions = {
  /**
   * Tests only (refused outside Vitest): skip `assertAiSqlSafe` to prove what the database
   * layer refuses on its own (permission denied, the read-only transaction, the timeout).
   */
  skipGuard?: "test-only";
};

const CURSOR = "beam_ai_cursor";

class Rollback extends Error {}

function pgCode(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

function pgMessage(error: unknown): string {
  const cause = (error as { cause?: unknown })?.cause;
  const own = error instanceof Error ? error.message : String(error);
  return cause instanceof Error && cause.message ? cause.message : own;
}

/** Postgres error -> the runner's failure (SQLSTATE: 57014 cancel, 42501 privilege, 25006 read-only). */
export function toAiSqlRunError(error: unknown): AiSqlRunError {
  if (error instanceof AiSqlRunError) return error;
  const code = pgCode(error);
  const message = pgMessage(error);
  const reason: AiSqlFailure =
    code === "57014" || /statement timeout/i.test(message)
      ? "timeout"
      : code === "42501" || /permission denied/i.test(message)
        ? "permission_denied"
        : code === "25006" || /read-only transaction/i.test(message)
          ? "read_only"
          : "invalid";
  return new AiSqlRunError(reason, message, { cause: error });
}

type Fields = { name: string }[] | undefined;

function resultParts(result: unknown): { rows: Record<string, unknown>[]; fields: Fields } {
  if (result && typeof result === "object" && "rows" in result) {
    const r = result as { rows: Record<string, unknown>[]; fields?: Fields };
    return { rows: r.rows, fields: r.fields };
  }
  return { rows: result as Record<string, unknown>[], fields: undefined };
}

function isUnderTest(): boolean {
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

/** Runs the statement in a read-only, rolled-back (sub)transaction as `beam_ai_ro`. */
async function execute(tx: DbOrTx, text: string): Promise<AiSqlResult & { truncated: boolean }> {
  let out: (AiSqlResult & { truncated: boolean }) | undefined;
  try {
    await tx.transaction(async (q) => {
      await q.execute(sql.raw("set transaction read only"));
      await q.execute(sql.raw(`set local role ${AI_SQL_ROLE}`));
      await q.execute(sql.raw("set local search_path = ai"));
      await q.execute(sql.raw(`set local statement_timeout = '${AI_SQL_TIMEOUT}'`));
      // A cursor accepts only a query (no DML, no data-modifying WITH) and fetches lazily.
      await q.execute(sql.raw(`declare ${CURSOR} no scroll cursor for ${text}`));
      const { rows, fields } = resultParts(await q.execute(sql.raw(`fetch forward ${AI_SQL_MAX_ROWS + 1} from ${CURSOR}`)));
      const columns = fields?.map((f) => f.name) ?? Object.keys(rows[0] ?? {});
      if (new Set(columns).size !== columns.length) {
        throw new AiSqlRunError("duplicate_columns", `duplicate column names: ${columns.filter((c, i) => columns.indexOf(c) !== i).join(", ")}`);
      }
      out = {
        columns,
        rows: rows.slice(0, AI_SQL_MAX_ROWS).map((row) => columns.map((c) => row[c])),
        truncated: rows.length > AI_SQL_MAX_ROWS,
      };
      // Always roll back: nothing to keep, and it undoes the role, path and timeout.
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw toAiSqlRunError(error);
  }
  return out!;
}

async function logSql(
  ctx: JobCtx,
  text: string,
  row: { status: "ok" | "error"; output?: string; error?: string; durationMs: number },
): Promise<void> {
  const kind = ctx.job.kind as string;
  const feature: AiFeatureKey = isAiFeatureKey(kind) ? kind : AI_SQL_DEFAULT_FEATURE;
  await writeDurably(ctx, async (db) => {
    await db.insert(aiRequests).values({
      feature,
      // `ai_requests.model` is checked against the Claude models: book the row under the feature's.
      model: modelIdFor(AI_FEATURES[feature].model),
      actor: actorJson(ctx.actor),
      personId: null,
      fieldsSent: [],
      prompt: `${AI_SQL_LOG_PREFIX}${text}`,
      output: row.output ?? null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costCents: "0",
      status: row.status,
      error: row.error ?? null,
      jobId: ctx.job.id || null,
      durationMs: row.durationMs,
    });
  });
}

/**
 * Runs one Claude-written statement read-only as `beam_ai_ro` and returns its column names and
 * at most 1,000 rows. Throws `AiSqlRejectedError` (the guard) or `AiSqlRunError` (Postgres),
 * both permanent; either way one `ai_requests` row records the SQL.
 */
export async function runAiReadOnlyQuery(ctx: JobCtx, sqlText: string, options: RunAiSqlOptions = {}): Promise<AiSqlResult> {
  if (options.skipGuard && !isUnderTest()) throw new PermanentError("ai_sql: skipGuard is for tests only");
  const text = sqlText.trim();
  const started = Date.now();
  try {
    if (!options.skipGuard) assertAiSqlSafe(text);
  } catch (error) {
    const message = error instanceof AiSqlRejectedError ? error.message : String(error);
    await logSql(ctx, text, { status: "error", error: message, durationMs: Date.now() - started });
    throw error;
  }
  try {
    const result = await execute(ctx.tx, text);
    await logSql(ctx, text, {
      status: "ok",
      output: JSON.stringify({ columns: result.columns, rowCount: result.rows.length, truncated: result.truncated }),
      durationMs: Date.now() - started,
    });
    return { columns: result.columns, rows: result.rows };
  } catch (error) {
    const failure = toAiSqlRunError(error);
    await logSql(ctx, text, { status: "error", error: failure.message.slice(0, 1000), durationMs: Date.now() - started });
    throw failure;
  }
}

// ---------------------------------------------------------------------------------------------
// `/admin/system/ai` (R4): per-day usage and the read-only SQL log, from `ai_requests`.
// ---------------------------------------------------------------------------------------------

export type AiDailyUsage = { day: string; calls: number; costCents: number; sqlRuns: number; sqlErrors: number };

const monthStart = (month: string | undefined) => (month && /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : null);

/** `created_at` within the Brussels month starting on `start` (`YYYY-MM-01`). */
const inBrusselsMonth = (start: string) =>
  sql`created_at >= (${start}::date::timestamp at time zone 'Europe/Brussels') and created_at < ((${start}::date + interval '1 month')::timestamp at time zone 'Europe/Brussels')`;

/**
 * One row per Brussels day of `month` (`YYYY-MM`) with at least one `ai_requests` row: Claude
 * calls (budget refusals excluded) and their cost, and the read-only SQL runs and failures.
 */
export async function getAiDailyUsage(tx: DbOrTx, input: { month: string }): Promise<AiDailyUsage[]> {
  const start = monthStart(input.month);
  if (!start) return [];
  const rows = rowsOf<{ day: string; calls: number; cost_cents: string | number; sql_runs: number; sql_errors: number }>(
    await tx.execute(sql`
      select to_char(created_at at time zone 'Europe/Brussels', 'YYYY-MM-DD') as day,
             count(*) filter (where prompt not like '[sql]%' and status <> 'budget_exceeded')::int as calls,
             coalesce(sum(cost_cents) filter (where prompt not like '[sql]%'), 0)::float8 as cost_cents,
             count(*) filter (where prompt like '[sql]%')::int as sql_runs,
             count(*) filter (where prompt like '[sql]%' and status = 'error')::int as sql_errors
      from ai_requests where ${inBrusselsMonth(start)}
      group by 1 order by 1`),
  );
  return rows.map((r) => ({ day: r.day, calls: Number(r.calls), costCents: Number(r.cost_cents), sqlRuns: Number(r.sql_runs), sqlErrors: Number(r.sql_errors) }));
}

export type AiSqlLogEntry = {
  id: string;
  createdAt: Date;
  feature: string;
  status: "ok" | "error";
  sql: string;
  rowCount: number | null;
  truncated: boolean;
  error: string | null;
  durationMs: number | null;
};

/** The latest read-only SQL runs (newest first, at most 200), from the `[sql]` rows of `ai_requests`. */
export async function listAiSqlLog(tx: DbOrTx, input: { month?: string; limit?: number } = {}): Promise<AiSqlLogEntry[]> {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 200);
  const start = monthStart(input.month);
  const rows = rowsOf<{ id: string; created_at: string | Date; feature: string; status: string; prompt: string; output: string | null; error: string | null; duration_ms: number | null }>(
    await tx.execute(sql`
      select id::text as id, created_at, feature, status::text as status, prompt, output, error, duration_ms
      from ai_requests where prompt like '[sql]%'${start ? sql` and ${inBrusselsMonth(start)}` : sql``}
      order by created_at desc, id desc limit ${limit}`),
  );
  return rows.map((r) => {
    let parsed: { rowCount?: unknown; truncated?: unknown } = {};
    try {
      parsed = r.output ? (JSON.parse(r.output) as typeof parsed) : {};
    } catch {
      parsed = {};
    }
    return {
      id: r.id,
      createdAt: new Date(r.created_at),
      feature: r.feature,
      status: r.status === "ok" ? "ok" : "error",
      sql: r.prompt.startsWith(AI_SQL_LOG_PREFIX) ? r.prompt.slice(AI_SQL_LOG_PREFIX.length) : r.prompt,
      rowCount: typeof parsed.rowCount === "number" ? parsed.rowCount : null,
      truncated: parsed.truncated === true,
      error: r.error,
      durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    };
  });
}
