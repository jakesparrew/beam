import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPEND_ONLY_SQL_PATH,
  appendOnlySql,
  main,
} from "../scripts/append-only-sql";
import type { DbHandle } from "../src/client";
import { APPEND_ONLY_TABLES } from "../src/schema/_shared";
import { auditLog } from "../src/schema/platform";
import { applyCustomSql, createTestDb } from "../src/testing";

const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  await applyCustomSql(h);
});
afterAll(() => h.close());

async function insertAudit() {
  const [row] = await h.db
    .insert(auditLog)
    .values({
      actor: { kind: "system", id: null },
      action: "settings.update",
      entityType: "setting",
    })
    .returning();
  return row!;
}

/** Redefines `beam_protect_append_only()` from a generated text (one statement of it). */
async function defineProtect(text: string): Promise<void> {
  const start = text.indexOf("create or replace function beam_protect_append_only()");
  const end = text.indexOf("$$;", start) + 3;
  expect(start).toBeGreaterThanOrEqual(0);
  await h.db.execute(sql.raw(text.slice(start, end)));
}

async function sqlState(
  promise: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (
      (error as { cause?: { code?: string } }).cause?.code ??
      (error as { code?: string }).code
    );
  }
  return undefined;
}

describe("append-only triggers", () => {
  it("protects every listed table that exists", async () => {
    const triggers = rowsOf<{ tgname: string }>(
      await h.db.execute(
        sql`select tgname from pg_trigger where tgname like '%\\_append\\_only' order by tgname`,
      ),
    ).map((r) => r.tgname);
    const existing = rowsOf<{ table_name: string }>(
      await h.db.execute(
        sql`select table_name from information_schema.tables where table_schema = 'public'`,
      ),
    ).map((r) => r.table_name);
    const expected = APPEND_ONLY_TABLES.filter((t) => existing.includes(t)).map(
      (t) => `${t}_append_only`,
    );
    expect(expected.length).toBeGreaterThanOrEqual(10);
    expect(triggers).toEqual(expected);
  });

  it("rejects update and delete on audit_log", async () => {
    const row = await insertAudit();
    expect(
      await sqlState(
        h.db.execute(
          sql`update audit_log set action = 'settings.changed' where id = ${row.id}`,
        ),
      ),
    ).toBe("55000");
    expect(
      await sqlState(
        h.db.execute(sql`delete from audit_log where id = ${row.id}`),
      ),
    ).toBe("55000");
    expect(await sqlState(h.db.execute(sql`truncate audit_log`))).toBe("55000");
  });

  it("allows update and delete inside a transaction with beam.allow_rewrite = 'on'", async () => {
    const row = await insertAudit();
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
      await tx.execute(
        sql`update audit_log set is_redacted = true where id = ${row.id}`,
      );
      await tx.execute(sql`delete from audit_log where id = ${row.id}`);
    });
    const left = rowsOf(
      await h.db.execute(sql`select id from audit_log where id = ${row.id}`),
    );
    expect(left).toHaveLength(0);
    // The setting is local: the next statement outside the transaction is protected again.
    const other = await insertAudit();
    expect(
      await sqlState(
        h.db.execute(sql`delete from audit_log where id = ${other.id}`),
      ),
    ).toBe("55000");
  });

  it("protects a listed table created later on the next call, and a third call adds nothing", async () => {
    // A name no package creates, injected into the list for this test only, so the case does
    // not depend on which listed tables exist yet.
    const later = "fixture_append_only_later";
    await defineProtect(appendOnlySql([...APPEND_ONLY_TABLES, later]));
    try {
      await h.db.execute(
        sql.raw(`create table ${later} (id uuid primary key default gen_random_uuid(), note text)`),
      );
      const second = rowsOf<{ added: number }>(
        await h.db.execute(sql`select beam_protect_append_only() as added`),
      );
      expect(second[0]?.added).toBe(1);
      const third = rowsOf<{ added: number }>(
        await h.db.execute(sql`select beam_protect_append_only() as added`),
      );
      expect(third[0]?.added).toBe(0);
      await h.db.execute(sql.raw(`insert into ${later} (note) values ('muted')`));
      expect(
        await sqlState(h.db.execute(sql.raw(`update ${later} set note = 'x'`))),
      ).toBe("55000");
    } finally {
      // Back to the committed list (and function) for the other cases.
      await applyCustomSql(h, { files: ["0002_append_only.sql"] });
    }
  });

  it("re-applying the custom SQL is idempotent", async () => {
    await expect(
      applyCustomSql(h, { files: ["0002_append_only.sql"] }),
    ).resolves.toEqual(["0002_append_only.sql"]);
  });
});

describe("append-only-sql.ts", () => {
  it("lists all 24 tables of APPEND_ONLY_TABLES", () => {
    const text = appendOnlySql();
    expect(APPEND_ONLY_TABLES).toHaveLength(24);
    for (const t of APPEND_ONLY_TABLES) expect(text).toContain(`'${t}'`);
    expect([...APPEND_ONLY_TABLES].sort()).toEqual([...APPEND_ONLY_TABLES]);
  });

  it("the committed file matches the generator, and --check passes", () => {
    expect(readFileSync(APPEND_ONLY_SQL_PATH, "utf8")).toBe(appendOnlySql());
    expect(main(["--check"])).toBe(0);
  });

  it("--check fails after a fixture change of the list", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "platform-p2-append-only-"));
    const out = path.join(dir, "0002_append_only.sql");
    expect(main(["--out", out])).toBe(0);
    expect(main(["--check", "--out", out])).toBe(0);
    expect(
      main(["--check", "--out", out], [...APPEND_ONLY_TABLES, "fixture_facts"]),
    ).toBe(1);
    writeFileSync(out, `${readFileSync(out, "utf8")}-- edited by hand\n`);
    expect(main(["--check", "--out", out])).toBe(1);
  });
});
