/**
 * Ops' check of the SQL Claude writes for a natural-language question (ops rule 77). It runs
 * before platform's `runAiReadOnlyQuery`, which checks again with `assertAiSqlSafe` and trusts no
 * caller. On top of platform's guard (`checkAiSql`: one `select` or `with ... select`, no `;`, no
 * comments, no DML or DDL words, functions of `AI_SQL_FUNCTIONS` only) it requires:
 *
 * - every relation to be a view of the `ai` schema (`ai.<view>`, an unqualified view name of
 *   `AI_VIEW_NAMES`, or a name the statement's own `with` defines);
 * - every `DPIA_GATED_AI_RELATIONS` relation to have its DPIA approved (else `dpia_not_approved`);
 * - at most 200 rows: `limit 200` is appended when the statement has no top-level limit, and a
 *   statement whose limit is not a number up to 200 is wrapped in `select * from (...) limit 200`.
 *
 * `AI_SQL_FUNCTIONS` is platform's one list, re-exported here (ops defines none; cross-module
 * decision 46).
 */
import { AI_SQL_FUNCTIONS, checkAiSql } from "../ai/sql-guard";
import { AI_VIEW_NAMES } from "./ai-schema-doc";
import { DPIA_GATED_AI_RELATIONS } from "./dpia";
import type { DpiaKey } from "./types";

export { AI_SQL_FUNCTIONS };

/** The most rows a question returns and sends on to Claude. */
export const AI_SQL_ROW_LIMIT = 200;

export type ValidateAiSqlResult = { ok: true; sql: string } | { ok: false; reason: string };

type Tok = { kind: "word"; value: string; quoted: boolean } | { kind: "string" } | { kind: "number"; value: string } | { kind: "punct"; value: string };

/** A small tokenizer; `checkAiSql` already refused comments, `;`, `$` and unterminated literals. */
function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "\\" && /[eE]/.test(sql[i - 1] ?? "")) j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      out.push({ kind: "string" });
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let name = "";
      while (j < sql.length && !(sql[j] === '"' && sql[j + 1] !== '"')) {
        name += sql[j] === '"' ? '"' : sql[j];
        j += sql[j] === '"' ? 2 : 1;
      }
      out.push({ kind: "word", value: name, quoted: true });
      i = j + 1;
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j]!)) j += 1;
      const word = sql.slice(i, j).toLowerCase();
      // E'...', B'...', X'...', N'...' literals.
      if (sql[j] === "'" && ["e", "b", "x", "n"].includes(word)) {
        i = j;
        continue;
      }
      out.push({ kind: "word", value: word, quoted: false });
      i = j;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < sql.length && /[0-9A-Za-z_.]/.test(sql[j]!)) j += 1;
      out.push({ kind: "number", value: sql.slice(i, j) });
      i = j;
    } else if (c === ":" && sql[i + 1] === ":") {
      out.push({ kind: "punct", value: "::" });
      i += 2;
    } else {
      out.push({ kind: "punct", value: c });
      i += 1;
    }
  }
  return out;
}

const isKw = (t: Tok | undefined, v: string) => !!t && t.kind === "word" && !t.quoted && t.value === v;
const isP = (t: Tok | undefined, v: string) => !!t && t.kind === "punct" && t.value === v;
const FROM_END = new Set(["where", "group", "order", "having", "limit", "offset", "union", "intersect", "except", "window", "fetch", "for", "select"]);

/** Names the statement defines with `with name [(cols)] as (`. */
function cteNames(t: Tok[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    if (tok.kind !== "word") continue;
    const prev = t[i - 1];
    if (!(isKw(prev, "with") || isKw(prev, "recursive") || isP(prev, ","))) continue;
    let j = i + 1;
    if (isP(t[j], "(")) {
      let depth = 0;
      for (; j < t.length; j++) {
        if (isP(t[j], "(")) depth += 1;
        if (isP(t[j], ")") && --depth === 0) break;
      }
      j += 1;
    }
    if (isKw(t[j], "as") && (isP(t[j + 1], "(") || isKw(t[j + 1], "materialized") || isKw(t[j + 1], "not"))) names.add(tok.value);
  }
  return names;
}

/** Relations of FROM lists and joins, as `{ schema, name }` (`schema` null when unqualified); `(` subqueries are skipped. */
function relations(t: Tok[]): { schema: string | null; name: string }[] {
  const found: { schema: string | null; name: string }[] = [];
  const opener: string[] = [];
  const inFrom: boolean[] = [false];
  const take = (at: number) => {
    let k = at;
    while (isKw(t[k], "only") || isKw(t[k], "lateral")) k += 1;
    const a = t[k];
    if (!a || a.kind !== "word") return;
    if (isP(t[k + 1], ".") && t[k + 2]?.kind === "word") found.push({ schema: a.value, name: (t[k + 2] as { value: string }).value });
    else found.push({ schema: null, name: a.value });
  };
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    const depth = opener.length;
    if (isP(tok, "(")) {
      const prev = t[i - 1];
      opener.push(prev?.kind === "word" ? prev.value : "");
      inFrom[opener.length] = false;
    } else if (isP(tok, ")")) {
      inFrom[depth] = false;
      opener.pop();
    } else if (isKw(tok, "from") && opener[depth - 1] !== "extract") {
      inFrom[depth] = true;
      take(i + 1);
    } else if (isKw(tok, "join")) {
      inFrom[depth] = true;
      take(i + 1);
    } else if (isP(tok, ",") && inFrom[depth]) {
      take(i + 1);
    } else if (tok.kind === "word" && !tok.quoted && FROM_END.has(tok.value)) {
      inFrom[depth] = false;
    }
  }
  return found;
}

/** `{ hasLimit, smallEnough }` for the statement's top-level `limit` / `fetch first`. */
function topLevelLimit(t: Tok[]): { has: boolean; small: boolean } {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    if (isP(tok, "(")) depth += 1;
    else if (isP(tok, ")")) depth -= 1;
    else if (depth === 0 && (isKw(tok, "limit") || isKw(tok, "fetch"))) {
      let n = t[i + 1];
      if (isKw(tok, "fetch")) n = t[i + 2];
      const value = n && n.kind === "number" && /^\d+$/.test(n.value) ? Number(n.value) : null;
      return { has: true, small: value !== null && value <= AI_SQL_ROW_LIMIT };
    }
  }
  return { has: false, small: false };
}

/** Rule 77: accepts one read-only statement over the `ai` schema, with at most 200 rows. */
export function validateAiSql(sql: string, opts: { dpiaApproved: Record<DpiaKey, boolean> }): ValidateAiSqlResult {
  const text = sql.trim();
  if (!text) return { ok: false, reason: "empty" };
  const guard = checkAiSql(text);
  if (!guard.ok) return { ok: false, reason: guard.offending ? `${guard.reason}: ${guard.offending}` : guard.reason };

  const tokens = tokenize(text);
  const ctes = cteNames(tokens);
  const views = new Set(AI_VIEW_NAMES);
  const used = new Set<string>();
  for (const rel of relations(tokens)) {
    if (rel.schema === null) {
      if (ctes.has(rel.name)) continue;
      if (!views.has(rel.name)) return { ok: false, reason: `relation_outside_ai: ${rel.name}` };
      used.add(`ai.${rel.name}`);
    } else {
      if (rel.schema !== "ai") return { ok: false, reason: `relation_outside_ai: ${rel.schema}.${rel.name}` };
      if (!views.has(rel.name)) return { ok: false, reason: `unknown_relation: ai.${rel.name}` };
      used.add(`ai.${rel.name}`);
    }
  }
  // Belt and braces for the DPIA check: an `ai.<view>` anywhere in the statement counts as read.
  for (let i = 0; i + 2 < tokens.length; i++) {
    const next = tokens[i + 2]!;
    if (isKw(tokens[i], "ai") && isP(tokens[i + 1], ".") && next.kind === "word" && views.has(next.value)) used.add(`ai.${next.value}`);
  }
  if (used.size === 0) return { ok: false, reason: "no_relation" };

  for (const [key, gated] of Object.entries(DPIA_GATED_AI_RELATIONS) as [DpiaKey, readonly string[]][]) {
    if (opts.dpiaApproved[key]) continue;
    const hit = gated.find((r) => used.has(r));
    if (hit) return { ok: false, reason: `dpia_not_approved: ${key} (${hit})` };
  }

  const limit = topLevelLimit(tokens);
  if (!limit.has) return { ok: true, sql: `${text}\nlimit ${AI_SQL_ROW_LIMIT}` };
  if (limit.small) return { ok: true, sql: text };
  return { ok: true, sql: `select * from (\n${text}\n) as answer limit ${AI_SQL_ROW_LIMIT}` };
}
