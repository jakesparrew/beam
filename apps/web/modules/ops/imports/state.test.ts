import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { importRows, imports } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.10" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./actions");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { drain, identityMapping, importOf, rowsOf, seedImport, signInStaff, storeCsv } = await import("./ops-p4.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  await signInStaff(h.db, jar, ["persons.write", "settings.write"]);
});

let n = 0;
const CSV = () => `name,city\nAcme ${++n} BV,Gent\nBeta ${n} NV,Brugge\n`;
const mapping = () => identityMapping(["name", "city"]);
const conflict = (message: string) => ({ ok: false, error: { code: "conflict", message } });

async function uploaded() {
  return seedImport(h.db, { kind: "companies", csv: CSV(), mapping: mapping() });
}
async function dryRunDone() {
  const id = await uploaded();
  expect(await actions.startDryRun({ importId: id })).toMatchObject({ ok: true });
  await drain(h.db);
  return id;
}

describe("import states (ops rule 43a)", () => {
  it("R43a uploaded → dry_run: run_seq + 1, every row processed in dry mode, finished_at set by finalise", async () => {
    const id = await uploaded();
    const res = await actions.startDryRun({ importId: id });
    expect(res).toMatchObject({ ok: true, data: { jobId: expect.any(String) } });
    expect(await importOf(h.db, id)).toMatchObject({ status: "dry_run", runSeq: 1, isDryRun: true, finishedAt: null });
    await drain(h.db);
    const imp = await importOf(h.db, id);
    expect(imp).toMatchObject({ status: "dry_run", rowCount: 2, counts: { imported: 2 } });
    expect(imp.finishedAt).toBeInstanceOf(Date);
    expect(imp.report).toMatchObject({ mapping_hash: expect.stringMatching(/^[0-9a-f]{64}$/), dry_run: { total: 2 } });
  });

  it("R43a dry_run → dry_run after a mapping change; the real run needs a dry run of the same mapping hash", async () => {
    const id = await dryRunDone();
    const changed = { ...mapping(), columns: { name: "name", city: null } };
    expect(await actions.saveImportMapping({ importId: id, mapping: changed })).toMatchObject({ ok: true, data: { ok: true, missingTargets: [] } });
    expect(await actions.startImport({ importId: id })).toMatchObject(conflict("dry_run_first"));
    expect(await actions.startDryRun({ importId: id })).toMatchObject({ ok: true });
    expect((await importOf(h.db, id)).runSeq).toBe(2);
    await drain(h.db);
    expect(await actions.startImport({ importId: id })).toMatchObject({ ok: true });
  });

  it("R43a dry_run → running → done; done is final (no run, dry run or cancel)", async () => {
    const id = await dryRunDone();
    expect(await actions.startImport({ importId: id })).toMatchObject({ ok: true });
    expect(await importOf(h.db, id)).toMatchObject({ status: "running", runSeq: 2, isDryRun: false });
    await drain(h.db);
    expect(await importOf(h.db, id)).toMatchObject({ status: "done", counts: { imported: 2 } });
    expect(await actions.startImport({ importId: id })).toMatchObject(conflict("import_not_runnable"));
    expect(await actions.startDryRun({ importId: id })).toMatchObject(conflict("dry_run_not_allowed"));
    expect(await actions.cancelImport({ importId: id })).toMatchObject(conflict("import_final"));
  });

  it("R43a refuses a run without a dry run", async () => {
    const id = await uploaded();
    expect(await actions.startImport({ importId: id })).toMatchObject(conflict("dry_run_first"));
    expect((await importOf(h.db, id)).status).toBe("uploaded");
  });

  it("R43a uploaded, dry_run and running → cancelled; cancelled is final and a running chunk exits; the report says partial", async () => {
    const a = await uploaded();
    expect(await actions.cancelImport({ importId: a })).toMatchObject({ ok: true });
    expect(await importOf(h.db, a)).toMatchObject({ status: "cancelled" });
    const b = await dryRunDone();
    expect(await actions.cancelImport({ importId: b })).toMatchObject({ ok: true });
    const c = await dryRunDone();
    expect(await actions.startImport({ importId: c })).toMatchObject({ ok: true });
    expect(await actions.cancelImport({ importId: c })).toMatchObject({ ok: true });
    await drain(h.db);
    const imp = await importOf(h.db, c);
    expect(imp).toMatchObject({ status: "cancelled", report: { partial: true } });
    expect((await rowsOf(h.db, c)).every((r) => r.status === "pending")).toBe(true);
    expect(await actions.startImport({ importId: c })).toMatchObject(conflict("import_not_runnable"));
    expect(await actions.startDryRun({ importId: c })).toMatchObject(conflict("dry_run_not_allowed"));
  });

  it("R43a failed → running resumes with run_seq + 1 and processes only pending rows", async () => {
    const id = await dryRunDone();
    expect(await actions.startImport({ importId: id })).toMatchObject({ ok: true });
    // Simulate a run that failed after row 1 was imported.
    await h.db.update(importRows).set({ status: "imported", message: "kept" }).where(and(eq(importRows.importId, id), eq(importRows.rowNumber, 1)));
    await h.db.update(imports).set({ status: "failed", report: { failed_phase: "run", error: "chunk_failed" } }).where(eq(imports.id, id));
    const before = (await importOf(h.db, id)).runSeq;
    expect(await actions.startImport({ importId: id })).toMatchObject({ ok: true });
    expect((await importOf(h.db, id)).runSeq).toBe(before + 1);
    await drain(h.db);
    const rows = await rowsOf(h.db, id);
    expect(rows.map((r) => [r.status, r.message])).toEqual([
      ["imported", "kept"],
      ["imported", "new"],
    ]);
    expect((await importOf(h.db, id)).status).toBe("done");
  });

  it("R43a a parse failure is final: uploaded → dry_run → failed, then neither a dry run nor a run", async () => {
    const fileIds = await storeCsv(h.db, new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x0a]));
    const userId = (await signInStaff(h.db, jar, ["persons.write", "settings.write"])).id;
    const [row] = await h.db.insert(imports).values({ kind: "companies", source: "spreadsheet", name: "Latin-1 file", fileId: fileIds[0]!, header: ["name"], mapping: identityMapping(["name"]), createdByUserId: userId }).returning();
    expect(await actions.startDryRun({ importId: row!.id })).toMatchObject({ ok: true });
    await drain(h.db);
    expect(await importOf(h.db, row!.id)).toMatchObject({ status: "failed", report: { error: "not_utf8", failed_phase: "parse" } });
    expect(await actions.startDryRun({ importId: row!.id })).toMatchObject(conflict("dry_run_not_allowed"));
    expect(await actions.startImport({ importId: row!.id })).toMatchObject(conflict("import_not_runnable"));
  });

  it("edge case 29: a second concurrent startImport gets conflict another_running", async () => {
    const a = await dryRunDone();
    const b = await dryRunDone();
    expect(await actions.startImport({ importId: a })).toMatchObject({ ok: true });
    expect(await actions.startImport({ importId: b })).toMatchObject(conflict("another_running"));
    expect((await importOf(h.db, b)).status).toBe("dry_run");
    await drain(h.db);
  });

  it("R44a in production a real run is refused while the go-live gate is incomplete; dry runs are not", async () => {
    const id = await dryRunDone();
    const previous = process.env.APP_ENV;
    process.env.APP_ENV = "production";
    try {
      expect(await actions.startImport({ importId: id })).toMatchObject(conflict("go_live_gate"));
      expect(await actions.startDryRun({ importId: id })).toMatchObject({ ok: true });
    } finally {
      if (previous === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = previous;
    }
    expect((await importOf(h.db, id)).status).toBe("dry_run");
    await drain(h.db);
    expect(await actions.startImport({ importId: id })).toMatchObject({ ok: true });
    await drain(h.db);
  });
});
