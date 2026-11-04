/**
 * Test helpers of the export and retention suites (ops-P6): an export row with its first chunk
 * enqueued, a driver that runs the export job chain through the job runner, a reader of the
 * store-only zip the download route streams, and bulk persons for the chunking test.
 */
import type { Db, DbOrTx } from "@beam/db";
import { dataExports, files, jobs } from "@beam/db/schema";
import type { ExportEntity } from "@beam/core/ops";
import { and, enqueueJob, eq, inArray, sql } from "@/lib/ctx";
import { runJobs } from "@/lib/job-runner";
import { createFakeIntegrations } from "@/lib/testing";
import { fullExportTables, type ExportFilters } from "./entities";
import { chunkKey, emptyCursor, type ExportCursor } from "./jobs";

const EXPORT_KINDS = ["ops.export_chunk", "ops.export_finalise"];

/** A queued export of `userId` with its first chunk job, as `createExport` makes it. */
export async function seedExport(db: Db, input: { userId: string; entity?: ExportEntity; filters?: ExportFilters }): Promise<string> {
  const tables = input.entity ? undefined : await fullExportTables(db);
  const [row] = await db
    .insert(dataExports)
    .values({
      kind: input.entity ? "entity" : "full",
      entity: input.entity ?? null,
      filters: input.filters ?? {},
      createdByUserId: input.userId,
      cursor: emptyCursor(tables),
    })
    .returning({ id: dataExports.id });
  const first = input.entity ?? tables![0]!;
  await enqueueJob(db, { kind: "ops.export_chunk", payload: { exportId: row!.id, entity: first, offset: 0 }, key: chunkKey(row!.id, first, 0) });
  return row!.id;
}

/** Runs pending export jobs until none is due. */
export async function drainExports(db: Db): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await runJobs({ db, budgetMs: 60_000, lanes: ["bulk"], integrations: createFakeIntegrations() });
    const pending = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), inArray(jobs.kind, EXPORT_KINDS as never[]), sql`${jobs.runAt} <= now()`))
      .limit(1);
    if (!pending.length) return;
  }
}

export async function exportOf(db: DbOrTx, exportId: string) {
  const [row] = await db.select().from(dataExports).where(eq(dataExports.id, exportId));
  return { ...row!, cursorData: row!.cursor as unknown as ExportCursor };
}

/** The text of one part file. */
export async function partText(db: DbOrTx, fileId: string): Promise<string> {
  const [f] = await db.select({ bytes: files.bytes }).from(files).where(eq(files.id, fileId));
  return new TextDecoder().decode(f!.bytes).replace(/^﻿/, "");
}

/** CSV text to rows (simple: no quoted line breaks in the test data). */
export const csvRows = (text: string) =>
  text
    .split("\r\n")
    .filter(Boolean)
    .map((l) => l.split(","));

/** Entries of a store-only zip, read from its central directory. */
export function unzip(bytes: Uint8Array): { name: string; text: string }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error("no end of central directory");
  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out: { name: string; text: string }[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < entries; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("bad central header");
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    const localData = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    out.push({ name, text: dec.decode(bytes.subarray(localData, localData + size)) });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** `count` persons with emails `<prefix>-<n>@example.com` in one statement (volume fixture). */
export async function bulkPersons(db: DbOrTx, prefix: string, count: number): Promise<void> {
  await db.execute(sql`insert into persons (email, first_name, last_name, locale, is_tester, acquisition)
    select ${prefix} || '-' || g || '@example.com', 'Bulk', ${prefix} || ' ' || g, 'nl-BE', true, '{"source":"manual"}'::jsonb
    from generate_series(1, ${count}) g`);
}
