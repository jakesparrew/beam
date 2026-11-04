import { describe, expect, it } from "vitest";
import { PermanentError } from "../errors";
import * as ai from "./index";
import { AI_SQL_FUNCTIONS, AiSqlRejectedError, assertAiSqlSafe, checkAiSql, type AiSqlRejection } from "./sql-guard";

const rejected = (sql: string): { reason: AiSqlRejection; offending: string } => {
  const result = checkAiSql(sql);
  if (result.ok) throw new Error(`expected a rejection: ${sql}`);
  return { reason: result.reason, offending: result.offending };
};

describe("AI_SQL_FUNCTIONS", () => {
  it("is the spec's list, frozen, and exported from @beam/core/ai", () => {
    expect([...AI_SQL_FUNCTIONS]).toEqual([
      "count", "sum", "avg", "min", "max", "round", "coalesce", "nullif", "greatest", "least", "lower", "upper",
      "date_trunc", "extract", "date_part", "to_char", "now", "current_date", "age", "make_date", "row_number",
      "rank", "dense_rank", "lag", "lead", "percentile_cont", "string_agg", "array_agg",
    ]);
    expect(Object.isFrozen(AI_SQL_FUNCTIONS)).toBe(true);
    expect(() => (AI_SQL_FUNCTIONS as unknown as string[]).push("set_config")).toThrow();
    expect(ai.AI_SQL_FUNCTIONS).toBe(AI_SQL_FUNCTIONS);
    expect(ai.assertAiSqlSafe).toBe(assertAiSqlSafe);
  });
});

describe("assertAiSqlSafe: the spec's cases", () => {
  it.each([
    ["select set_config('role', current_user, true)", "set_config"],
    ["select current_setting('role')", "current_setting"],
    ["select pg_read_file('x')", "pg_read_file"],
  ])("refuses %s naming %s", (sql, name) => {
    let error: unknown;
    try {
      assertAiSqlSafe(sql);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AiSqlRejectedError);
    expect(error).toBeInstanceOf(PermanentError);
    expect(error).toMatchObject({ reason: "function_not_allowed", offending: name });
    expect((error as Error).message).toContain(name);
  });

  it("refuses select public.persons.email from public.persons, naming the relation", () => {
    expect(() => assertAiSqlSafe("select public.persons.email from public.persons")).toThrow(/public\.persons/);
    expect(rejected("select public.persons.email from public.persons").reason).toBe("relation_outside_ai");
    expect(rejected("select email from public.persons")).toEqual({ reason: "relation_outside_ai", offending: "public.persons" });
  });

  it("refuses delete and update statements and every listed word", () => {
    expect(rejected("delete from ai.customers")).toEqual({ reason: "first_keyword", offending: "delete" });
    expect(rejected("update ai.customers set status = 'x'")).toEqual({ reason: "first_keyword", offending: "update" });
    expect(rejected("with x as (delete from ai.customers returning *) select * from x")).toEqual({ reason: "forbidden_word", offending: "delete" });
    for (const word of ["insert", "update", "delete", "merge", "copy", "call", "do", "set", "reset", "grant", "create", "alter", "drop", "lock", "listen", "notify"]) {
      expect(rejected(`select 1 from ai.customers where ${word} = 1`), word).toEqual({ reason: "forbidden_word", offending: word });
    }
    expect(rejected("select * from ai.customers for update").offending).toBe("update");
    expect(rejected("select * into scratch from ai.customers").offending).toBe("into");
  });

  it("refuses more than one statement, comments and dollar quoting", () => {
    expect(rejected("select 1; select 2").reason).toBe("multiple_statements");
    expect(rejected("select 1;").reason).toBe("multiple_statements");
    expect(rejected("select 1 -- trailing").reason).toBe("comment");
    expect(rejected("select /* hidden */ 1").reason).toBe("comment");
    expect(rejected("select 1 +-- x").reason).toBe("comment");
    expect(rejected("select $$x$$").reason).toBe("dollar_quoting");
    expect(rejected("select $tag$x$tag$").reason).toBe("dollar_quoting");
    expect(rejected("select $1").reason).toBe("dollar_quoting");
  });

  it("refuses a first keyword other than select or with", () => {
    for (const sql of ["table ai.customers", "values (1)", "explain select 1", "show search_path", "begin", "(values (1))"]) {
      expect(rejected(sql).reason, sql).toBe("first_keyword");
    }
    expect(rejected("").reason).toBe("empty");
    expect(rejected("   ").reason).toBe("empty");
  });

  it("refuses functions outside the list: pg_*, dblink*, lo_*, query_to_xml, generate_series, qualified and quoted names", () => {
    for (const [sql, name] of [
      ["select dblink('host=x', 'select 1')", "dblink"],
      ["select dblink_exec('x')", "dblink_exec"],
      ["select lo_import('/etc/passwd')", "lo_import"],
      ["select query_to_xml('select * from public.persons', true, true, '')", "query_to_xml"],
      ["select * from generate_series(1, 10)", "generate_series"],
      ["select count(*) from ai.customers where length(first_name) > 3", "length"],
      ["select pg_sleep(10)", "pg_sleep"],
      ["select pg_catalog.set_config('role', 'x', true)", "pg_catalog.set_config"],
      ["select ai.helper(1)", "ai.helper"],
      ['select "set_config"(\'role\', \'x\', true)', '"set_config"'],
      ['select "count"(*) from ai.customers', '"count"'],
      ["select SET_CONFIG('role', 'x', true)", "set_config"],
    ]) {
      expect(rejected(sql!), sql).toMatchObject({ offending: name });
    }
  });

  it("refuses relations outside ai, including pg_* relations that resolve to pg_catalog", () => {
    for (const [sql, name] of [
      ["select * from pg_catalog.pg_authid", "pg_catalog.pg_authid"],
      ["select * from pg_roles", "pg_roles"],
      ["select * from pg_settings", "pg_settings"],
      ['select * from "pg_stat_activity"', '"pg_stat_activity"'],
      ["select * from information_schema.tables", "information_schema.tables"],
      ["select * from ai.customers c join crm.persons p on p.id = c.person_id", "crm.persons"],
      ["select * from ai.customers c, public.persons p", "public.persons"],
      ["select * from ai.customers c left join lateral (select 1) x on true, other.t", "other.t"],
      ['select * from "public"."persons"', '"public"."persons"'],
      ["select * from ai.orders where order_id in (select id from public.orders)", "public.orders"],
      ["select x.y.z.w from ai.customers", "x.y.z.w"],
    ]) {
      expect(rejected(sql!), sql).toEqual({ reason: "relation_outside_ai", offending: name });
    }
  });

  it("reads string literals and quoted identifiers as single tokens", () => {
    // Forbidden words, `;`, `--` and functions inside literals are data, not SQL.
    assertAiSqlSafe("select count(*) from ai.customers where status = 'delete; drop table x -- pg_read_file('")
    assertAiSqlSafe("select first_name as \"Delete; me\" from ai.customers where tags @> array['it''s']");
    assertAiSqlSafe("select count(*) from ai.customers where first_name = E'O\\'Brien; drop'");
    // An unterminated literal could hide the rest of the statement.
    expect(rejected("select 'abc").reason).toBe("unterminated_literal");
    expect(rejected('select "abc').reason).toBe("unterminated_literal");
    // E'' with an escaped quote must not end early and expose a fake end.
    expect(rejected("select E'\\'' , pg_read_file('x')").offending).toBe("pg_read_file");
  });
});

describe("assertAiSqlSafe: what NL questions need passes", () => {
  it.each([
    "select person_id, first_name, revenue_cents from ai.customers order by revenue_cents desc limit 10",
    "SELECT count(*) FROM ai.customers WHERE is_member",
    "with top as (select person_id, sum(total_cents) as total from ai.orders where paid_at >= date_trunc('year', now()) group by person_id) select c.first_name, t.total from top t join ai.customers c on c.person_id = t.person_id order by t.total desc",
    "select date_trunc('month', day_on) as month, sum(revenue_cents)::numeric(12, 2) / 100 as eur from ai.revenue group by 1 order by 1",
    "select extract(year from paid_at) as y, extract(epoch from now() - paid_at) as s, count(*) from ai.orders group by 1, 2",
    "select percentile_cont(0.5) within group (order by total_cents) from ai.orders",
    "select person_id, row_number() over (partition by status order by revenue_cents desc) as rn from ai.customers",
    "select count(*) filter (where status = 'customer') as customers, count(distinct person_id) from ai.customers",
    "select coalesce(nullif(acquisition_source, ''), 'unknown') as source, count(*) from ai.customers group by 1",
    "select to_char(starts_at, 'YYYY-MM') as month, count(*) from ai.bookings where starts_at between now() - interval '90 days' and now() group by 1",
    "select cast(revenue_cents as numeric(12, 2)) from ai.customers where exists (select 1 from ai.orders o where o.person_id = ai.customers.person_id)",
    "select * from (select status, count(*) as n from ai.customers group by status) as s(status, n) where n > any (array[1, 2])",
    "select string_agg(first_name, ', ') from ai.customers where locale in ('nl-BE', 'fr-BE')",
    "select age(current_date, make_date(2026, 1, 1)), greatest(1, 2), least(3, 4), round(1.234, 2), lower('A'), upper('b')",
    "(select 1) union (select 2)",
    "with recursive w as materialized (select 1 as n) select n from w",
  ])("%s", (sql) => {
    expect(checkAiSql(sql)).toEqual({ ok: true });
  });
});
