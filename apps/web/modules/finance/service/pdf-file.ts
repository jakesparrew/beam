/**
 * Whether a document's stored PDF still exists, and which documents have a blocked PDF, read
 * without `files.bytes` (a rendered PDF is tens of kB; the bytes are only read to serve it).
 * A file counts as missing when its row is gone or its `expires_at` has passed, as `readFile`
 * treats it.
 */
import type { DbOrTx } from "@beam/db";
import { files, invoices } from "@beam/db/schema";
import { and, asc, eq, isNull, or, sql } from "@/lib/ctx";

/** True when the file row exists and has not expired. */
export async function pdfFileExists(db: DbOrTx, fileId: string | null | undefined): Promise<boolean> {
  if (!fileId || !/^[0-9a-f-]{36}$/i.test(fileId)) return false;
  const [row] = await db.select({ id: files.id, expiresAt: files.expiresAt }).from(files).where(eq(files.id, fileId)).limit(1);
  return !!row && (!row.expiresAt || row.expiresAt.getTime() > Date.now());
}

/** At most this many documents per "Re-render all blocked PDFs" click. */
export const BLOCKED_PDF_BATCH = 500;

/**
 * Ids of the documents whose PDF is blocked (oldest first): `pdf_status = 'failed'`, or
 * `rendered` without a live file, never a document anonymised by the retention sweep.
 */
export async function blockedPdfIds(db: DbOrTx, limit: number = BLOCKED_PDF_BATCH): Promise<string[]> {
  const rows = await db
    .select({ id: invoices.id })
    .from(invoices)
    .leftJoin(files, and(eq(files.id, invoices.pdfFileId), or(isNull(files.expiresAt), sql`${files.expiresAt} > now()`)))
    .where(
      and(
        sql`not (${invoices.customerSnapshot} ? 'anonymised')`,
        or(eq(invoices.pdfStatus, "failed"), and(eq(invoices.pdfStatus, "rendered"), isNull(files.id))),
      ),
    )
    .orderBy(asc(invoices.issuedAt), asc(invoices.id))
    .limit(limit);
  return rows.map((r) => r.id);
}
