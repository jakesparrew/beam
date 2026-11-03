/**
 * `pnpm gdpr:coverage` (architecture section 11, platform-P7): every column that references
 * `persons.id` belongs to a table some module registers in its `privacy.ts` (`tables`), or to a
 * table declared in `NO_PII_TABLES`. A new person-referencing table without a registration
 * fails here, so erasure and export can never miss it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { GDPR_REGISTRY, NO_PII_TABLES } from "@/registry/privacy.generated";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  await handle.close();
});

async function columnsReferencingPersons(): Promise<{ table: string; column: string }[]> {
  return rowsOf<{ table: string; column: string }>(
    await handle.db.execute(sql`
      select distinct kcu.table_name as table, kcu.column_name as column
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
        and ccu.table_name = 'persons' and ccu.column_name = 'id'
      order by 1, 2`),
  );
}

describe("gdpr coverage", () => {
  it("finds the person references of the schema", async () => {
    const refs = await columnsReferencingPersons();
    const tables = new Set(refs.map((r) => r.table));
    for (const t of ["users", "activity_events", "bookings", "orders", "credit_grants", "invoices", "email_messages"]) expect(tables).toContain(t);
  });

  it("every column referencing persons.id belongs to a registered or NO_PII table", async () => {
    const registered = new Set<string>(Object.values(GDPR_REGISTRY).flatMap((p) => [...p.tables]));
    const noPii = new Set<string>(NO_PII_TABLES);
    const uncovered = (await columnsReferencingPersons()).filter((r) => !registered.has(r.table) && !noPii.has(r.table)).map((r) => `${r.table}.${r.column}`);
    expect(uncovered).toEqual([]);
  });

  it("no table is both registered as personal data and declared NO_PII", () => {
    const registered = new Set<string>(Object.values(GDPR_REGISTRY).flatMap((p) => [...p.tables]));
    expect(NO_PII_TABLES.filter((t) => registered.has(t))).toEqual([]);
  });
});
