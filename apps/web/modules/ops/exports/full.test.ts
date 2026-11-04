import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { persons } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", async () => (await import("../imports/ops-p4.fixtures")).headersMock(jar));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./actions");
const { eq, sql, setAppDb } = await import("@/lib/ctx");
const { rowsOf } = await import("@/lib/sensitive");
const { resetRuntime } = await import("@/lib/testing");
const { signInStaff } = await import("../imports/ops-p4.fixtures");
const { csvRows, drainExports, exportOf, partText, seedExport } = await import("./ops-p6.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

describe("full data export (ops rule 56)", () => {
  it("has one CSV per table and a README listing every table with row counts and excluded columns; restricted persons are flagged, not left out", async () => {
    const userId = (await makeUser(h.db, { roleKey: "owner" })).id;
    const free = await makePerson(h.db);
    const restricted = await makePerson(h.db);
    await h.db.update(persons).set({ processingRestrictedAt: new Date() }).where(eq(persons.id, restricted.id));

    const id = await seedExport(h.db, { userId });
    await drainExports(h.db);
    const exp = await exportOf(h.db, id);
    expect(exp.status).toBe("done");

    const baseTables = rowsOf<{ t: string }>(await h.db.execute(sql`select table_name as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)).map((r) => r.t);
    const readme = exp.cursorData.parts.find((p) => p.name === "README.csv")!;
    const lines = csvRows(await partText(h.db, readme.fileId));
    expect(lines[0]).toEqual(["table", "row_count", "excluded_columns"]);
    const listed = lines.slice(1).map((l) => l[0]);
    expect([...listed].sort()).toEqual([...baseTables].sort());
    const usersLine = lines.find((l) => l[0] === "users")!;
    expect(usersLine[2]).toContain("password_hash");
    expect(Number(lines.find((l) => l[0] === "persons")![1])).toBe(2);

    for (const t of baseTables) expect(exp.cursorData.parts.some((p) => p.name === `${t}-1.csv`), t).toBe(true);

    const personsCsv = csvRows(await partText(h.db, exp.cursorData.parts.find((p) => p.name === "persons-1.csv")!.fileId));
    const flag = personsCsv[0]!.indexOf("is_processing_restricted");
    expect(flag).toBeGreaterThan(0);
    expect(personsCsv.find((r) => r[0] === restricted.id)![flag]).toBe("true");
    expect(personsCsv.find((r) => r[0] === free.id)![flag]).toBe("false");

    const usersCsv = csvRows(await partText(h.db, exp.cursorData.parts.find((p) => p.name === "users-1.csv")!.fileId));
    for (const c of ["password_hash", "totp_secret_enc", "recovery_codes_enc"]) expect(usersCsv[0]).not.toContain(c);
  }, 300_000);

  it("is refused without users.manage and allowed with persons.export plus users.manage", async () => {
    await signInStaff(h.db, jar, ["persons.export"], "management");
    expect(await actions.createExport({ kind: "full" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await actions.createExport({ kind: "entity", entity: "persons" })).toMatchObject({ ok: true });

    jar.clear();
    await signInStaff(h.db, jar, ["persons.export", "users.manage"], "technical_admin");
    const ok = await actions.createExport({ kind: "full" });
    expect(ok).toMatchObject({ ok: true });
    if (!ok.ok) return;
    const exp = await exportOf(h.db, ok.data.exportId);
    expect(exp).toMatchObject({ kind: "full", entity: null, status: "queued" });
    expect(exp.cursorData.tables?.[0]).toBe("persons");
  });
});
