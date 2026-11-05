import { describe, expect, it } from "vitest";
import * as coreAi from "../ai";
import { DPIA_KEYS } from "./dpia";
import type { DpiaKey } from "./types";
import { AI_VIEWS, AI_VIEW_NAMES, describeAiSchema } from "./ai-schema-doc";
import { AI_SQL_FUNCTIONS, AI_SQL_ROW_LIMIT, validateAiSql } from "./validate-ai-sql";

const all = (value: boolean) => Object.fromEntries(DPIA_KEYS.map((k) => [k, value])) as Record<DpiaKey, boolean>;
const approved = { dpiaApproved: all(true) };
const notApproved = { dpiaApproved: all(false) };

const refused = (sql: string, opts = approved) => {
  const out = validateAiSql(sql, opts);
  expect(out.ok, sql).toBe(false);
  return out.ok ? "" : out.reason;
};
const accepted = (sql: string, opts = approved) => {
  const out = validateAiSql(sql, opts);
  if (!out.ok) throw new Error(`refused: ${out.reason} (${sql})`);
  return out.sql;
};

describe("validateAiSql (rule 77)", () => {
  it("accepts one select over ai views and appends limit 200", () => {
    expect(accepted("select day_on, sum(gross_cents) as cents from ai.revenue group by day_on order by day_on desc")).toBe(
      "select day_on, sum(gross_cents) as cents from ai.revenue group by day_on order by day_on desc\nlimit 200",
    );
    expect(accepted("  with m as (select date_trunc('month', paid_at) as month, sum(total_cents) as cents from ai.orders group by 1) select * from m  ")).toMatch(
      /\nlimit 200$/,
    );
    expect(AI_SQL_ROW_LIMIT).toBe(200);
  });

  it("keeps a top-level limit up to 200 and wraps a larger or computed one", () => {
    expect(accepted("select order_id from ai.orders limit 20")).toBe("select order_id from ai.orders limit 20");
    expect(accepted("select order_id from ai.orders limit 5000")).toBe("select * from (\nselect order_id from ai.orders limit 5000\n) as answer limit 200");
    expect(accepted("select order_id from ai.orders limit all")).toMatch(/^select \* from \(/);
    // A limit inside a subquery is not the statement's limit.
    expect(accepted("select * from (select order_id from ai.orders limit 3) o")).toMatch(/\nlimit 200$/);
  });

  it("rejects ; and more than one statement", () => {
    expect(refused("select 1 from ai.orders;")).toMatch(/multiple_statements/);
    expect(refused("select 1 from ai.orders; delete from ai.orders")).toMatch(/multiple_statements/);
  });

  it("rejects DML and DDL", () => {
    for (const sql of [
      "delete from ai.orders",
      "update ai.orders set total_cents = 0",
      "insert into ai.orders (order_id) values (null)",
      "drop view ai.orders",
      "create table ai.x (a int)",
      "truncate ai.orders",
      "with d as (delete from ai.orders returning *) select * from d",
      "select * into ai.copy from ai.orders",
      "alter role beam_ai_ro superuser",
      "grant select on public.persons to beam_ai_ro",
    ]) {
      expect(refused(sql)).toMatch(/first_keyword|forbidden_word/);
    }
  });

  it("rejects pg_ functions, set_config, current_setting and any function outside AI_SQL_FUNCTIONS", () => {
    expect(refused("select pg_read_file('/etc/passwd') from ai.orders")).toMatch(/function_not_allowed: pg_read_file/);
    expect(refused("select pg_sleep(10)")).toMatch(/function_not_allowed/);
    expect(refused("select set_config('role', 'postgres', true) from ai.orders")).toMatch(/function_not_allowed: set_config/);
    expect(refused("select current_setting('role') from ai.orders")).toMatch(/function_not_allowed: current_setting/);
    expect(refused("select dblink('host=x', 'select 1') from ai.orders")).toMatch(/function_not_allowed: dblink/);
    expect(refused("select lo_import('/tmp/x') from ai.orders")).toMatch(/function_not_allowed: lo_import/);
    expect(refused("select md5(sku) from ai.products")).toMatch(/function_not_allowed: md5/);
    expect(refused('select "pg_sleep"(1) from ai.orders')).toMatch(/function_not_allowed/);
    expect(refused("select pg_catalog.now() from ai.orders")).toMatch(/relation_outside_ai|function_not_allowed/);
    for (const fn of ["count", "sum", "date_trunc", "percentile_cont", "string_agg"]) expect(AI_SQL_FUNCTIONS).toContain(fn);
  });

  it("rejects relations outside ai", () => {
    expect(refused("select email from public.persons")).toMatch(/relation_outside_ai/);
    expect(refused("select email from persons")).toMatch(/relation_outside_ai: persons/);
    expect(refused("select * from pg_catalog.pg_roles")).toMatch(/relation_outside_ai/);
    expect(refused("select * from pg_user")).toMatch(/relation_outside_ai/);
    expect(refused("select * from information_schema.tables")).toMatch(/relation_outside_ai/);
    expect(refused("select * from ai.orders o join person_sensitive_fields s on true")).toMatch(/relation_outside_ai: person_sensitive_fields/);
    expect(refused("select * from ai.orders o, users u")).toMatch(/relation_outside_ai: users/);
    expect(refused("select * from ai.orders where person_id in (select id from persons)")).toMatch(/relation_outside_ai: persons/);
    expect(refused("select * from ai.not_a_view")).toMatch(/unknown_relation/);
    expect(refused("select 1")).toMatch(/no_relation/);
    // An unqualified ai view name and a CTE name are fine.
    expect(accepted("select count(*) from orders")).toMatch(/limit 200$/);
    expect(accepted("with persons as (select person_id from ai.orders) select count(*) from persons")).toMatch(/limit 200$/);
    // extract(... from ...) is not a FROM clause.
    expect(accepted("select extract(year from paid_at) as y, count(*) from ai.orders group by 1")).toMatch(/limit 200$/);
  });

  it("rejects comments, including comments hiding statements", () => {
    expect(refused("select 1 from ai.orders -- ; delete from ai.orders")).toMatch(/comment/);
    expect(refused("select 1 from ai.orders /* hidden */")).toMatch(/comment/);
    expect(refused("select 1 from ai.orders /*; drop view ai.orders */")).toMatch(/comment/);
    expect(refused("select 1 from ai.orders where 1 =--1\n 1")).toMatch(/comment/);
    // The words inside a string literal are not SQL.
    expect(accepted("select count(*) from ai.orders where channel = '-- not a comment; delete'")).toMatch(/limit 200$/);
  });

  it("refuses ai.retention_candidates and ai.customers while ai_customer_ranking is not approved", () => {
    expect(refused("select person_id, reason from ai.retention_candidates", notApproved)).toMatch(/dpia_not_approved: ai_customer_ranking/);
    expect(refused("select person_id, reason from retention_candidates", notApproved)).toMatch(/dpia_not_approved/);
    expect(refused("select o.order_id from ai.orders o join ai.order_lines l on true, ai.retention_candidates r", notApproved)).toMatch(/dpia_not_approved/);
    expect(refused("select first_name from ai.customers", notApproved)).toMatch(/dpia_not_approved: ai_customer_ranking/);
    const onlyRanking = { dpiaApproved: { ...all(false), ai_customer_ranking: true } };
    expect(accepted("select person_id, reason from ai.retention_candidates", onlyRanking)).toMatch(/limit 200$/);
    // Aggregate views stay open without the DPIA.
    expect(accepted("select sum(gross_cents) from ai.revenue", notApproved)).toMatch(/limit 200$/);
  });

  it("re-exports platform's AI_SQL_FUNCTIONS: the same object as @beam/core/ai's", () => {
    expect(AI_SQL_FUNCTIONS).toBe(coreAi.AI_SQL_FUNCTIONS);
  });
});

describe("the ai schema description", () => {
  it("lists every view once, qualified, with columns, and names no forbidden column", () => {
    expect(new Set(AI_VIEW_NAMES).size).toBe(AI_VIEWS.length);
    for (const view of AI_VIEWS) {
      expect(view.name).toMatch(/^ai\.[a-z_]+$/);
      expect(view.columns.length).toBeGreaterThan(0);
      for (const c of view.columns) expect(c.split(" ")[0]).not.toMatch(/email|phone|last_name|address|^notes$|^answers$/);
    }
    for (const name of ["customers", "orders", "order_lines", "revenue", "bookings", "grants", "memberships", "retention_candidates", "campaign_attribution", "ad_spend_daily", "opportunities", "webinar_performance_daily", "package_cycles", "form_funnel_daily", "form_outcomes"]) {
      expect(AI_VIEW_NAMES).toContain(name);
    }
    const text = describeAiSchema();
    for (const view of AI_VIEWS) expect(text).toContain(view.name);
    for (const fn of AI_SQL_FUNCTIONS) expect(text).toContain(fn);
  });
});
