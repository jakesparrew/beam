import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { persons, SENSITIVE_COLUMNS } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import { EXPORT_ENTITIES, EXPORT_EXCLUDED_COLUMNS } from "@beam/core/ops";
import { eq, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { ENTITY_EXPORTS, entitySource, fullExportTables, fullTableSource, isExcludedColumn, readChunk } from "./entities";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

async function columnsOf(table: string): Promise<{ column: string; dataType: string }[]> {
  return rowsOf<{ column: string; dataType: string }>(
    await h.db.execute(sql`select column_name as "column", data_type as "dataType" from information_schema.columns where table_schema = 'public' and table_name = ${table}`),
  );
}

describe("entity column lists (ops rule 54)", () => {
  it("every entity has a list whose columns exist in its table", async () => {
    for (const entity of EXPORT_ENTITIES) {
      const def = ENTITY_EXPORTS[entity];
      const actual = (await columnsOf(def.table)).map((c) => c.column);
      expect(actual.length, def.table).toBeGreaterThan(0);
      for (const c of def.columns) expect(actual, `${entity}.${c}`).toContain(c);
      expect(new Set(def.columns).size, entity).toBe(def.columns.length);
    }
  });

  it("no list holds a SENSITIVE_COLUMNS member, a password, TOTP, recovery or token column, or a raw payload", async () => {
    for (const entity of EXPORT_ENTITIES) {
      const def = ENTITY_EXPORTS[entity];
      const types = new Map((await columnsOf(def.table)).map((c) => [c.column, c.dataType]));
      for (const s of SENSITIVE_COLUMNS.filter((s) => s.table === def.table)) expect(def.columns, `${entity} keeps ${s.column}`).not.toContain(s.column);
      for (const c of def.columns) {
        expect(isExcludedColumn(def.table, c, types.get(c)), `${entity}.${c}`).toBe(false);
        expect(c).not.toMatch(/password|secret|token|_enc$|recovery_codes/);
        expect(EXPORT_EXCLUDED_COLUMNS as readonly string[]).not.toContain(c);
      }
    }
    // activity_events.data is a sensitive column (encrypted payload of sensitive events)
    expect(SENSITIVE_COLUMNS.some((s) => s.table === "activity_events" && s.column === "data")).toBe(true);
    expect(ENTITY_EXPORTS.activity_events.columns).not.toContain("data");
  });

  it("the generic exclusion catches every secret column of the schema", () => {
    for (const [table, column, type] of [
      ["users", "password_hash", "text"],
      ["users", "totp_secret_enc", "bytea"],
      ["users", "recovery_codes_enc", "bytea"],
      ["auth_sessions", "session_token", "text"],
      ["auth_accounts", "refresh_token", "text"],
      ["auth_verification_tokens", "token", "text"],
      ["form_import_sources", "token_hash", "text"],
      ["orders", "pay_token_hash", "text"],
      ["vouchers", "code_hash", "text"],
      ["payments", "raw", "jsonb"],
      ["webhook_events", "payload", "jsonb"],
      ["files", "bytes", "bytea"],
      ["person_sensitive_fields", "value_enc", "bytea"],
      ["form_sensitive_answers", "value_enc", "bytea"],
    ] as const) {
      expect(isExcludedColumn(table, column, type), `${table}.${column}`).toBe(true);
    }
    expect(isExcludedColumn("ai_requests", "input_tokens", "integer")).toBe(false);
    expect(isExcludedColumn("persons", "email", "text")).toBe(false);
  });

  it("the full export covers every base table with the same exclusions; persons carries is_processing_restricted", async () => {
    const tables = await fullExportTables(h.db);
    expect(tables.slice(0, EXPORT_ENTITIES.length)).toEqual(EXPORT_ENTITIES.map((e) => ENTITY_EXPORTS[e].table));
    for (const t of ["users", "files", "jobs", "audit_log", "retention_policies", "data_exports"]) expect(tables).toContain(t);
    expect(tables.some((t) => t.startsWith("v_"))).toBe(false);
    const users = await fullTableSource(h.db, "users");
    expect(users.columns).toContain("email");
    for (const c of ["password_hash", "totp_secret_enc", "recovery_codes_enc"]) {
      expect(users.columns).not.toContain(c);
      expect(users.excluded).toContain(c);
    }
    const p = await fullTableSource(h.db, "persons");
    expect(p.columns.at(-1)).toBe("is_processing_restricted");
    expect(p.columns).not.toContain("search_tsv");
  });
});

describe("restricted persons (ops rule 54)", () => {
  it("are left out of entity exports, directly and through their orders, and kept in the full export", async () => {
    const free = await makePerson(h.db);
    const restricted = await makePerson(h.db);
    await h.db.update(persons).set({ processingRestrictedAt: new Date() }).where(eq(persons.id, restricted.id));
    const freeOrder = await makeOrder(h.db, { personId: free.id });
    const restrictedOrder = await makeOrder(h.db, { personId: restricted.id });
    await makeOrderLine(h.db, { orderId: freeOrder.id });
    await makeOrderLine(h.db, { orderId: restrictedOrder.id });

    const ids = async (source: Awaited<ReturnType<typeof fullTableSource>>, column = "id") => {
      const at = source.columns.indexOf(column);
      return (await readChunk(h.db, source, null, 5000)).rows.map((r) => String(r[at]));
    };
    const personIds = await ids(entitySource("persons"));
    expect(personIds).toContain(free.id);
    expect(personIds).not.toContain(restricted.id);
    const orderIds = await ids(entitySource("orders"));
    expect(orderIds).toContain(freeOrder.id);
    expect(orderIds).not.toContain(restrictedOrder.id);
    const lineOrders = await ids(entitySource("order_lines"), "order_id");
    expect(lineOrders).toContain(freeOrder.id);
    expect(lineOrders).not.toContain(restrictedOrder.id);

    const full = await fullTableSource(h.db, "persons");
    const { rows } = await readChunk(h.db, full, null, 5000);
    const flag = full.columns.indexOf("is_processing_restricted");
    const byId = new Map(rows.map((r) => [String(r[0]), r[flag]]));
    expect(byId.get(restricted.id)).toBe(true);
    expect(byId.get(free.id)).toBe(false);
  });

  it("applies the date filters in Europe/Brussels days", async () => {
    const p = await makePerson(h.db, { createdAt: new Date("2026-03-10T23:30:00Z") }); // 11 March in Brussels
    const ids = async (from: string, to: string) => (await readChunk(h.db, entitySource("persons", { from, to }), null, 5000)).rows.map((r) => String(r[0]));
    expect(await ids("2026-03-11", "2026-03-11")).toContain(p.id);
    expect(await ids("2026-03-10", "2026-03-10")).not.toContain(p.id);
  });
});
