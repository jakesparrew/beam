/**
 * fix-w20-finance-wiring (request of finance-P9): `requestFinanceExport` accepts every accountant
 * kind, including the three Release 3 kinds (`deferred_revenue`, `breakage`,
 * `voucher_redemptions`), so the exports form and the deferred revenue page share one action
 * (`finance.export.request`). Each R3 request writes the export row, the `finance.build_export`
 * job and the audit row; the job builds the file once on a double run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { FINANCE_EXPORT_KINDS, EXPORT_COLUMNS } from "@beam/core/finance";
import { files, financeExports, jobs } from "@beam/db/schema";
import { eq, setAppDb } from "@/lib/ctx";
import { resetRuntime, runJobTwice } from "@/lib/testing";
import { auditRows, signInStaff } from "../finance-p5.helpers";
import { setupDb } from "./__tests__/fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.45" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("../actions");

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

const R3_KINDS = ["deferred_revenue", "breakage", "voucher_redemptions"] as const;
const PERIOD = { from: "2026-09-01", to: "2026-09-30" };
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

const ok = <T>(r: { ok: boolean; data?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`action failed: ${JSON.stringify(r.error)}`);
  return r.data as T;
};

describe("requestFinanceExport accepts the Release 3 kinds", () => {
  it("lists them among the accountant kinds", () => {
    for (const kind of R3_KINDS) expect(FINANCE_EXPORT_KINDS).toContain(kind);
  });

  it.each(R3_KINDS)("%s: export row, job, audit row, and one file after a double run", async (kind) => {
    const user = await signInStaff(jar, h.db, "finance");
    const { exportId } = ok(await actions.requestFinanceExport({ kind, ...PERIOD }));

    const [row] = await h.db.select().from(financeExports).where(eq(financeExports.id, exportId));
    expect(row).toMatchObject({ kind, periodFrom: PERIOD.from, periodTo: PERIOD.to, status: "queued", requestedByUserId: user.id });
    const queued = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `finance_export:${exportId}`));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "finance.build_export" });
    const audit = await auditRows(h.db, "finance.export_requested", exportId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityType: "finance_export", newValue: { kind, ...PERIOD } });

    await runJobTwice(h.db, "finance.build_export", { exportId });
    const [done] = await h.db.select().from(financeExports).where(eq(financeExports.id, exportId));
    expect(done).toMatchObject({ status: "done" });
    const stored = await h.db.select().from(files).where(eq(files.id, done!.fileId!));
    expect(stored).toHaveLength(1);
    const header = decoder.decode(stored[0]!.bytes).replace(/^﻿/, "").split("\r\n")[0]!.split(";");
    expect(header).toEqual(EXPORT_COLUMNS[kind]);
  });

  it("refuses a kind outside the catalogue and an over-long R3 period", async () => {
    const unknown = await actions.requestFinanceExport({ kind: "ledger" as never, ...PERIOD });
    expect(unknown).toMatchObject({ ok: false, error: { code: "validation" } });
    const tooLong = await actions.requestFinanceExport({ kind: "breakage", from: "2026-01-01", to: "2027-01-02" });
    expect(JSON.stringify(tooLong)).toContain("finance.errors.period_too_long");
  });
});
