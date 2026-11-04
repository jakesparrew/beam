import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, files, jobs } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { like } from "drizzle-orm";
import { and, eq, inArray, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { makeJobCtx, resetRuntime, runJobTwice } from "@/lib/testing";
import { runExportChunk } from "./jobs";
import { bulkPersons, csvRows, drainExports, exportOf, partText, seedExport } from "./ops-p6.fixtures";

let h: DbHandle;
let userId: string;
beforeAll(async () => {
  h = await createTestDb();
  userId = (await makeUser(h.db, { roleKey: "technical_admin" })).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const audits = (exportId: string) =>
  h.db.select({ action: auditLog.action, newValue: auditLog.newValue }).from(auditLog).where(and(eq(auditLog.entityId, exportId), eq(auditLog.action, "data.exported")));

/** Export state without the timestamp that moves on every write. */
async function snapshot(exportId: string) {
  const { updatedAt: _u, ...row } = await exportOf(h.db, exportId);
  const fileCount = row.partFileIds.length ? (await h.db.select({ id: files.id }).from(files).where(inArray(files.id, row.partFileIds))).length : 0;
  return { row, fileCount };
}

describe("export jobs (ops rules 55 and 57, 4.4)", () => {
  it("R55 12,000 persons give 3 parts of at most 5,000 rows, keyed per chunk, and one data.exported audit with the row count", async () => {
    await bulkPersons(h.db, "chunked", 12_000);
    const [total] = rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from persons where processing_restricted_at is null`));
    expect(total!.n).toBe(12_000);
    const id = await seedExport(h.db, { userId, entity: "persons" });
    await drainExports(h.db);

    const exp = await exportOf(h.db, id);
    expect(exp.status).toBe("done");
    expect(exp.rowCount).toBe(12_000);
    expect(exp.partFileIds).toHaveLength(3);
    expect(exp.cursorData.parts.map((p) => [p.name, p.rows])).toEqual([
      ["persons-1.csv", 5000],
      ["persons-2.csv", 5000],
      ["persons-3.csv", 2000],
    ]);
    expect(exp.expiresAt!.getTime() - exp.completedAt!.getTime()).toBe(7 * 86_400_000);
    const keys = await h.db.select({ key: jobs.idempotencyKey, status: jobs.status }).from(jobs).where(like(jobs.idempotencyKey, `export:${id}:%`)).orderBy(jobs.createdAt);
    expect(keys).toEqual([
      { key: `export:${id}:persons:chunk:0`, status: "succeeded" },
      { key: `export:${id}:persons:chunk:1`, status: "succeeded" },
      { key: `export:${id}:persons:chunk:2`, status: "succeeded" },
      { key: `export:${id}:finalise`, status: "succeeded" },
    ]);
    const first = csvRows(await partText(h.db, exp.partFileIds[0]!));
    expect(first[0]![0]).toBe("id");
    expect(first).toHaveLength(5001);
    const [file] = await h.db.select({ kind: files.kind, expiresAt: files.expiresAt }).from(files).where(eq(files.id, exp.partFileIds[2]!));
    expect(file!.kind).toBe("export");
    expect(file!.expiresAt).not.toBeNull();

    const rows = await audits(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.newValue).toMatchObject({ kind: "entity", entity: "persons", rows: 12_000 });
  }, 240_000);

  it("each job run twice gives the same state; the audit row is written once", async () => {
    await makePerson(h.db, { email: "twice@example.com" });
    const id = await seedExport(h.db, { userId, entity: "tags", filters: {} });
    const states: unknown[] = [];
    const between = async () => void states.push(await snapshot(id));

    await runJobTwice(h.db, "ops.export_chunk", { exportId: id, entity: "tags", offset: 0 }, { between });
    expect(await snapshot(id)).toEqual(states.pop());
    expect((await exportOf(h.db, id)).status).toBe("running");
    expect((await exportOf(h.db, id)).partFileIds).toHaveLength(1);

    await runJobTwice(h.db, "ops.export_finalise", { exportId: id }, { between });
    expect(await snapshot(id)).toEqual(states.pop());
    expect((await exportOf(h.db, id)).status).toBe("done");
    expect(await audits(id)).toHaveLength(1);
  });

  it("a chunk for another entity than the export's is a permanent failure that marks the export failed", async () => {
    const id = await seedExport(h.db, { userId, entity: "tags" });
    const ctx = makeJobCtx(h.db, "ops.export_chunk", { attempt: 1 });
    await expect(runExportChunk(ctx, { exportId: id, entity: "persons", offset: 0 })).rejects.toThrow(/export_entity_mismatch/);
    expect((await exportOf(h.db, id)).status).toBe("failed");
  });
});
