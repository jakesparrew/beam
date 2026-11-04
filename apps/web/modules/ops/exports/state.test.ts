import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, DbHandle, Tx } from "@beam/db";
import { dataExports } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";
import { eq, flushDurableWrites } from "@/lib/ctx";
import type { JobKind } from "@/lib/ctx";
import { makeJobCtx, resetRuntime, runJobTwice } from "@/lib/testing";
import { EXPORT_MAX_ATTEMPTS, runExportChunk, runExportFinalise } from "./jobs";
import { exportOf, seedExport } from "./ops-p6.fixtures";
import { getExportForDownload } from "./queries";
import { sweepDataExports } from "./sweep";

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

const DAY = 86_400_000;
const status = async (id: string) => (await exportOf(h.db, id)).status;

/** A job context whose inserts fail with a retryable error (the chunk's `storeFile` call). */
function failingCtx(kind: JobKind, attempt: number) {
  const broken = new Proxy(h.db as Db, {
    get(target, prop) {
      if (prop === "insert")
        return () => {
          throw new Error("connection reset");
        };
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return makeJobCtx(h.db, kind, { attempt, tx: broken as unknown as Tx });
}

describe("data_exports states (ops spec 2.2, rules 55-57)", () => {
  it("queued → running → done → expired by the sweep; only a done, unexpired export downloads", async () => {
    const id = await seedExport(h.db, { userId, entity: "tags" });
    expect(await status(id)).toBe("queued");
    expect(await getExportForDownload(h.db, id)).toBeNull();

    await runJobTwice(h.db, "ops.export_chunk", { exportId: id, entity: "tags", offset: 0 });
    expect(await status(id)).toBe("running");
    expect(await getExportForDownload(h.db, id)).toBeNull();

    await runJobTwice(h.db, "ops.export_finalise", { exportId: id });
    expect(await status(id)).toBe("done");
    const ready = await getExportForDownload(h.db, id);
    expect(ready?.parts.map((p) => p.name)).toEqual(["tags-1.csv"]);

    // eight days later: past expires_at, the ops.data_exports sweep marks it expired
    await h.db.update(dataExports).set({ expiresAt: new Date(Date.now() - DAY) }).where(eq(dataExports.id, id));
    expect(await getExportForDownload(h.db, id)).toBeNull();
    await sweepDataExports(h.db as unknown as Tx, new Date(Date.now() - 30 * DAY));
    expect(await status(id)).toBe("expired");
    expect(await getExportForDownload(h.db, id)).toBeNull();

    // a late chunk or finalise job changes nothing on a final export
    await runJobTwice(h.db, "ops.export_finalise", { exportId: id });
    expect(await status(id)).toBe("expired");

    // after 30 days the record itself is deleted
    await h.db.update(dataExports).set({ createdAt: new Date(Date.now() - 31 * DAY) }).where(eq(dataExports.id, id));
    await sweepDataExports(h.db as unknown as Tx, new Date(Date.now() - 30 * DAY));
    expect(await h.db.select({ id: dataExports.id }).from(dataExports).where(eq(dataExports.id, id))).toEqual([]);
  });

  it("queued → failed only on the chunk's last attempt", async () => {
    const id = await seedExport(h.db, { userId, entity: "tags" });
    const early = failingCtx("ops.export_chunk", EXPORT_MAX_ATTEMPTS - 1);
    await expect(runExportChunk(early, { exportId: id, entity: "tags", offset: 0 })).rejects.toThrow("connection reset");
    await flushDurableWrites(h.db, early);
    expect(await status(id)).toBe("queued");

    const last = failingCtx("ops.export_chunk", EXPORT_MAX_ATTEMPTS);
    await expect(runExportChunk(last, { exportId: id, entity: "tags", offset: 0 })).rejects.toThrow("connection reset");
    await flushDurableWrites(h.db, last);
    expect(await status(id)).toBe("failed");
    expect(await getExportForDownload(h.db, id)).toBeNull();
  });

  it("running → failed when the finalise job fails on its last attempt; a failed export never downloads", async () => {
    const id = await seedExport(h.db, { userId });
    await h.db.update(dataExports).set({ status: "running" }).where(eq(dataExports.id, id));
    const last = failingCtx("ops.export_finalise", EXPORT_MAX_ATTEMPTS);
    await expect(runExportFinalise(last, { exportId: id })).rejects.toThrow("connection reset");
    await flushDurableWrites(h.db, last);
    expect(await status(id)).toBe("failed");
    await runJobTwice(h.db, "ops.export_finalise", { exportId: id });
    expect(await status(id)).toBe("failed");
    expect(await getExportForDownload(h.db, id)).toBeNull();
  });
});
