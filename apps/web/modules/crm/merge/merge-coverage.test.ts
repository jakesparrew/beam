/**
 * crm edge case 15 and rule 3.31 on the full schema (PGlite with every migration): every foreign
 * key to `persons.id` that sits in a unique key including the person column has an explicit
 * entry in `MERGE_STRATEGIES`, and every table an owner hook or platform handles is `skip`, so
 * the generic repoint never touches it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { APPEND_ONLY_TABLES } from "@beam/db";
import { MERGE_STRATEGIES, mergeStrategyFor } from "@beam/core/crm";
import { HOOK_HANDLED_COLUMNS, listPersonForeignKeys, listUniqueKeys, MERGE_STRATEGY_ADDITIONS, strategyOf } from "./execute";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

const explicit = (table: string, column: string) =>
  [MERGE_STRATEGIES, MERGE_STRATEGY_ADDITIONS].some((map) => `${table}.${column}` in map || `${table}.*` in map);

describe("merge coverage (edge case 15)", () => {
  it("discovers the foreign keys to persons.id from information_schema", async () => {
    const fks = await listPersonForeignKeys(h.db);
    const keys = fks.map((f) => `${f.table}.${f.column}`);
    expect(keys).toEqual(expect.arrayContaining(["person_tags.person_id", "consent_records.person_id", "users.person_id", "tasks.person_id", "persons.merged_into_person_id"]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every FK column inside a unique key that includes it has an explicit strategy", async () => {
    const missing: string[] = [];
    for (const fk of await listPersonForeignKeys(h.db)) {
      if (APPEND_ONLY_TABLES.includes(fk.table as (typeof APPEND_ONLY_TABLES)[number])) continue;
      const keys = (await listUniqueKeys(h.db, fk.table)).filter((k) => k.columns.includes(fk.column));
      if (keys.length && !explicit(fk.table, fk.column)) missing.push(`${fk.table}.${fk.column} (${keys.map((k) => k.name).join(", ")})`);
    }
    expect(missing).toEqual([]);
  });

  it("every table an owner hook or platform handles is skip, and append-only tables are never rewritten", async () => {
    for (const col of HOOK_HANDLED_COLUMNS) {
      const [table, column] = col.split(".") as [string, string];
      expect(mergeStrategyFor(table, column === "*" ? "person_id" : column), col).toBe("skip");
    }
    for (const fk of await listPersonForeignKeys(h.db)) {
      if (APPEND_ONLY_TABLES.includes(fk.table as (typeof APPEND_ONLY_TABLES)[number])) expect(strategyOf(fk), `${fk.table}.${fk.column}`).toBe("skip");
    }
    expect(strategyOf({ table: "webinar_registrations", column: "person_id" })).toBe("skip");
    expect(strategyOf({ table: "credit_grants", column: "person_id" })).toBe("skip");
    expect(strategyOf({ table: "memberships", column: "person_id" })).toBe("skip");
  });

  it("strategies name only real columns or whole tables", async () => {
    const fks = new Set((await listPersonForeignKeys(h.db)).map((f) => `${f.table}.${f.column}`));
    const tables = new Set([...fks].map((k) => k.split(".")[0]));
    for (const key of [...Object.keys(MERGE_STRATEGIES), ...Object.keys(MERGE_STRATEGY_ADDITIONS)]) {
      const [table, column] = key.split(".") as [string, string];
      // R2/R3 tables (webinar, referrals) may not exist yet; an existing table must have the column.
      if (column !== "*" && tables.has(table)) expect(fks.has(key), key).toBe(true);
    }
  });
});
