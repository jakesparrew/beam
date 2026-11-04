/**
 * The statement guard of R4's read-only AI SQL (platform-P10, cross-module decision 46).
 *
 * `assertAiSqlSafe(sql)` is what platform's `runAiReadOnlyQuery` checks before it runs a
 * Claude-written statement as `beam_ai_ro`. It does not trust ops' `validateAiSql`, which runs
 * first. The SQL is tokenised (string literals and quoted identifiers are read as single
 * tokens, so their content is never mistaken for SQL) and then refused for:
 * - more than one statement (any `;`), comments (`--`, `/*`) and dollar quoting (any `$`);
 * - a first keyword other than `select` or `with`;
 * - the words `insert`, `update`, `delete`, `merge`, `copy`, `call`, `do`, `set`, `reset`,
 *   `grant`, `create`, `alter`, `drop`, `lock`, `listen`, `notify` (also `revoke`, `truncate`,
 *   `vacuum`, `execute`, `prepare`, `declare`, `discard`, `into`);
 * - any schema-qualified relation outside `ai.` (and unqualified `pg_*` relations, which
 *   would resolve to `pg_catalog`), any name qualified by `public`, `pg_catalog`,
 *   `information_schema` or a `pg_*` schema;
 * - every function call whose name is not in `AI_SQL_FUNCTIONS`, so `set_config`,
 *   `current_setting`, `pg_*`, `dblink*`, `lo_*` and `query_to_xml` are always refused
 *   (`set_config('role', ...)` would undo `SET LOCAL ROLE`). Qualified and quoted function
 *   names are refused too.
 *
 * `AI_SQL_FUNCTIONS` is the one list: ops' `validateAiSql` imports and re-exports it and
 * defines none of its own, so the guard cannot be widened from ops.
 */
import { PermanentError } from "../errors";

export const AI_SQL_FUNCTIONS = Object.freeze([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "round",
  "coalesce",
  "nullif",
  "greatest",
  "least",
  "lower",
  "upper",
  "date_trunc",
  "extract",
  "date_part",
  "to_char",
  "now",
  "current_date",
  "age",
  "make_date",
  "row_number",
  "rank",
  "dense_rank",
  "lag",
  "lead",
  "percentile_cont",
  "string_agg",
  "array_agg",
] as const);

export type AiSqlFunction = (typeof AI_SQL_FUNCTIONS)[number];

/** Words that never appear in a read-only `select`: refused anywhere outside a literal. */
export const AI_SQL_FORBIDDEN_WORDS = Object.freeze([
  "insert",
  "update",
  "delete",
  "merge",
  "copy",
  "call",
  "do",
  "set",
  "reset",
  "grant",
  "create",
  "alter",
  "drop",
  "lock",
  "listen",
  "notify",
  "revoke",
  "truncate",
  "vacuum",
  "execute",
  "prepare",
  "declare",
  "discard",
  "into",
] as const);

/**
 * SQL keywords that may be followed by `(` without being a function call. The spec's list,
 * plus structural keywords that no callable function is named after.
 */
export const AI_SQL_CALL_KEYWORDS = Object.freeze([
  "in",
  "exists",
  "any",
  "all",
  "some",
  "over",
  "filter",
  "within",
  "as",
  "on",
  "using",
  "cast",
  "and",
  "or",
  "not",
  "from",
  "join",
  "select",
  "values",
  "when",
  "then",
  "else",
  "where",
  "having",
  "by",
  "case",
  "distinct",
  "between",
  "like",
  "ilike",
  "is",
  "limit",
  "offset",
  "union",
  "intersect",
  "except",
  "lateral",
  "materialized",
] as const);

/** Schemas whose names may never qualify anything in AI SQL. */
const DENIED_QUALIFIERS = new Set(["public", "pg_catalog", "information_schema"]);
/** Ends a FROM list at its parenthesis depth (a join condition does not: `on x, other_relation`). */
const FROM_LIST_END = new Set(["where", "group", "order", "having", "limit", "offset", "union", "intersect", "except", "window", "fetch", "for", "select", "returning"]);
const JOIN_WORDS = new Set(["join", "left", "right", "full", "inner", "outer", "cross", "natural", "lateral"]);

export const AI_SQL_MAX_LENGTH = 20_000;

export type AiSqlRejection =
  | "empty"
  | "too_long"
  | "multiple_statements"
  | "comment"
  | "dollar_quoting"
  | "unterminated_literal"
  | "first_keyword"
  | "forbidden_word"
  | "relation_outside_ai"
  | "function_not_allowed";

export type AiSqlCheck = { ok: true } | { ok: false; reason: AiSqlRejection; offending: string };

/** Thrown by `assertAiSqlSafe`; permanent (a retry sends the same SQL). */
export class AiSqlRejectedError extends PermanentError {
  override readonly name = "AiSqlRejectedError";
  readonly code = "ai_sql_rejected" as const;
  constructor(
    readonly reason: AiSqlRejection,
    readonly offending: string,
  ) {
    super(`ai_sql_rejected: ${reason}${offending ? ` (${offending})` : ""}`);
  }
}

type Token =
  | { kind: "word"; value: string; quoted: boolean; raw: string }
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "punct"; value: string };

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/;
const OPERATOR_CHARS = "+-*/<>=~!@#%^&|`?";

class Rejection extends Error {
  constructor(
    readonly reason: AiSqlRejection,
    readonly offending: string,
  ) {
    super(reason);
  }
}

/** Reads a `'...'` literal from `i` (the opening quote); `escapes` for `E'...'`. Returns the index after it. */
function readString(sql: string, i: number, escapes: boolean): number {
  let j = i + 1;
  while (j < sql.length) {
    const c = sql[j]!;
    if (escapes && c === "\\") {
      j += 2;
      continue;
    }
    if (c === "'") {
      if (sql[j + 1] === "'") {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j += 1;
  }
  throw new Rejection("unterminated_literal", "'");
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if ((c === "-" && next === "-") || (c === "/" && next === "*")) throw new Rejection("comment", c + next);
    if (c === ";") throw new Rejection("multiple_statements", ";");
    if (c === "$") throw new Rejection("dollar_quoting", "$");
    if (c === "\\") throw new Rejection("forbidden_word", "\\");
    if (c === "'") {
      i = readString(sql, i, false);
      tokens.push({ kind: "string" });
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let name = "";
      for (;;) {
        if (j >= sql.length) throw new Rejection("unterminated_literal", '"');
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            name += '"';
            j += 2;
            continue;
          }
          break;
        }
        name += sql[j];
        j += 1;
      }
      tokens.push({ kind: "word", value: name, quoted: true, raw: `"${name}"` });
      i = j + 1;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < sql.length && IDENT_PART.test(sql[j]!)) j += 1;
      const raw = sql.slice(i, j);
      const lower = raw.toLowerCase();
      // E'...' (backslash escapes), B'...', X'...', N'...' literals.
      if (sql[j] === "'" && (lower === "e" || lower === "b" || lower === "x" || lower === "n")) {
        i = readString(sql, j, lower === "e");
        tokens.push({ kind: "string" });
        continue;
      }
      tokens.push({ kind: "word", value: lower, quoted: false, raw });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && next !== undefined && /[0-9]/.test(next))) {
      let j = i + 1;
      while (j < sql.length && /[0-9A-Za-z_.]/.test(sql[j]!)) {
        if ((sql[j] === "e" || sql[j] === "E") && (sql[j + 1] === "+" || sql[j + 1] === "-")) j += 1;
        j += 1;
      }
      tokens.push({ kind: "number" });
      i = j;
      continue;
    }
    if (c === ":" && next === ":") {
      tokens.push({ kind: "punct", value: "::" });
      i += 2;
      continue;
    }
    if (OPERATOR_CHARS.includes(c)) {
      let j = i + 1;
      while (j < sql.length && OPERATOR_CHARS.includes(sql[j]!)) {
        if ((sql[j] === "-" && sql[j + 1] === "-") || (sql[j] === "/" && sql[j + 1] === "*")) throw new Rejection("comment", sql.slice(j, j + 2));
        j += 1;
      }
      tokens.push({ kind: "punct", value: sql.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ kind: "punct", value: c });
    i += 1;
  }
  return tokens;
}

type Word = Extract<Token, { kind: "word" }>;
/** An unquoted word. */
const isWord = (t: Token | undefined): t is Word => !!t && t.kind === "word" && !t.quoted;
/** The unquoted keyword `value` (not a type guard: a `false` says nothing about the token's kind). */
const isKw = (t: Token | undefined, value: string): boolean => isWord(t) && t.value === value;
const isPunct = (t: Token | undefined, value: string) => !!t && t.kind === "punct" && t.value === value;
const nameOf = (t: Word) => (t.quoted ? t.raw : t.value);

function check(sql: string): void {
  if (sql.length > AI_SQL_MAX_LENGTH) throw new Rejection("too_long", String(sql.length));
  const tokens = tokenize(sql);
  if (tokens.length === 0) throw new Rejection("empty", "");

  // The first keyword (after any opening parentheses) is `select` or `with`.
  const first = tokens.find((t) => !isPunct(t, "("));
  if (!isWord(first) || (first.value !== "select" && first.value !== "with")) {
    throw new Rejection("first_keyword", first && first.kind === "word" ? nameOf(first) : first?.kind === "punct" ? first.value : (first?.kind ?? ""));
  }

  for (const t of tokens) {
    if (isWord(t) && (AI_SQL_FORBIDDEN_WORDS as readonly string[]).includes(t.value)) throw new Rejection("forbidden_word", t.value);
  }

  // Qualified names: `a.b`, `a.b.c`, `a.b(`.
  const qualified = new Map<number, { parts: string[]; end: number }>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t?.kind !== "word" || isPunct(tokens[i - 1], ".")) continue;
    const parts = [nameOf(t)];
    let j = i;
    while (isPunct(tokens[j + 1], ".") && (tokens[j + 2]?.kind === "word" || isPunct(tokens[j + 2], "*"))) {
      const part = tokens[j + 2]!;
      parts.push(part.kind === "word" ? nameOf(part) : "*");
      j += 2;
    }
    if (parts.length < 2) continue;
    qualified.set(i, { parts, end: j });
    const head = t.value.toLowerCase();
    const dotted = parts.join(".");
    if (DENIED_QUALIFIERS.has(head) || head.startsWith("pg_")) throw new Rejection("relation_outside_ai", dotted);
    if (parts.length >= 3 && !(isKw(t, "ai") && parts.length === 3)) throw new Rejection("relation_outside_ai", dotted);
    if (isPunct(tokens[j + 1], "(")) throw new Rejection("function_not_allowed", dotted);
  }

  // Relations of FROM lists and joins: qualified ones must be `ai.<name>`; no `pg_*` names.
  const opener: string[] = [];
  const fromDepth: boolean[] = [];
  const expectRelation = (at: number) => {
    let k = at;
    while (isKw(tokens[k], "only")) k += 1;
    const t = tokens[k];
    if (!t || t.kind !== "word") return;
    if (isKw(t, "lateral") || isKw(t, "select") || isKw(t, "with")) return;
    const q = qualified.get(k);
    if (q) {
      if (!(isKw(t, "ai") && q.parts.length === 2)) throw new Rejection("relation_outside_ai", q.parts.join("."));
      return;
    }
    if (t.value.toLowerCase().startsWith("pg_") || t.value.toLowerCase() === "information_schema") throw new Rejection("relation_outside_ai", nameOf(t));
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const depth = opener.length;
    if (isPunct(t, "(")) {
      const prev = tokens[i - 1];
      opener.push(isWord(prev) ? prev.value : "");
      fromDepth[opener.length] = false;
      continue;
    }
    if (isPunct(t, ")")) {
      fromDepth[depth] = false;
      opener.pop();
      continue;
    }
    if (isKw(t, "from") && opener[depth - 1] !== "extract") {
      fromDepth[depth] = true;
      expectRelation(i + 1);
      continue;
    }
    if (isKw(t, "join")) {
      fromDepth[depth] = true;
      expectRelation(i + 1);
      continue;
    }
    if (isPunct(t, ",") && fromDepth[depth]) {
      expectRelation(i + 1);
      continue;
    }
    if (isWord(t) && FROM_LIST_END.has(t.value) && !JOIN_WORDS.has(t.value)) fromDepth[depth] = false;
  }

  // Function calls: a name followed by `(`.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t?.kind !== "word" || !isPunct(tokens[i + 1], "(") || isPunct(tokens[i - 1], ".")) continue;
    if (t.quoted) throw new Rejection("function_not_allowed", nameOf(t));
    const prev = tokens[i - 1];
    // A type modifier (`::numeric(10, 2)`, `cast(x as numeric(10, 2))`) or an alias column list (`as t(a, b)`).
    if (isPunct(prev, "::") || isKw(prev, "as")) continue;
    if (t.value === "group" && isKw(prev, "within")) continue;
    if ((AI_SQL_CALL_KEYWORDS as readonly string[]).includes(t.value)) continue;
    if ((AI_SQL_FUNCTIONS as readonly string[]).includes(t.value)) continue;
    throw new Rejection("function_not_allowed", t.value);
  }
}

/** The guard without throwing: `{ ok: false, reason, offending }` names the first problem found. */
export function checkAiSql(sql: string): AiSqlCheck {
  try {
    check(sql);
    return { ok: true };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, reason: error.reason, offending: error.offending };
    throw error;
  }
}

/** Throws `AiSqlRejectedError` (with the offending name) unless `sql` passes the guard. */
export function assertAiSqlSafe(sql: string): void {
  const result = checkAiSql(sql);
  if (!result.ok) throw new AiSqlRejectedError(result.reason, result.offending);
}
