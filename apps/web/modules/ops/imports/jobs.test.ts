import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { companies, importRows, imports, jobs } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { like } from "drizzle-orm";
import { and, enqueueJob, eq, flushDurableWrites, sql } from "@/lib/ctx";
import { createFakeIntegrations, makeJobCtx, resetRuntime, runJobTwice } from "@/lib/testing";
import type { JobCtx } from "@/lib/job-runner";
import type { RowApplier } from "./apply";
import { APPLIERS, runImportProcessChunk } from "./jobs";
import { drain, dryRun, identityMapping, importOf, realRun, rowsOf, seedImport } from "./ops-p4.fixtures";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

let n = 0;
const companiesCsv = (count: number) => `name,city\n${Array.from({ length: count }, (_, i) => `Jobs ${++n}-${i} BV,Gent`).join("\n")}\n`;
const mapping = () => identityMapping(["name", "city"]);

async function jobsOf(importId: string) {
  return h.db.select({ kind: jobs.kind, key: jobs.idempotencyKey, status: jobs.status }).from(jobs).where(like(jobs.idempotencyKey, `import:${importId}:%`)).orderBy(jobs.createdAt);
}

/** State of an import without timestamps that move on every write. */
async function snapshot(importId: string) {
  const { updatedAt: _u, ...imp } = await importOf(h.db, importId);
  const rows = (await rowsOf(h.db, importId)).map(({ updatedAt: _r, createdAt: _c, ...r }) => r);
  return { imp, rows };
}

describe("import jobs (ops rule 51, 4.4)", () => {
  it("R51 1,250 rows run as 3 chunks of 500 and one finalise, keyed with run_seq", async () => {
    const id = await seedImport(h.db, { kind: "companies", csv: companiesCsv(1250), mapping: mapping() });
    await dryRun(h.db, id);
    const keys = (await jobsOf(id)).map((j) => [j.key, j.status]);
    expect(keys).toEqual([
      [`import:${id}:1:parse`, "succeeded"],
      [`import:${id}:1:dry:chunk:0`, "succeeded"],
      [`import:${id}:1:dry:chunk:1`, "succeeded"],
      [`import:${id}:1:dry:chunk:2`, "succeeded"],
      [`import:${id}:1:dry:finalise`, "succeeded"],
    ]);
    expect(await importOf(h.db, id)).toMatchObject({ rowCount: 1250, counts: { imported: 1250 } });
  }, 120_000);

  it("R51 each job run twice yields the same state", async () => {
    const id = await seedImport(h.db, { kind: "companies", csv: companiesCsv(3), mapping: mapping() });
    await h.db.update(imports).set({ status: "dry_run", runSeq: 1 }).where(eq(imports.id, id));
    const fakes = createFakeIntegrations();
    const states: unknown[] = [];
    const between = async () => void states.push(await snapshot(id));

    await runJobTwice(h.db, "import.parse", { importId: id, runSeq: 1 }, { integrations: fakes, between });
    expect(await snapshot(id)).toEqual(states.pop());
    await runJobTwice(h.db, "import.process_chunk", { importId: id, runSeq: 1, mode: "dry", offset: 0 }, { integrations: fakes, between });
    expect(await snapshot(id)).toEqual(states.pop());
    await runJobTwice(h.db, "import.finalise", { importId: id, runSeq: 1, mode: "dry" }, { integrations: fakes, between });
    expect(await snapshot(id)).toEqual(states.pop());

    await h.db.update(imports).set({ status: "running", runSeq: 2, isDryRun: false }).where(eq(imports.id, id));
    await runJobTwice(h.db, "import.process_chunk", { importId: id, runSeq: 2, mode: "run", offset: 0 }, { integrations: fakes, between });
    expect(await snapshot(id)).toEqual(states.pop());
    expect(await h.db.select().from(companies).where(like(companies.name, `Jobs ${n - 2}-%`))).toHaveLength(1);
    await runJobTwice(h.db, "import.finalise", { importId: id, runSeq: 2, mode: "run" }, { integrations: fakes, between });
    expect(await snapshot(id)).toEqual(states.pop());
    expect((await importOf(h.db, id)).status).toBe("done");
  });

  it("R51 a crash in the middle of a chunk commits nothing; a row error never aborts the chunk", async () => {
    const id = await seedImport(h.db, { kind: "companies", csv: companiesCsv(4), mapping: mapping() });
    await dryRun(h.db, id);
    await h.db.update(imports).set({ status: "running", runSeq: 2, isDryRun: false }).where(eq(imports.id, id));
    const original = APPLIERS.companies;
    const mutable = APPLIERS as Record<string, RowApplier>;
    let calls = 0;
    mutable.companies = async (tx, ctx, row, opts) => {
      calls += 1;
      if (row.rowNumber === 3) throw new Error("process killed");
      return original(tx, ctx, row, opts);
    };
    const before = await h.db.select({ c: sql<number>`count(*)::int` }).from(companies);
    try {
      let ctx: JobCtx | undefined;
      await expect(
        h.db.transaction(async (tx) => {
          ctx = makeJobCtx(h.db, "import.process_chunk", { tx: tx, attempt: 1 });
          await runImportProcessChunk(ctx, { importId: id, runSeq: 2, mode: "run", offset: 0 });
        }),
      ).rejects.toThrow("process killed");
      await flushDurableWrites(h.db, ctx!);
      expect(calls).toBe(3);
      expect((await rowsOf(h.db, id)).map((r) => r.status)).toEqual(["pending", "pending", "pending", "pending"]);
      expect(await h.db.select({ c: sql<number>`count(*)::int` }).from(companies)).toEqual(before);
      expect((await importOf(h.db, id)).status).toBe("running");

      // A row-level error is recorded and the chunk goes on.
      mutable.companies = async (tx, ctx2, row, opts) => (row.rowNumber === 2 ? Promise.reject(Object.assign(new Error("bad"), { name: "ValidationError", retryable: false })) : original(tx, ctx2, row, opts));
      await enqueueJob(h.db, { kind: "import.process_chunk", payload: { importId: id, runSeq: 2, mode: "run", offset: 0 }, key: `import:${id}:2:run:chunk:0` });
      await drain(h.db);
      expect((await rowsOf(h.db, id)).map((r) => [r.status, r.message])).toEqual([
        ["imported", "new"],
        ["error", "bad"],
        ["imported", "new"],
        ["imported", "new"],
      ]);
    } finally {
      mutable.companies = original;
    }
  });

  it("R51 a second dry run after a mapping change gets new job keys through run_seq and is not swallowed", async () => {
    const id = await seedImport(h.db, { kind: "companies", csv: companiesCsv(2), mapping: mapping() });
    await dryRun(h.db, id);
    expect((await rowsOf(h.db, id)).every((r) => r.data.city === "Gent")).toBe(true);
    await h.db.update(imports).set({ mapping: { ...mapping(), columns: { name: "name", city: null } } }).where(eq(imports.id, id));
    await dryRun(h.db, id);
    const keys = (await jobsOf(id)).map((j) => j.key);
    expect(keys).toContain(`import:${id}:2:parse`);
    expect(keys).toContain(`import:${id}:2:dry:finalise`);
    expect((await jobsOf(id)).every((j) => j.status === "succeeded")).toBe(true);
    expect((await rowsOf(h.db, id)).every((r) => r.data.city === undefined)).toBe(true);
    expect((await importOf(h.db, id)).runSeq).toBe(2);
  });

  it("R43a the last failed chunk attempt sets the import failed with report.error; earlier attempts do not", async () => {
    const id = await seedImport(h.db, { kind: "companies", csv: companiesCsv(2), mapping: mapping() });
    await dryRun(h.db, id);
    await h.db.update(imports).set({ status: "running", runSeq: 2, isDryRun: false }).where(eq(imports.id, id));
    const original = APPLIERS.companies;
    const mutable = APPLIERS as Record<string, RowApplier>;
    mutable.companies = () => Promise.reject(new Error("database went away"));
    try {
      for (const attempt of [1, 6]) {
        let ctx: JobCtx | undefined;
        await expect(
          h.db.transaction(async (tx) => {
            ctx = makeJobCtx(h.db, "import.process_chunk", { tx: tx, attempt });
            await runImportProcessChunk(ctx, { importId: id, runSeq: 2, mode: "run", offset: 0 });
          }),
        ).rejects.toThrow("database went away");
        await flushDurableWrites(h.db, ctx!);
        expect((await importOf(h.db, id)).status).toBe(attempt === 1 ? "running" : "failed");
      }
      expect((await importOf(h.db, id)).report).toMatchObject({ error: "chunk_failed", failed_phase: "run" });
    } finally {
      mutable.companies = original;
    }
    // A resumed run picks up the pending rows.
    await realRun(h.db, id);
    expect(await h.db.select({ s: importRows.status }).from(importRows).where(and(eq(importRows.importId, id), eq(importRows.status, "imported")))).toHaveLength(2);
  });
});
