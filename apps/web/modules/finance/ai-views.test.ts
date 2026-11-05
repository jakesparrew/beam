/**
 * finance-P10 `FINANCE_AI_VIEWS`: the views ops may expose in the `ai` schema are aggregates with
 * no person column, no contact field, no customer snapshot and no `SENSITIVE_COLUMNS` member,
 * checked against the real database columns (`createTestDb()`) and the Drizzle declarations.
 */
import { getViewConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import * as schema from "@beam/db/schema";
import { SENSITIVE_COLUMNS } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { FINANCE_AI_VIEW_DESCRIPTIONS, FINANCE_AI_VIEWS } from "./ai-views";
import * as api from "./api";

const FORBIDDEN = ["email", "phone", "address", "customer_snapshot", "customer_name", "person_id", "company_id", "first_name", "last_name", "name", "vat_number", "billing_email"];

let h: DbHandle;
let columns: Map<string, string[]>;

beforeAll(async () => {
  h = await createTestDb();
  const rows = rowsOf<{ table_name: string; column_name: string }>(
    await h.db.execute(sql`select table_name::text, column_name::text from information_schema.columns
      where table_schema = 'public' and table_name in (${sql.join(FINANCE_AI_VIEWS.map((v) => sql`${v}`), sql`, `)})`),
  );
  columns = new Map();
  for (const r of rows) columns.set(r.table_name, [...(columns.get(r.table_name) ?? []), r.column_name]);
});
afterAll(() => h.close());

/** The Drizzle view object declared for `name`, if any. */
function declaredView(name: string) {
  for (const value of Object.values(schema)) {
    try {
      const config = getViewConfig(value as never);
      if (config?.name === name) return config;
    } catch {
      // not a pg view
    }
  }
  return undefined;
}

describe("FINANCE_AI_VIEWS", () => {
  it("lists the four aggregate views of the spec, not the open-invoice list", () => {
    expect(FINANCE_AI_VIEWS).toEqual(expect.arrayContaining(["v_finance_revenue_daily", "v_finance_vat_summary", "v_finance_failed_payments", "v_finance_recurring_monthly"]));
    expect(FINANCE_AI_VIEWS).not.toContain("v_finance_open_invoices");
    expect(FINANCE_AI_VIEWS).not.toContain("v_finance_invoice_lines");
    expect(api.FINANCE_AI_VIEWS).toBe(FINANCE_AI_VIEWS);
  });

  it("every listed view exists in the database and is described", () => {
    for (const view of FINANCE_AI_VIEWS) {
      expect(columns.get(view)?.length ?? 0, view).toBeGreaterThan(0);
      expect(FINANCE_AI_VIEW_DESCRIPTIONS[view]).toMatch(/\S/);
    }
  });

  it("no listed view has a contact, person or snapshot column, or a SENSITIVE_COLUMNS member", () => {
    const sensitive = new Set(SENSITIVE_COLUMNS.map((c) => c.column));
    expect(sensitive.size).toBeGreaterThan(0);
    for (const view of FINANCE_AI_VIEWS) {
      const declared = Object.values(declaredView(view)?.selectedFields ?? {}).map((c) => (c as { name: string }).name);
      expect(declared.length, `${view} is declared in finance.views.ts`).toBeGreaterThan(0);
      for (const column of new Set([...(columns.get(view) ?? []), ...declared])) {
        expect(FORBIDDEN, `${view}.${column}`).not.toContain(column);
        expect(sensitive.has(column), `${view}.${column} is a SENSITIVE_COLUMNS member`).toBe(false);
        expect(column, `${view}.${column}`).not.toMatch(/email|phone|address|snapshot|person|customer/);
      }
    }
  });

  it("the check would catch the excluded open-invoice list", () => {
    const open = Object.values(declaredView("v_finance_open_invoices")?.selectedFields ?? {}).map((c) => (c as { name: string }).name);
    expect(open.some((c) => FORBIDDEN.includes(c))).toBe(true);
  });

  it("the view definitions read no person table and no customer snapshot", async () => {
    const defs = rowsOf<{ name: string; definition: string }>(
      await h.db.execute(sql`select viewname::text as name, definition from pg_views
        where schemaname = 'public' and viewname in (${sql.join(FINANCE_AI_VIEWS.map((v) => sql`${v}`), sql`, `)})`),
    );
    expect(defs.map((d) => d.name).sort()).toEqual([...FINANCE_AI_VIEWS].sort());
    for (const d of defs) {
      expect(d.definition, d.name).not.toMatch(/customer_snapshot|\bpersons\b|person_id|billing_details/);
    }
  });
});
