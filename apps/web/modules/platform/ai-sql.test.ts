/**
 * R4 (platform-P10): the read-only AI SQL runner on PGlite with platform's
 * `0100_ai_readonly.sql` applied. Ops' `0101_ai_views_ops.sql` (every `ai.*` view) is not
 * part of this package: the test creates its own throw-away view in `ai` and grants it the way
 * ops' file does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { applyCustomSql, createTestDb, makePerson } from "@beam/db/testing";
import type { Db, DbHandle, Tx } from "@beam/db";
import { AI_SQL_FUNCTIONS, AiSqlRejectedError } from "@beam/core/ai";
import * as coreOps from "@beam/core/ops";
import { PermanentError } from "@beam/core/errors";
import { makeJobCtx } from "@/lib/testing";
import { rowsOf } from "@/lib/sensitive";
import * as platformApi from "./api";
import { AI_SQL_LOG_PREFIX, AI_SQL_MAX_ROWS, AiSqlRunError, runAiReadOnlyQuery } from "./ai-sql";

let handle: DbHandle;
let db: Db;

const q = async <T>(text: string) => rowsOf<T>(await db.execute(sql.raw(text)));
const sqlRows = () =>
  q<{ feature: string; model: string; prompt: string; output: string | null; status: string; error: string | null; fields_sent: string[]; cost_cents: string }>(
    `select feature, model, prompt, output, status::text as status, error, fields_sent, cost_cents::text as cost_cents from ai_requests where prompt like '[sql]%' order by created_at, id`,
  );
const ctx = () => makeJobCtx(db, "ai.answer_question");

beforeAll(async () => {
  handle = await createTestDb();
  db = handle.db;
  expect(await applyCustomSql(handle, { files: ["0100_ai_readonly.sql"] })).toEqual(["0100_ai_readonly.sql"]);
  await makePerson(db, { firstName: "Lotte", email: "lotte.ai-sql@example.com" });
  await makePerson(db, { firstName: "Jan", email: "jan.ai-sql@example.com" });
});
afterAll(() => handle.close());
beforeEach(async () => {
  await db.execute(sql.raw("drop view if exists ai.test_people"));
  // ai_requests is append-only: clearing the previous test's SQL rows uses the retention bypass.
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw("set local beam.allow_rewrite = 'on'"));
    await tx.execute(sql.raw("delete from ai_requests where prompt like '[sql]%'"));
  });
});

/** The way ops' `0101` exposes a view: in schema `ai`, `select` granted to `beam_ai_ro`. */
async function createTestView(): Promise<void> {
  await db.execute(sql.raw("create or replace view ai.test_people as select first_name, locale::text as locale from public.persons"));
  await db.execute(sql.raw("grant select on ai.test_people to beam_ai_ro"));
}

describe("0100_ai_readonly.sql", () => {
  it("creates the schema ai and the NOLOGIN role beam_ai_ro with usage on it, and no view", async () => {
    expect(await q<{ n: number }>("select count(*)::int as n from pg_namespace where nspname = 'ai'")).toEqual([{ n: 1 }]);
    expect(await q("select rolcanlogin from pg_roles where rolname = 'beam_ai_ro'")).toEqual([{ rolcanlogin: false }]);
    expect(await q("select has_schema_privilege('beam_ai_ro', 'ai', 'usage') as usage, has_schema_privilege('beam_ai_ro', 'ai', 'create') as create")).toEqual([
      { usage: true, create: false },
    ]);
    expect(await q("select pg_has_role(current_user, 'beam_ai_ro', 'member') as member")).toEqual([{ member: true }]);
    expect(await q<{ n: number }>("select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'ai'")).toEqual([{ n: 0 }]);
    expect(await q("select has_table_privilege('beam_ai_ro', 'public.persons', 'select') as can")).toEqual([{ can: false }]);
  });

  it("is idempotent", async () => {
    await applyCustomSql(handle, { files: ["0100_ai_readonly.sql"] });
    expect(await q<{ n: number }>("select count(*)::int as n from pg_roles where rolname = 'beam_ai_ro'")).toEqual([{ n: 1 }]);
  });
});

describe("runAiReadOnlyQuery", () => {
  it("runs a guarded select over an ai view as beam_ai_ro and logs the SQL, never the rows", async () => {
    await createTestView();
    const statement = "select first_name, locale from ai.test_people where first_name in ('Lotte', 'Jan') order by first_name";
    const result = await runAiReadOnlyQuery(ctx(), statement);
    expect(result.columns).toEqual(["first_name", "locale"]);
    expect(result.rows.map((r) => r[0])).toEqual(["Jan", "Lotte"]);
    expect(result.rows.every((r) => r.length === 2 && typeof r[1] === "string")).toBe(true);
    const unqualified = await runAiReadOnlyQuery(ctx(), "select count(*) as n from test_people where first_name = 'Lotte'");
    expect(unqualified).toEqual({ columns: ["n"], rows: [[expect.anything()]] });
    const [first] = await sqlRows();
    expect(first).toMatchObject({ feature: "ai.answer_question", model: "claude-opus-5-5", status: "ok", error: null, fields_sent: [], cost_cents: "0.0000" });
    expect(first!.prompt).toBe(`${AI_SQL_LOG_PREFIX}${statement}`);
    expect(JSON.parse(first!.output!)).toEqual({ columns: ["first_name", "locale"], rowCount: 2, truncated: false });
    expect(first!.output).not.toContain("Lotte");
  });

  it("is the function behind platform's api.ts", async () => {
    await createTestView();
    expect(await platformApi.runAiReadOnlyQuery(ctx(), "select count(*) as n from ai.test_people")).toMatchObject({ columns: ["n"] });
    expect(platformApi.AiSqlRunError).toBe(AiSqlRunError);
  });

  it("rejects a delete or update statement before execution, and logs it", async () => {
    await createTestView();
    for (const statement of ["delete from ai.test_people", "update ai.test_people set first_name = 'x'", "select 1; delete from ai.test_people"]) {
      const c = ctx();
      const executed: unknown[] = [];
      const real = c.tx;
      c.tx = new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "transaction" || prop === "execute") executed.push(prop);
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
      const error = await runAiReadOnlyQuery(c, statement).catch((e: unknown) => e);
      expect(error, statement).toBeInstanceOf(AiSqlRejectedError);
      expect(error).toBeInstanceOf(PermanentError);
      expect(executed, statement).toEqual([]);
    }
    expect(await q<{ n: number }>("select count(*)::int as n from ai.test_people")).not.toEqual([{ n: 0 }]);
    const logged = await sqlRows();
    expect(logged).toHaveLength(3);
    for (const row of logged) expect(row).toMatchObject({ status: "error", error: expect.stringMatching(/^ai_sql_rejected: /), output: null });
  });

  it("refuses set_config, current_setting, pg_read_file and public.persons through the guard", async () => {
    for (const [statement, name] of [
      ["select set_config('role', current_user, true)", "set_config"],
      ["select current_setting('role')", "current_setting"],
      ["select pg_read_file('x')", "pg_read_file"],
      ["select public.persons.email from public.persons", "public.persons"],
    ]) {
      const error = await runAiReadOnlyQuery(ctx(), statement!).catch((e: unknown) => e);
      expect(error, statement).toBeInstanceOf(AiSqlRejectedError);
      expect((error as Error).message).toContain(name);
    }
  });

  it("past the guard, the database still refuses: person_sensitive_fields and public.persons are permission denied", async () => {
    for (const statement of ["select * from public.person_sensitive_fields", "select email from public.persons"]) {
      const error = await runAiReadOnlyQuery(ctx(), statement, { skipGuard: "test-only" }).catch((e: unknown) => e);
      expect(error, statement).toBeInstanceOf(AiSqlRunError);
      expect(error).toMatchObject({ reason: "permission_denied" });
      expect((error as Error).message).toMatch(/permission denied/);
    }
  });

  it("past the guard, writes fail in the read-only transaction and a cursor accepts no DML", async () => {
    await createTestView();
    await db.execute(sql.raw("grant insert, update on ai.test_people to beam_ai_ro"));
    const error = await runAiReadOnlyQuery(ctx(), "with x as (update ai.test_people set first_name = 'x' returning 1) select * from x", { skipGuard: "test-only" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AiSqlRunError);
    const plain = await runAiReadOnlyQuery(ctx(), "update ai.test_people set first_name = 'x'", { skipGuard: "test-only" }).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(AiSqlRunError);
    expect(await q<{ n: number }>("select count(*)::int as n from public.persons where first_name = 'x'")).toEqual([{ n: 0 }]);
  });

  it("runs as beam_ai_ro with search_path ai and a 5 s statement_timeout, read-only, and undoes them afterwards", async () => {
    const result = await runAiReadOnlyQuery(
      ctx(),
      "select current_user as u, current_setting('search_path') as path, current_setting('statement_timeout') as timeout, current_setting('transaction_read_only') as ro",
      { skipGuard: "test-only" },
    );
    expect(result.rows).toEqual([["beam_ai_ro", "ai", "5s", "on"]]);
    const after = await q<{ u: string; path: string; timeout: string }>(
      "select current_user as u, current_setting('search_path') as path, current_setting('statement_timeout') as timeout",
    );
    expect(after[0]!.u).not.toBe("beam_ai_ro");
    expect(after[0]!.path).not.toBe("ai");
    expect(after[0]!.timeout).not.toBe("5s");
  });

  it("works inside the job's own transaction (a savepoint) and leaves it usable", async () => {
    await createTestView();
    await db.transaction(async (tx) => {
      const c = makeJobCtx(db, "ai.answer_question", { tx: tx as unknown as Tx });
      await tx.execute(sql.raw("select 1"));
      expect((await runAiReadOnlyQuery(c, "select count(*) as n from ai.test_people")).columns).toEqual(["n"]);
      await runAiReadOnlyQuery(c, "select email from public.persons", { skipGuard: "test-only" }).catch(() => undefined);
      expect(rowsOf<{ u: string }>(await tx.execute(sql.raw("select current_user as u")))[0]!.u).not.toBe("beam_ai_ro");
      await tx.execute(sql.raw("create temporary table ai_sql_probe (x int)"));
    });
  });

  it("caps the result at 1,000 rows and records the cut", async () => {
    const result = await runAiReadOnlyQuery(ctx(), "select * from generate_series(1, 5000) as g(n)", { skipGuard: "test-only" });
    expect(result.rows).toHaveLength(AI_SQL_MAX_ROWS);
    expect(result.columns).toEqual(["n"]);
    expect(result.rows[999]).toEqual([1000]);
    expect(JSON.parse((await sqlRows())[0]!.output!)).toMatchObject({ rowCount: 1000, truncated: true });
  });

  it("refuses duplicate column names rather than returning wrong values", async () => {
    const error = await runAiReadOnlyQuery(ctx(), "select 1 as a, 2 as a", { skipGuard: "test-only" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "duplicate_columns" });
  });

  it("a cross join of two generate_series(1, 100000) is cut at 5 s (statement_timeout, SQLSTATE 57014)", async () => {
    // PGlite runs a statement synchronously and has no timer signal, so it cannot cancel one;
    // Postgres (Neon) does. The database is wrapped to answer the statement the way Postgres
    // does at the 5 s mark, after checking that the runner set the timeout first.
    const dialect = new PgDialect();
    const seen: string[] = [];
    const c = ctx();
    const real = c.tx;
    const wrap = (inner: Tx): Tx =>
      new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === "transaction") {
            return (cb: (q: Tx) => Promise<unknown>) => (target as Tx).transaction((qtx) => cb(wrap(qtx as unknown as Tx)));
          }
          if (prop === "execute") {
            return (query: SQL) => {
              const text = dialect.sqlToQuery(query).sql;
              seen.push(text);
              if (/cross join generate_series/.test(text)) {
                expect(seen).toContain("set local statement_timeout = '5s'");
                return Promise.reject(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
              }
              return (target as Tx).execute(query);
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
    c.tx = wrap(real);
    const statement = "select count(*) from generate_series(1, 100000) a cross join generate_series(1, 100000) b";
    const error = await runAiReadOnlyQuery(c, statement, { skipGuard: "test-only" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiSqlRunError);
    expect(error).toMatchObject({ reason: "timeout" });
    expect(seen.indexOf("set local statement_timeout = '5s'")).toBeLessThan(seen.findIndex((s) => s.includes("cross join")));
    const [row] = await sqlRows();
    expect(row).toMatchObject({ status: "error", error: expect.stringMatching(/^ai_sql_failed: timeout/) });
  });

  it("refuses skipGuard outside tests", async () => {
    const previous = { vitest: process.env.VITEST, node: process.env.NODE_ENV };
    process.env.VITEST = "";
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      await expect(runAiReadOnlyQuery(ctx(), "select 1", { skipGuard: "test-only" })).rejects.toThrow(/tests only/);
    } finally {
      process.env.VITEST = previous.vitest;
      (process.env as Record<string, string | undefined>).NODE_ENV = previous.node;
    }
  });
});

describe("AI_SQL_FUNCTIONS: one list (cross-module decision 46)", () => {
  it("platform's api re-exports @beam/core/ai's list; ops defines no other (once ops re-exports it, it is the same reference)", () => {
    expect(platformApi.AI_SQL_FUNCTIONS).toBe(AI_SQL_FUNCTIONS);
    const opsList = (coreOps as Record<string, unknown>).AI_SQL_FUNCTIONS;
    expect(opsList ?? AI_SQL_FUNCTIONS).toBe(AI_SQL_FUNCTIONS);
  });
});
