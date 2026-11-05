/**
 * commerce-P9 Lightspeed import (rule 53, edge case 24): the upload stores the file, creates the
 * import, enqueues its first chunk and audits `lightspeed.uploaded`; the job imports 1,000 rows
 * per run and continues itself; a re-upload of the same lines adds nothing; broken rows are
 * listed and the rest imports; both jobs pass the double-run test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { like } from "drizzle-orm";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle, Tx } from "@beam/db";
import { auditLog, files, jobs, lightspeedImports, lightspeedSales, vLightspeedDaily } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const { uploadLightspeedCsvRecord, importLightspeedChunk, importPendingLightspeed, getLightspeedDaily, listLightspeedImports, decodeCsv, LIGHTSPEED_CHUNK } = await import("./lightspeed");
const { createCtx, eq, and } = await import("@/lib/ctx");
const { makeCtx, makeJobCtx, resetRuntime, runJobTwice, createFakeIntegrations, staffActor } = await import("@/lib/testing");

let h: DbHandle;
let staffUserId: string;

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const HEADER = "Bonnummer;Lijn;Datum;Product;Categorie;Aantal;Totaal incl. btw;Btw %;Betaalmethode";

/** `count` lines on receipts with the given prefix, day `04/11/2026`, three lines per receipt. */
function csvOf(prefix: string, count: number, extra: string[] = []): string {
  const lines = [HEADER];
  for (let i = 0; i < count; i++) {
    const receipt = `${prefix}-${Math.floor(i / 3) + 1}`;
    lines.push(`${receipt};${(i % 3) + 1};04/11/2026 12:${String(i % 60).padStart(2, "0")};Koffie;Warme dranken;1;3,50;21;Bancontact`);
  }
  return [...lines, ...extra].join("\r\n");
}

function formWith(csv: string, name = "export.csv", type = "text/csv"): FormData {
  const form = new FormData();
  form.set("file", new File([csv], name, { type }));
  return form;
}

function asStaff<T>(fn: (ctx: ReturnType<typeof createCtx>) => Promise<T>, permissions: string[] = ["commerce.sell"]): Promise<T> {
  return h.db.transaction((tx: Tx) => fn(createCtx({ tx, actor: staffActor({ userId: staffUserId, permissions }), durableMode: "immediate" })));
}

async function upload(csv: string) {
  return asStaff((ctx) => uploadLightspeedCsvRecord(ctx, formWith(csv)));
}

/** Runs every queued chunk of `importId` in key order until none is left. */
async function drain(importId: string): Promise<number> {
  let runs = 0;
  for (;;) {
    const queued = await h.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, "commerce.import_lightspeed"), like(jobs.idempotencyKey, `lightspeed:${importId}:%`), eq(jobs.status, "pending")));
    if (!queued.length) return runs;
    for (const job of queued) {
      await h.db.transaction(async (tx) => {
        await importLightspeedChunk(makeJobCtx(h.db, "commerce.import_lightspeed", { tx }), job.payload as { importId: string; offset: number });
      });
      await h.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.id, job.id));
      runs++;
    }
  }
}

const importRow = async (id: string) => (await h.db.select().from(lightspeedImports).where(eq(lightspeedImports.id, id)))[0]!;

describe("uploadLightspeedCsv", () => {
  it("stores the file, creates the import, enqueues offset 0 and audits the upload", async () => {
    const { importId } = await upload(csvOf("UP", 3));
    const imp = await importRow(importId);
    expect(imp).toMatchObject({ status: "uploaded", createdByUserId: staffUserId, rowsTotal: 0 });
    const [file] = await h.db.select().from(files).where(eq(files.id, imp.fileId));
    expect(file).toMatchObject({ kind: "import", name: "export.csv", mime: "text/csv" });
    const queued = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `lightspeed:${importId}:0`));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "commerce.import_lightspeed", payload: { importId, offset: 0 } });
    const audit = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "lightspeed.uploaded"), eq(auditLog.entityId, importId)));
    expect(audit).toHaveLength(1);
  });

  it("refuses a missing file, a file above 5 MB and a file that is not CSV", async () => {
    await expect(asStaff((ctx) => uploadLightspeedCsvRecord(ctx, new FormData()))).rejects.toMatchObject({ code: "validation", fields: { file: "required" } });
    const big = "x".repeat(5 * 1024 * 1024 + 1);
    await expect(asStaff((ctx) => uploadLightspeedCsvRecord(ctx, formWith(big)))).rejects.toMatchObject({ fields: { file: "too_large" } });
    await expect(asStaff((ctx) => uploadLightspeedCsvRecord(ctx, formWith("a;b", "export.pdf", "application/pdf")))).rejects.toMatchObject({ fields: { file: "type_not_allowed" } });
  });

  it("decodes Windows-1252 exports", () => {
    expect(decodeCsv(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe("Café");
    expect(decodeCsv(new TextEncoder().encode("Café"))).toBe("Café");
  });
});

describe("commerce.import_lightspeed", () => {
  it("imports 1,000 rows per run and continues itself until done", async () => {
    const count = LIGHTSPEED_CHUNK * 2 + 500;
    const { importId } = await upload(csvOf("CH", count));
    const first = await h.db.transaction((tx) => importLightspeedChunk(makeJobCtx(h.db, "commerce.import_lightspeed", { tx }), { importId, offset: 0 }));
    expect(first).toEqual({ status: "running", inserted: LIGHTSPEED_CHUNK, nextOffset: LIGHTSPEED_CHUNK });
    expect(await importRow(importId)).toMatchObject({ status: "running", rowsImported: LIGHTSPEED_CHUNK, rowsTotal: count });
    expect(await h.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.idempotencyKey, `lightspeed:${importId}:${LIGHTSPEED_CHUNK}`))).toHaveLength(1);

    await h.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.idempotencyKey, `lightspeed:${importId}:0`));
    expect(await drain(importId)).toBe(2);
    expect(await importRow(importId)).toMatchObject({
      status: "done",
      rowsTotal: count,
      rowsImported: count,
      rowsSkipped: 0,
      errors: [],
      businessFromOn: "2026-11-04",
      businessToOn: "2026-11-04",
    });
    const stored = await h.db.select({ id: lightspeedSales.id }).from(lightspeedSales).where(eq(lightspeedSales.importId, importId));
    expect(stored).toHaveLength(count);
  });

  it("adds nothing when the same lines are uploaded again", async () => {
    const csv = csvOf("RE", 6);
    const a = await upload(csv);
    await drain(a.importId);
    expect(await importRow(a.importId)).toMatchObject({ status: "done", rowsImported: 6, rowsSkipped: 0 });

    const b = await upload(csv);
    await drain(b.importId);
    expect(await importRow(b.importId)).toMatchObject({ status: "done", rowsTotal: 6, rowsImported: 0, rowsSkipped: 6 });
    const lines = await h.db.select().from(lightspeedSales).where(like(lightspeedSales.externalLineKey, "RE-%"));
    expect(lines).toHaveLength(6);
    expect(new Set(lines.map((l) => l.importId))).toEqual(new Set([a.importId]));
  });

  it("lists broken rows with their row numbers and imports the rest", async () => {
    const csv = csvOf("BR", 2, ["BR-9;1;31/02/2026 10:00;Koffie;Warme dranken;1;3,50;21;Cash", "BR-9;2;04/11/2026 10:00;Koffie;Warme dranken;1;drie;21;Cash"]);
    const { importId } = await upload(csv);
    await drain(importId);
    expect(await importRow(importId)).toMatchObject({
      status: "done",
      rowsTotal: 4,
      rowsImported: 2,
      rowsSkipped: 2,
      errors: [
        { row: 4, code: "date_invalid", column: "date" },
        { row: 5, code: "total_invalid", column: "total" },
      ],
    });
  });

  it("fails an import whose header lacks a required column", async () => {
    const { importId } = await upload("Product;Totaal\nKoffie;3,50");
    await drain(importId);
    const imp = await importRow(importId);
    expect(imp.status).toBe("failed");
    expect(imp.errors.map((e) => e.code)).toContain("missing_column");
    expect(await h.db.select().from(lightspeedSales).where(eq(lightspeedSales.importId, importId))).toHaveLength(0);
  });

  it("runs twice with the same result (double-run test)", async () => {
    const { importId } = await upload(csvOf("DR", 5));
    const { first, second } = await runJobTwice(h.db, "commerce.import_lightspeed", { importId, offset: 0 });
    expect(first).toEqual({ status: "done", inserted: 5, nextOffset: null });
    expect(second).toEqual({ status: "skipped", inserted: 0, nextOffset: null });
    expect(await importRow(importId)).toMatchObject({ status: "done", rowsImported: 5, rowsSkipped: 0 });
    expect(await h.db.select().from(lightspeedSales).where(eq(lightspeedSales.importId, importId))).toHaveLength(5);
  });

  it("a replayed middle chunk changes no counter", async () => {
    const count = LIGHTSPEED_CHUNK + 10;
    const { importId } = await upload(csvOf("RP", count));
    const run = (offset: number) => h.db.transaction((tx) => importLightspeedChunk(makeJobCtx(h.db, "commerce.import_lightspeed", { tx }), { importId, offset }));
    await run(0);
    await run(0);
    expect(await importRow(importId)).toMatchObject({ status: "running", rowsImported: LIGHTSPEED_CHUNK });
    await run(LIGHTSPEED_CHUNK);
    expect(await importRow(importId)).toMatchObject({ status: "done", rowsImported: count, rowsSkipped: 0 });
  });
});

describe("commerce.import_lightspeed_pending", () => {
  it("enqueues every import still uploaded once, also on a second run", async () => {
    const { importId } = await upload(csvOf("PE", 2));
    await h.db.delete(jobs).where(eq(jobs.idempotencyKey, `lightspeed:${importId}:0`));
    const { first, second } = await runJobTwice(h.db, "commerce.import_lightspeed_pending", {});
    expect((first as { enqueued: number }).enqueued).toBeGreaterThanOrEqual(1);
    expect(second).toEqual({ enqueued: 0 });
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `lightspeed:${importId}:0`))).toHaveLength(1);
    const direct = await h.db.transaction((tx) => importPendingLightspeed(makeJobCtx(h.db, "commerce.import_lightspeed_pending", { tx })));
    expect(direct).toEqual({ enqueued: 0 });
  });
});

describe("reads", () => {
  it("lists imports newest first and sums the daily figures per category", async () => {
    const { importId } = await upload(csvOf("RD", 3).replace(/04\/11\/2026/g, "01/10/2026"));
    await drain(importId);
    const list = await listLightspeedImports(h.db);
    expect(list[0]).toMatchObject({ id: importId, fileName: "export.csv", status: "done", rowsImported: 3 });
    const daily = await getLightspeedDaily(h.db, { from: "2026-10-01", to: "2026-10-01" });
    expect(daily).toEqual([{ businessDayOn: "2026-10-01", category: "Warme dranken", totalCents: 1050, vatCents: 183, receipts: 1, lines: 3 }]);
    const view = await h.db.select().from(vLightspeedDaily).where(eq(vLightspeedDaily.businessDayOn, "2026-10-01"));
    expect(view).toHaveLength(1);
  });
});

describe("retention (commerce.lightspeed_sales, 3653 days)", () => {
  it("deletes till lines whose fiscal year ended more than ten years before the cutoff", async () => {
    const { sweep } = await import("../privacy");
    const old = await upload(csvOf("OLD", 1).replace(/04\/11\/2026/g, "01/05/2015"));
    await drain(old.importId);
    const recent = await upload(csvOf("NEW", 1).replace(/04\/11\/2026/g, "01/05/2016"));
    await drain(recent.importId);
    const cutoff = new Date("2026-11-05T00:00:00Z");
    cutoff.setUTCDate(cutoff.getUTCDate() - 3653);
    const deleted = await h.db.transaction((tx) => sweep["commerce.lightspeed_sales"]!(tx, cutoff));
    expect(deleted).toBe(1);
    expect(await h.db.select().from(lightspeedSales).where(eq(lightspeedSales.importId, old.importId))).toHaveLength(0);
    expect(await h.db.select().from(lightspeedSales).where(eq(lightspeedSales.importId, recent.importId))).toHaveLength(1);
  });
});
