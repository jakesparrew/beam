/**
 * fix-w09-finance-review finding 4: "Re-render all blocked PDFs" picks only the blocked
 * documents (failed, or rendered without a live file) with one query that reads no bytes, and
 * queues one render per blocked document; rendered documents with files are left alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { files, invoices } from "@beam/db/schema";
import { eq, setAppDb, sql } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { asTx, invoiceRow, setupDb } from "./service/__tests__/fixtures";
import { paidB2c } from "./finance-p4.helpers";
import { jobsWithKeyPrefix, killJob, signInStaff } from "./finance-p5.helpers";
import { updateInvoiceState } from "./service/invoice-state";
import { blockedPdfIds, pdfFileExists } from "./service/pdf-file";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.44" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./actions");

let h: DbHandle;
beforeAll(async () => {
  h = await setupDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  await signInStaff(jar, h.db, "finance");
});

const ok = <T>(r: { ok: boolean; data?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`action failed: ${JSON.stringify(r.error)}`);
  return r.data as T;
};

describe("rerenderInvoicePdf({ allBlocked: true })", () => {
  it("with 3 rendered documents that have files and 1 failed document queues exactly one job", async () => {
    const rendered = [await paidB2c(h.db, undefined, new Date()), await paidB2c(h.db, undefined, new Date()), await paidB2c(h.db, undefined, new Date())];
    const failed = await paidB2c(h.db, undefined, new Date());
    await updateInvoiceState(asTx(h.db), failed.invoiceId, { pdfStatus: "failed" });
    await killJob(h.db, `invoice_pdf:${failed.invoiceId}`);

    expect(await blockedPdfIds(h.db)).toEqual([failed.invoiceId]);
    const out = ok(await actions.rerenderInvoicePdf({ allBlocked: true }));
    expect(out.jobIds).toHaveLength(1);
    expect((await jobsWithKeyPrefix(h.db, `invoice_pdf:${failed.invoiceId}:r`)).map((j) => j.idempotencyKey)).toEqual([`invoice_pdf:${failed.invoiceId}:r1`]);
    for (const doc of rendered) expect(await jobsWithKeyPrefix(h.db, `invoice_pdf:${doc.invoiceId}:r`)).toHaveLength(0);
    // Leave the failed one rendered again so the next test starts from zero blocked documents.
    await updateInvoiceState(asTx(h.db), failed.invoiceId, { pdfStatus: "rendered" });
  });

  it("takes a rendered document whose file expired, and checks files without their bytes", async () => {
    const expired = await paidB2c(h.db, undefined, new Date());
    const live = await paidB2c(h.db, undefined, new Date());
    const expiredFileId = (await invoiceRow(h.db, expired.invoiceId)).pdfFileId!;
    await h.db.update(files).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(files.id, expiredFileId));
    await killJob(h.db, `invoice_pdf:${expired.invoiceId}`);

    expect(await pdfFileExists(h.db, expiredFileId)).toBe(false);
    expect(await pdfFileExists(h.db, (await invoiceRow(h.db, live.invoiceId)).pdfFileId)).toBe(true);
    expect(await pdfFileExists(h.db, null)).toBe(false);
    expect(await blockedPdfIds(h.db)).toEqual([expired.invoiceId]);
    const out = ok(await actions.rerenderInvoicePdf({ allBlocked: true }));
    expect(out.jobIds).toHaveLength(1);
  });

  it("skips documents anonymised by the retention sweep", async () => {
    const doc = await paidB2c(h.db, undefined, new Date());
    await updateInvoiceState(asTx(h.db), doc.invoiceId, { pdfStatus: "failed" });
    expect(await blockedPdfIds(h.db)).toContain(doc.invoiceId);
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
      await tx.update(invoices).set({ customerSnapshot: { anonymised: true } as never }).where(eq(invoices.id, doc.invoiceId));
    });
    expect(await blockedPdfIds(h.db)).not.toContain(doc.invoiceId);
  });
});
